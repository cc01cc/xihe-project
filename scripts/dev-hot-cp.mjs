#!/usr/bin/env node
// dev-hot-cp.mjs — CP 侧 dev 热循环（改保存 → 增量编译进**该栈正在用的 classes 目录** → devtools 自重启）
//
// 为什么需要它（`task-218` 实测，2026-11-08）：
//   - 栈的 CP 是 `mvn spring-boot:run -Dxihe.target.dir=<per-sha dir>` 形态（`stack-run.mjs:129-141`），
//     `spring-boot-devtools` 在运行态 classpath 上、`[restartedMain]` 已生效 ⇒ **classpath 目录里的
//     .class 一变，devtools 就重启**（不需要停栈、不需要重启栈）。
//   - 但每提交新 sha 目录 + `start` 走 freshness 门 ⇒ 平时没人喂它。本脚本补这一段：只负责
//     "把改动增量编译进**正在跑的**那个 classes 目录"，重启交给 devtools。
//   - 编译成本（`task-218` 实测）：冷 compile 9.30 s / 增量 8.32 s（Maven 自启动底噪 8–11 s）。
//
// 默认目标：**stack-2**（本仓把 stack-2 当 dev 栈；stack-1 留作证据栈，见 `task-223` 卡）。
//
// `--javac` 模式（task-229）**只服务 dev 通道**：它只做 `javac 改动文件` +（可选）touch trigger，
// **不等价于 `mvn compile`** —— pom 里的 `<release>`/`-Werror`/其它 compiler 参数并未逐字对齐，
// MapStruct 只通过 `-processorpath` 补了 `mapstruct-processor`。判据是"devtools 能正确重启"，
// 不是"产物与 mvn 逐字相同"。验收/证据面一律走 `mvn`（本脚本保留 `mvn` 模式作为 fallback）。
//
// stack-2 的 dev 长期形态 = **trigger 模式**：用
//   MAVEN_ARGS=-Dspring-boot.run.jvmArguments=-Dspring.devtools.restart.trigger-file=.reloadtrigger
// 启动，并预置 `<classes>/.reloadtrigger`（触发文件必须在 classpath 上、属性值只能是纯文件名）。
// **要回默认轮询**：不带 `MAVEN_ARGS` 重启一次即可
//   node scripts/dev-stack.mjs stop --stack 2 --json ; node scripts/dev-stack.mjs start --stack 2
//
// 用法：
//   node scripts/dev-hot-cp.mjs [--stack N] [--debounce 300] [--once] [--dry-run] [--no-restart-hint]
//   node scripts/dev-hot-cp.mjs --help
//
// 硬边界：不改 `dev-stack.mjs` / `cp-build-dir.mjs` / `mise.toml`；不重启栈；只写**该栈自己的** CP
// target dir（`XIHE_CP_TARGET_DIR` 显式优先，其次 `C:\xihe-build\cp\<stack>\.current` 指针）。
//
// 已知代价（见报告 `task-223` 的坑表）：编译完成后 `build-info.properties` 的 commit 戳**仍是旧
// commit**（本脚本故意不重写它 —— 重写会让 `dev-stack status` 把"手工编译的 classes"误当成
// "从该 commit 正式构建的产物"）。因此热循环期间 `cpBuild.verdict` 会停在 `stale`，
// 这是**预期**，热循环结束/重启栈时由 `stack-run.mjs cp` 按 HEAD 重新构建并重写戳。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync, watch } from 'node:fs';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { cpBuildRoot, readPointer, pointerPath } from './lib/cp-build-dir.mjs';
import { gitHead, readBuildInfo, shortSha } from './lib/cp-build-info.mjs';
import { DEFAULT_STACK_ID, deriveStack } from './lib/stack-ports.mjs';

const projectRoot = dirname(import.meta.dirname);
const HELP = `usage: node scripts/dev-hot-cp.mjs [--stack N] [--debounce 300] [--once] [--dry-run] [--no-restart-hint] [--force] [--i-understand-this-dirties-evidence]

  --stack N         目标栈（默认 2 = 本仓的 dev 栈；stack-1 留作证据栈，需显式 flag 才允许）
  --debounce MS     合并事件的防抖窗口（默认 300；保存风暴时避免连跑 mvn）
  --once            只编译一次就退出（不 watch；给 CI/手工用）
  --dry-run         只打印将要执行的命令与目标目录，不实际编译
  --no-restart-hint 不打印 devtools 日志提示
  --force           目标端口不在听时仍然编译（默认拒绝：没人重启时编译只会把 classes 改脏）
  --javac           单文件增量模式：用 javac 只编改动的 .java（弃 Maven 整模块 8–13 s，实测 0.98 s）
  --classpath-file F  配合 --javac：显式给依赖 classpath 文件（默认从运行中 CP JVM 的 java.class.path 推导）
  --git-range A..B  配合 --once --javac：从该 git 区间发现改动（lane 合并后的改动在 commit 里、
                    工作树是干净的，status 看不到 ⇒ 用区间；删除/非 java 仍回退 mvn）
  --trigger-file P  编译**成功后** touch 该文件（配合 spring.devtools.restart.trigger-file：
                    devtools 只在文件变化时重启 ⇒ 1 次干净重启、不会在编译中途重启）
  --i-understand-this-dirties-evidence
                    允许对 stack-1（证据栈）热编（会把"真栈证据"弄脏）
  --help, -h        打印本帮助

判据：编译后 devtools 应在 CP 日志里打出 'Restarting' / 'Started ...'；本脚本编译结束时自动去
日志尾部找一次并打印（找不到就打印 WARN 与日志路径）。`;

const args = { stack: 2, debounce: 300, once: false, dryRun: false, restartHint: true, force: false, dirtiesEvidence: false, triggerFile: null, javac: false, classpathFile: null, gitRange: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--help' || a === '-h') {
    console.log(HELP);
    process.exit(0);
  } else if (a === '--stack') {
    args.stack = Number(argv[(i += 1)]);
  } else if (a.startsWith('--stack=')) args.stack = Number(a.slice('--stack='.length));
  else if (a === '--debounce') {
    args.debounce = Number(argv[(i += 1)]);
  } else if (a.startsWith('--debounce=')) args.debounce = Number(a.slice('--debounce='.length));
  else if (a === '--once') args.once = true;
  else if (a === '--dry-run') args.dryRun = true;
  else if (a === '--no-restart-hint') args.restartHint = false;
  else if (a === '--force') args.force = true;
  else if (a === '--i-understand-this-dirties-evidence') args.dirtiesEvidence = true;
  else if (a === '--trigger-file') args.triggerFile = argv[(i += 1)];
  else if (a === '--javac') args.javac = true;
  else if (a === '--classpath-file') args.classpathFile = argv[(i += 1)];
  else if (a === '--git-range') args.gitRange = argv[(i += 1)];
  else if (a.startsWith('--git-range=')) args.gitRange = a.slice('--git-range='.length);
  else {
    console.error(`unknown flag: ${a}\n\n${HELP}`);
    process.exit(2);
  }
}
if (!Number.isInteger(args.stack) || args.stack < 1 || args.stack > 8) {
  console.error(`--stack must be 1..8 (got ${args.stack})`);
  process.exit(2);
}

const stackId = args.stack === DEFAULT_STACK_ID ? 'stack-1' : `stack-${args.stack}`;
// 与 dev-stack 同一派生实现：端口/日志目录都不自己算。
let derived;
try {
  derived = deriveStack(stackId);
} catch (error) {
  console.error(`FAILED to derive stack ${stackId}: ${error.message}`);
  process.exit(2);
}
const logPath = join(projectRoot, derived.logDir, 'cp.out.log');
const errLogPath = join(projectRoot, derived.logDir, 'cp.err.log');

// 目标目录：显式 XIHE_CP_TARGET_DIR > 该栈的 .current 指针（launcher 写的"上次 start 用的目录"）。
function resolveTargetDir() {
  const explicit = (process.env.XIHE_CP_TARGET_DIR ?? '').trim();
  if (explicit) {
    // 证据栈守卫（任务 task-228）：显式 env 会绕过下面的 --stack 1 守卫 ⇒ 这里按"路径是否落在
    // 证据栈 stack-1 的构建根"再判一次。片段从 cp-build-dir 的推导取（不写死盘符/路径）。
    const evidenceRoot = dirname(pointerPath({ root: cpBuildRoot({ env: process.env }), stackId: DEFAULT_STACK_ID }));
    const norm = (p) => resolve(p).replace(/\\/g, '/').toLowerCase();
    if (norm(explicit).startsWith(`${norm(evidenceRoot)}/`) && !args.dirtiesEvidence) {
      console.error(
        '[hot-cp] 拒绝（E_EVIDENCE_TARGET）：XIHE_CP_TARGET_DIR 指向证据栈 stack-1 的构建根'
        + `（${evidenceRoot}）。\n`
        + '  热编会让它的 classes 与 build-info 戳不符 ⇒ 证据面被弄脏。\n'
        + '  确实要热编证据栈：再加 --i-understand-this-dirties-evidence；dev 循环请指向 stack-2 的根。',
      );
      process.exit(2);
    }
    return { targetDir: explicit, source: 'XIHE_CP_TARGET_DIR' };
  }
  const root = cpBuildRoot({ env: process.env });
  const pointer = readPointer({ root, stackId });
  if (pointer?.targetDir) return { targetDir: pointer.targetDir, source: `pointer ${pointerPath({ root, stackId })}` };
  return { targetDir: null, source: 'unresolved' };
}

const { targetDir, source } = resolveTargetDir();
if (!targetDir) {
  console.error(
    `[hot-cp] 找不到 ${stackId} 的 CP target dir（${source}）。\n`
    + `  先把栈起起来（launcher 会写 .current），或用 XIHE_CP_TARGET_DIR 显式指定。`,
  );
  process.exit(2);
}

// ① 证据栈守卫：stack-1 是本仓的**证据栈**（真栈/L2 证据从它取）。热编会让它的 classes 与
// build-info 戳不符 ⇒ 证据面被弄脏。只允许 stack-2 当 dev 栈；stack-1 要显式声明"我知道这脏证据"。
if (args.stack === 1 && !args.dirtiesEvidence) {
  console.error(
    '[hot-cp] 拒绝：stack-1 是本仓的证据栈（cpBuild 结论要拿它作真栈证据）。\n'
    + '  热编会让它的 classes 与 build-info 戳不符 ⇒ 证据面被弄脏。\n'
    + '  确实要热编证据栈：加 --i-understand-this-dirties-evidence；dev 循环请用 --stack 2。',
  );
  process.exit(2);
}

const head = gitHead({ cwd: projectRoot });
const { file: infoFile, info } = readBuildInfo(targetDir);
console.log(`[hot-cp] stack=${stackId} cwd=${projectRoot}`);
console.log(`[hot-cp] target dir: ${targetDir}  (source=${source})`);
console.log(`[hot-cp] build-info: ${info ? `${infoFile} commit=${shortSha(info.commit) ?? '(none)'} built=${info.builtAt ?? '(none)'} dirty=${info.dirty ?? '?'}` : `${infoFile} (无戳)`}`);
console.log(`[hot-cp] HEAD: ${shortSha(head.commit) ?? '(unknown)'} dirty=${head.dirty}`);
if (!info || !head.commit || !shortSha(info.commit).startsWith(shortSha(head.commit))) {
  console.warn(
    `[hot-cp] WARN: 目标目录的 commit 戳与 HEAD 不一致（${shortSha(info?.commit) ?? '(none)'} vs ${shortSha(head.commit) ?? '(unknown)'}）`
    + ' —— 你正在把一个「旧提交构建出来的目录」热编成「HEAD 的内容」；热循环期间 cpBuild.verdict 会停在 stale，这是预期。',
  );
}
if (!head.commit) console.warn('[hot-cp] WARN: 拿不到 git HEAD（不是 git 仓库？）—— 增量编译仍可跑，但提交对账失效。');

const mvnArgs = ['-o', '-q', '-DskipTests', 'compile', `-Dxihe.target.dir=${targetDir}`];
const watchRoot = join(projectRoot, 'packages', 'control-plane', 'src', 'main');
let running = false;
let pending = false;
let timer = null;
let builds = 0;

function tailForRestart(sinceMs) {
  if (!args.restartHint) return;
  try {
    const text = readFileSync(logPath, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => /Restarting|Started .* in |LiveReload|Restart complete/.test(l));
    const last = lines.slice(-3);
    console.log(`[hot-cp] CP 日志尾部的重启标记（${logPath}）：`);
    if (last.length === 0) console.warn('[hot-cp] WARN: 没找到 Restarting/Started 行 —— devtools 可能没被触发（见报告坑②）');
    else for (const l of last) console.log(`  ${l}`);
    if (sinceMs) console.log(`[hot-cp] （编译结束 ${Date.now() - sinceMs} ms 后读取；devtools 的轮询窗口约 1 s）`);
  } catch (error) {
    console.warn(`[hot-cp] WARN: 读不到 CP 日志 ${logPath}: ${error.message}`);
  }
}

// ---- --javac 单文件增量（task-229）----------------------------------------
// 为什么：`mvn compile` 即使只改一个文件也要整模块重编（实测 8.79–16.40 s，Maven 底噪占 8–11 s），
// 而 devtools 只看 classes 目录 —— 直接用 javac 编改动文件即可：实测单文件 **0.98 s**，
// devtools 侧看到的是 `Restarting due to 1 class path change (… modifications …)`，
// 而不是"1243 deletions"式的整树重写。
const pendingChanges = new Set(); // 绝对路径；只收 .java（单文件 javac 的输入）
const pendingNonJava = new Set(); // 绝对路径；非 .java（资源/配置）变更 ⇒ 必须回退 mvn（javac 不处理资源）
const pendingDeleted = new Set(); // 仓库相对路径；删除（含 rename 旧路径）⇒ javac 不处理，回退 mvn（task-256 --git-range）


// Spring Boot 4.0 文档（devtools）：trigger file **必须在 classpath 上**，属性值是**纯文件名**（不含路径）。
// ⇒ 传 .reloadtrigger 这类裸名时，落到 <targetDir>/classes/.reloadtrigger；传绝对路径会 warn（上次失败原因）。
function resolveTriggerPath() {
  if (!args.triggerFile) return null;
  const bare = !args.triggerFile.includes('/') && !args.triggerFile.includes('\\\\');
  if (bare) return join(targetDir, 'classes', args.triggerFile);
  console.warn(
    '[hot-cp] WARN: --trigger-file 给了路径（' + args.triggerFile + '）；devtools 要求**触发文件在 classpath 上且属性值是纯文件名**，'
    + '绝对路径不会被监听（task-229 实测 0 次重启即此因）。请改传 .reloadtrigger 这类裸名。',
  );
  return args.triggerFile;
}
const triggerPath = resolveTriggerPath();
let depsClasspath = null;

function resolveDepsClasspath() {
  if (depsClasspath !== null) return depsClasspath;
  if (args.classpathFile) {
    depsClasspath = readFileSync(args.classpathFile, 'utf8').trim();
    console.log(`[hot-cp] deps classpath: ${args.classpathFile} (${depsClasspath.split(';').length} 条)`);
    return depsClasspath;
  }
  // 从**运行中 CP JVM** 的 java.class.path 推导：免 `mvn dependency:build-classpath`
  // （该插件离线不可用：实测 PluginResolutionException）。第 1 条是 classes 目录，其余是依赖。
  const list = spawnSync('jcmd', ['-l'], { windowsHide: true, encoding: 'utf8' });
  const line = (list.stdout ?? '').split(/\r?\n/).find((l) => l.includes('com.cc01cc.p.xihe.cp.CpApplication'));
  if (!line) return null;
  const pid = line.trim().split(/\s+/)[0];
  const props = spawnSync('jcmd', [pid, 'VM.system_properties'], { windowsHide: true, encoding: 'utf8' });
  const raw = (props.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('java.class.path='));
  if (!raw) return null;
  // jcmd 输出的属性值会转义 `:` 与 `\`（`C\:\\path`）⇒ 先把 `\:`/`\\` 归一成 `:`/`\`，再按 `;` 切分。
  // 不归一化的话 javac 会拿到 `C\:` 直接报非法路径（task-229 实测 exit=1 的原因）。
  const entries = raw.slice('java.class.path='.length).replace(/\\([:\\])/g, '$1').split(';');
  depsClasspath = entries.slice(1).join(';');
  console.log(`[hot-cp] deps classpath: 从运行中 CP JVM(pid ${pid}) 推导，${entries.length - 1} 条依赖`);
  return depsClasspath;
}

function resolveProcessorPath() {
  // MapStruct annotationProcessorPaths（pom.xml:295-304）——取本机 m2 里最新的 mapstruct-processor jar
  const dir = join(homedir(), '.m2', 'repository', 'org', 'mapstruct', 'mapstruct-processor');
  try {
    const versions = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    if (versions.length === 0) return null;
    const version = versions.sort().at(-1);
    const jar = join(dir, version, `mapstruct-processor-${version}.jar`);
    return existsSync(jar) ? jar : null;
  } catch {
    return null;
  }
}

function buildJavacOnce(files) {
  const startedAt = Date.now();
  const deps = resolveDepsClasspath();
  if (!deps) {
    console.warn('[hot-cp] WARN: 拿不到依赖 classpath（jcmd 读不到运行中 CP / 未给 --classpath-file）⇒ 回退 mvn');
    return null; // 交给 mvn 路径
  }
  const classesDir = join(targetDir, 'classes');
  const processor = resolveProcessorPath();
  const javacArgs = ['-d', classesDir, '-cp', `${classesDir};${deps}`, '-proc:full'];
  if (processor) javacArgs.push('-processorpath', processor);
  else console.warn('[hot-cp] WARN: 未找到 mapstruct-processor jar ⇒ 不加 -processorpath（MapStruct 生成类可能失败）');
  javacArgs.push(...files);
  console.log(`[hot-cp] javac: ${files.length} 个文件 → ${classesDir}`);
  const result = spawnSync('javac', javacArgs, { windowsHide: true, stdio: 'inherit' });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  if (result.status !== 0) {
    const why = result.error ? `error=${result.error.message}` : `exit=${result.status ?? 'null'}`;
    // 失败**不触发重启**（旧 classes 仍是可用版本）；下一次保存会重试
    console.error(`[hot-cp] JAVAC FAILED (${why}) after ${elapsed}s —— 不 touch trigger、不动运行中的 CP`);
    return false;
  }
  builds += 1;
  console.log(`[hot-cp] JAVAC OK (#${builds}) in ${elapsed}s  (finishedAt=${new Date().toISOString()})`);
  if (args.triggerFile) {
    try {
      mkdirSync(dirname(triggerPath), { recursive: true });
      writeFileSync(triggerPath, `${new Date().toISOString()} javac#${builds}\n`);
      console.log(`[hot-cp] trigger touched: ${triggerPath}`);
    } catch (error) {
      console.error(`[hot-cp] WARN: 无法写 trigger 文件 ${triggerPath}: ${error.message}`);
    }
  } else {
    console.log('[hot-cp] 未配置 --trigger-file：保持 devtools 默认轮询（重启会落在编译中途，见 task-226）');
  }
  tailForRestart(startedAt);
  return true;
}

function buildOnce() {
  // --javac：只编改动文件；新增/删除/非 .java 变更一律回退 mvn（避免"找不到符号/缺生成类"）
  if (args.javac && pendingChanges.size === 0 && args.once) {
    const cpMainPrefix = 'packages/control-plane/src/main/';
    const discover = (rel, status) => {
      if (status === 'D') {
        pendingDeleted.add(rel);
        return;
      }
      if (rel.endsWith('.java')) pendingChanges.add(join(projectRoot, rel));
      else pendingNonJava.add(join(projectRoot, rel));
    };
    if (args.gitRange) {
      // task-256：lane 同步后改动已在 merge commit 里、工作树是干净的 ⇒ status 看不到任何改动，
      // 只会静默退回 mvn（整模块）。从区间发现才能吃到 javac 单文件 1.9–2.4 s 的收益。
      const diff = spawnSync('git', ['-C', projectRoot, 'diff', '--name-status', '-z', args.gitRange], { windowsHide: true, encoding: 'utf8' });
      if (diff.status !== 0) {
        console.error(`[hot-cp] WARN: git diff --name-status ${args.gitRange} 失败（exit ${diff.status}）⇒ 回退 mvn`);
      } else {
        const parts = (diff.stdout ?? '').split('\u0000');
        for (let i = 0; i < parts.length; ) {
          const token = parts[i];
          if (!token) { i += 1; continue; }
          if ((token[0] === 'R' || token[0] === 'C') && parts[i + 1] !== undefined && parts[i + 2] !== undefined) {
            if (parts[i + 1].startsWith(cpMainPrefix)) discover(parts[i + 1], 'D');
            if (parts[i + 2].startsWith(cpMainPrefix)) discover(parts[i + 2], 'A');
            i += 3;
          } else {
            const rel = parts[i + 1];
            if (rel && rel.startsWith(cpMainPrefix)) discover(rel, token[0]);
            i += 2;
          }
        }
        if (pendingChanges.size > 0 || pendingDeleted.size > 0 || pendingNonJava.size > 0) {
          console.log(`[hot-cp] --once --git-range ${args.gitRange}：发现 ${pendingChanges.size} 个改动 .java / ${pendingDeleted.size} 个删除 / ${pendingNonJava.size} 个非 java`);
        }
      }
    } else {
      // --once 没有 watch 事件 ⇒ 用 git 发现"已改的 src/main 下 .java"（只收工作树已存在文件）
      const status = spawnSync('git', ['-C', projectRoot, 'status', '--porcelain', '-uall'], { windowsHide: true, encoding: 'utf8' });
      for (const line of (status.stdout ?? '').split(/\r?\n/)) {
        const m = line.match(/^[ MARD?]{1,2}\s+(packages\/control-plane\/src\/main\/[^ ]+)$/);
        if (m) {
          const rel = m[1];
          if (rel.endsWith('.java')) pendingChanges.add(join(projectRoot, rel));
          else pendingNonJava.add(join(projectRoot, rel));
        }
      }
      if (pendingChanges.size > 0) console.log(`[hot-cp] --once：git 发现 ${pendingChanges.size} 个改动 .java`);
    }
  }
  if (args.javac && pendingChanges.size > 0) {
    const files = [...pendingChanges];
    const missing = files.filter((f) => !existsSync(f));
    if (pendingNonJava.size > 0) {
      const names = [...pendingNonJava].map((p) => p.replace(`${projectRoot}\\`, '')).join(', ');
      console.warn(`[hot-cp] 非 .java 变更 ${pendingNonJava.size} 个（${names}）⇒ 回退 mvn（javac 不处理资源/配置）`);
    } else if (pendingDeleted.size > 0) {
      console.warn(`[hot-cp] 有 ${pendingDeleted.size} 个删除（--git-range）⇒ 回退 mvn 整模块`);
    } else if (missing.length > 0) {
      console.warn(`[hot-cp] 有 ${missing.length} 个改动文件已被删除 ⇒ 回退 mvn 整模块`);
    } else {
      const ok = buildJavacOnce(files);
      pendingChanges.clear();
      pendingNonJava.clear();
      pendingDeleted.clear();
      if (ok !== null) return ok;
    }
  }
  pendingChanges.clear();
  pendingNonJava.clear();
  pendingDeleted.clear();
  const startedAt = Date.now();
  console.log(`[hot-cp] running: mvn ${mvnArgs.join(' ')}  (cwd packages/control-plane)`);
  // Windows 上 `mvn` 是 .cmd，spawnSync 直接调用会 ENOENT（exit=null）⇒ 统一走 ComSpec /c。
  const isWin = process.platform === 'win32';
  const cmd = isWin ? (process.env.ComSpec || 'cmd.exe') : 'mvn';
  const cmdArgs = isWin ? ['/c', 'mvn', ...mvnArgs] : mvnArgs;
  const result = spawnSync(cmd, cmdArgs, {
    cwd: join(projectRoot, 'packages', 'control-plane'),
    stdio: 'inherit',
    windowsHide: true,
    env: process.env,
  });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  if (result.status !== 0) {
    const why = result.error ? `error=${result.error.message}` : `exit=${result.status ?? 'null'}`;
    console.error(`[hot-cp] BUILD FAILED (${why}) after ${elapsed}s —— 不重启、不改任何文件，等下一次保存`);
    return false;
  }
  builds += 1;
  console.log(`[hot-cp] BUILD OK (#${builds}) in ${elapsed}s  (finishedAt=${new Date().toISOString()})`);
  if (args.triggerFile) {
    try {
      mkdirSync(dirname(triggerPath), { recursive: true });
      writeFileSync(triggerPath, `${new Date().toISOString()} build#${builds}\n`);
      console.log(`[hot-cp] trigger touched: ${triggerPath}（devtools restart.trigger-file 只会因此重启一次）`);
    } catch (error) {
      console.error(`[hot-cp] WARN: 无法写 trigger 文件 ${triggerPath}: ${error.message}`);
    }
  }
  tailForRestart(startedAt);
  return true;
}

function schedule(reason) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      buildOnce();
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule('pending');
      }
    }
  }, args.debounce);
  console.log(`[hot-cp] change (${reason}) → 将在 ${args.debounce} ms 后编译`);
}

// ② 目标端口是否在听：栈没起时编译只会把 classes 改脏、不会有 devtools 重启 ⇒ 默认拒绝。
function portListening(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1500, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

const cpPort = derived.ports.cp;
const listening = await portListening(cpPort);
console.log(`[hot-cp] target stack port: ${cpPort} listening=${listening}`);
if (!listening && !args.force) {
  console.error(
    `[hot-cp] 停在编译前：${stackId} 的 CP 端口 ${cpPort} 不在听（栈没起 / 端口被占）。\n`
    + '  此时编译只会把 classes 改脏而没人会重启 ⇒ 默认拒绝。\n'
    + `  先把栈起起来（node scripts/dev-stack.mjs start --stack ${args.stack}），或用 --force 强行编译。`,
  );
  process.exit(2);
}
if (!listening) console.warn('[hot-cp] --force：端口不在听，本次编译不会触发 devtools 重启。');

console.log(`[hot-cp] watching ${watchRoot} (recursive, debounce=${args.debounce} ms)`);
console.log(`[hot-cp] 提示：热循环期间 devtools 自己重启 CP；**不要**再跑 dev-stack start/stop（会换 target dir 并重新冷编）。`);
if (errLogPath) console.log(`[hot-cp] 错误日志：${errLogPath}`);

if (args.dryRun) {
  console.log(`[hot-cp] --dry-run: 将执行 mvn ${mvnArgs.join(' ')}（未执行，直接退出）`);
  process.exit(0);
}
if (args.once) {
  process.exit(buildOnce() ? 0 : 1);
}

let watcher;
try {
  watcher = watch(watchRoot, { recursive: true }, (event, filename) => {
    if (!filename) return;
    const abs = join(watchRoot, filename);
    if (filename.endsWith('.java')) pendingChanges.add(abs);
    else pendingNonJava.add(abs);
    schedule(`${event} ${filename}`);
  });
} catch (error) {
  console.error(`[hot-cp] FAILED to watch ${watchRoot}: ${error.message}`);
  process.exit(2);
}

const shutdown = () => {
  watcher?.close();
  console.log(`[hot-cp] 停止（共 ${builds} 次编译）`);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
