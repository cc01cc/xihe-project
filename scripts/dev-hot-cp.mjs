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
import { watch } from 'node:fs';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';

import { cpBuildRoot, readPointer, pointerPath } from './lib/cp-build-dir.mjs';
import { buildInfoPath, gitHead, readBuildInfo, shortSha } from './lib/cp-build-info.mjs';
import { DEFAULT_STACK_ID, deriveStack } from './lib/stack-ports.mjs';

const projectRoot = dirname(import.meta.dirname);
const HELP = `usage: node scripts/dev-hot-cp.mjs [--stack N] [--debounce 300] [--once] [--dry-run] [--no-restart-hint] [--force] [--i-understand-this-dirties-evidence]

  --stack N         目标栈（默认 2 = 本仓的 dev 栈；stack-1 留作证据栈，需显式 flag 才允许）
  --debounce MS     合并事件的防抖窗口（默认 300；保存风暴时避免连跑 mvn）
  --once            只编译一次就退出（不 watch；给 CI/手工用）
  --dry-run         只打印将要执行的命令与目标目录，不实际编译
  --no-restart-hint 不打印 devtools 日志提示
  --force           目标端口不在听时仍然编译（默认拒绝：没人重启时编译只会把 classes 改脏）
  --i-understand-this-dirties-evidence
                    允许对 stack-1（证据栈）热编（会把"真栈证据"弄脏）
  --help, -h        打印本帮助

判据：编译后 devtools 应在 CP 日志里打出 'Restarting' / 'Started ...'；本脚本编译结束时自动去
日志尾部找一次并打印（找不到就打印 WARN 与日志路径）。`;

const args = { stack: 2, debounce: 300, once: false, dryRun: false, restartHint: true, force: false, dirtiesEvidence: false };
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
  if (explicit) return { targetDir: explicit, source: 'XIHE_CP_TARGET_DIR' };
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
if (args.stack === DEFAULT_STACK_ID && !args.dirtiesEvidence) {
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

function buildOnce() {
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
  console.log(`[hot-cp] BUILD OK (#${builds}) in ${elapsed}s`);
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
  console.log(`[hot-cp] --dry-run: 将执行 mvn ${mvnArgs.join(' ')}（未执行）`);
  if (args.once) process.exit(0);
}
if (args.once) {
  if (args.dryRun) process.exit(0);
  process.exit(buildOnce() ? 0 : 1);
}

let watcher;
try {
  watcher = watch(watchRoot, { recursive: true }, (event, filename) => {
    if (!filename) return;
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
