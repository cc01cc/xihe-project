#!/usr/bin/env node
/**
 * BL-461 / PLAN-0727：跑 CP Maven 套件，然后证明「用例真的执行过」。
 *
 * `mise run test:cp -- -Dtest=<typo>` 曾打印 BUILD SUCCESS 却零报告。本包装器保持 Maven 命令不变，
 * 只在成功路径上加零执行守卫（真失败时保留原退出码）。
 *
 * task-104 债①（infra-1, 2026-11-11）：同一位置再加一道「本轮残留」报告/门。
 * 背景（实测，非推断）：`test:cp` 曾两次（VW-20261111-08/-09）**exit 0 却留下
 * `xihe-workspace-ws_*` 沙箱容器**；而 `scripts/e2e-preflight.mjs:412-414` 对**未打标**的
 * 沙箱只打 INFO「do not remove blindly」⇒「用例全绿、环境未复原」在门里看不见。
 * 这里用**既有 by-label 过滤**（与 `scripts/e2e-host.mjs:1979/2384` 同一手法）把残留摆上台面：
 *   - 默认 report-only：打印清单，**exit code 不受影响**（门禁纪律：新增门必须参数化、默认不阻断）；
 *   - `--enforce-residue`：有残留 ⇒ exit 2（且参数**不再透传给 maven**，见下方过滤）。
 * **只报不删**：清理按 one/AGENTS.md「删除与清理分级」逐项授权后执行，本脚本不做任何删除动作。
 *
 * task-43（rule-1, 2026-11-21）：**单树互斥 + fork 假红分类**。
 * 背景（实测）：13:00 `mise run test:cp` exit 1，`Tests run: 317, Failures: 0, Errors: 20`，
 * 全是 `NoClassDefFoundError` + `SurefireBooterForkException`；同刻另一条裸 `mvn -B -o clean`
 * 在同一棵树里跑，两个 mvn 共用 `target/{classes,test-classes}`（一读一写）⇒ fork 出来的
 * surefire JVM 拿到半成品目录。`target/surefire-reports/2026-11-21T13-04-37_523.dumpstream` 留证：
 * `Boot Manifest-JAR contains absolute paths in classpath '…\target\test-classes'` +
 * `'other' has different root`；而 `ApprovalHistoryIntegrationTest.class` 就在盘上（不是真缺类）。
 * 对策（Lead 裁定，见 `internal/A03-xihe/evidence/2026-11-21-cp-test-race/DESIGN.md`）：
 *   ① **A 前置互斥（fail-fast）**：`<targetDir>/.cp-test.lock`（`wx` 独占，元数据带 targetDir/pid/
 *      startedAt/argv0）+ **外来 mvn 探测**（只锁走包装器的自己人不够，事故另一路就是裸 mvn）。
 *      目标目录由 `-Dxihe.target.dir` > `-Dxihe.build.suffix` > `<pkg>/target` 决定；
 *      **targetDir 不等 ⇒ 一律放行**（stack lane 用 per-sha 目录，锁住它就是「起栈失败」这种无头案）。
 *   ② **B′ 事后分类（不重跑）**：mvn 非 0 后扫本轮 dumpstream / surefire txt；命中「fork 期
 *      classpath 不同根」或「缺类但 .class 在盘」⇒ exit 4，把噪声翻译成人话。自动重跑会把
 *      「环境冲突」变成「偶发绿」，正好掩盖要看见的事（Lead 否决重跑）。
 * 退出码：0 通过 / 1 mvn 失败 / 2 包装器自身错 / **3 并发拒绝** / **4 环境冲突（fork 期）**。
 * 自检：`--selftest`（注入 runner 与进程表，**不起真 mvn**；真 mvn 只在手工验收里跑）。
 *
 * task-116（audit-1, 2026-11-22）：**基线 / 新红自动分类接进包装器**。
 * 旧口径（BL-368 原注释）说「不接进 test:cp，否则会吞掉 mvn 输出」——实测不成立：mvn 以
 * `stdio: 'inherit'` 跑完，分类器在它**之后**以子进程跑（stdout 走管道解析、stderr 原样转述），
 * mvn 的输出一个字不少。现在无论 mvn 成败都多打一行「N 条失败中 基线 a / 新红 b」，
 * **只加读数、不改退出码**（`check-cp-baseline.mjs` 自己的 exit code 永不覆盖 mvn 的）。
 * **exit 4 与用例红分开记账，但两者都出读数**：exit 4 回答的是「本轮证据是否可信」，
 * 「基线 / 新红」回答的是「用例账」。实测（2026-11-22）默认树**每轮**都会落一个 fork
 * classpath dumpstream（2026-11-21 一天 13 个，含全绿轮），若在 exit 4 分支跳过分类，
 * 这一行就永远不会被打出来，本卡的目标也就落空。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isLockStale,
  readLockHolder,
  releaseLock,
  sweepStaleLock,
  tryCreateLock,
} from './lib/file-lock.mjs';
import { processTable } from './lib/stack-identity.mjs';
import { pidIsAlive } from './xihe-cli/token-store.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const PACKAGE_DIR = path.join(ROOT, 'packages', 'control-plane');
/** 单树锁：放在解析出的 target 目录里 ⇒ 被 .gitignore 的 target/ 与 target-<suffix>/ 规则覆盖。 */
export const LOCK_FILENAME = '.cp-test.lock';
/** 绝对上限：活 pid 但锁超过 12h 仍判过期（覆盖 pid 复用与宿主睡眠导致的 mtime 漂移）。 */
export const DEFAULT_LOCK_STALE_MS = 12 * 60 * 60 * 1000;
/** 本开关属于包装器自身，必须从透传参数里剔除（D-893 同族：参数没到达它该到的地方）。 */
const ENFORCE_RESIDUE = '--enforce-residue';
const NO_LOCK = '--no-lock';
const DRY_RUN = '--dry-run';
const SELFTEST = '--selftest';

const defaultLog = (...args) => console.log(...args);

/* ------------------------------------------------------------ 目标目录解析 */

/**
 * 解析 Maven 实际会写的 target 目录（与 `packages/control-plane/pom.xml:53-62` 的
 * `<xihe.target.dir>${project.basedir}/target${xihe.build.suffix}</xihe.target.dir>` 同口径）。
 * 显式 `-Dxihe.target.dir` 优先；其次 `-Dxihe.build.suffix`；否则默认 `<pkg>/target`。
 * @param {string[]} args 透传给 maven 的参数
 * @param {string} packageDir
 * @returns {{targetDir:string, source:'target-dir'|'suffix'|'default'}}
 */
export function resolveTargetDir(args, packageDir = PACKAGE_DIR) {
  const explicit = flagValue(args, '-Dxihe.target.dir=');
  if (explicit) {
    return { targetDir: path.resolve(packageDir, explicit), source: 'target-dir' };
  }
  const suffix = flagValue(args, '-Dxihe.build.suffix=');
  if (suffix) {
    return { targetDir: path.resolve(packageDir, `target${suffix}`), source: 'suffix' };
  }
  return { targetDir: path.join(packageDir, 'target'), source: 'default' };
}

function flagValue(args, prefix) {
  for (const arg of args) {
    const text = String(arg);
    if (!text.startsWith(prefix)) continue;
    const value = text
      .slice(prefix.length)
      .trim()
      .replace(/^"(.*)"$/, '$1');
    if (value) return value;
  }
  return null;
}

export function lockPathFor(targetDir) {
  return path.join(targetDir, LOCK_FILENAME);
}

/* ------------------------------------------------------------ 单树锁（fail-fast） */

/**
 * 取单树锁。语义：**fail-fast**（不排队 —— 两轮并发本来就该拒绝，等它只是浪费时间）。
 * 锁元数据必须能自证「锁的是哪棵树」：targetDir / pid / startedAt / argv0（Lead 硬要求）。
 * @returns {{kind:'acquired', path:string, release:()=>boolean}
 *   | {kind:'held', path:string, holder:object}
 *   | {kind:'unusable', path:string, reason:string}}
 */
export function acquireTestLock({
  targetDir,
  argv0 = process.argv[1] ?? 'cp-test-run',
  runId = null,
  now = Date.now,
  fsImpl = fs,
  alive = pidIsAlive,
  staleMs = DEFAULT_LOCK_STALE_MS,
  log = defaultLog,
} = {}) {
  const lockAbs = lockPathFor(targetDir);
  const payload = () => ({
    pid: process.pid,
    startedAt: new Date(now()).toISOString(),
    targetDir: path.resolve(targetDir),
    argv0,
    runId,
  });
  let created = tryCreateLock(lockAbs, { fsImpl, payload: payload() });
  if (created.kind === 'acquired') {
    return { kind: 'acquired', path: lockAbs, release: () => releaseLock(lockAbs, { fsImpl }) };
  }
  if (created.kind === 'unusable') return created;
  const holder = readLockHolder(lockAbs, { fsImpl, now });
  if (!isLockStale(holder, { staleMs, alive })) {
    return { kind: 'held', path: lockAbs, holder };
  }
  const sweep = sweepStaleLock(lockAbs, { fsImpl, staleMs, alive, now });
  log(
    `[cp-test-run] 清理过期锁${sweep.swept ? `（已改名保留现场 → ${sweep.parkedTo ?? '删除'}）` : `（清理失败：${sweep.error ?? 'unknown'}）`}`,
  );
  created = tryCreateLock(lockAbs, { fsImpl, payload: payload() });
  if (created.kind === 'acquired') {
    return { kind: 'acquired', path: lockAbs, release: () => releaseLock(lockAbs, { fsImpl }) };
  }
  if (created.kind === 'unusable') return created;
  return { kind: 'held', path: lockAbs, holder: readLockHolder(lockAbs, { fsImpl, now }) };
}

/* ------------------------------------------------------------ 外来 mvn 探测 */

/** 路径比较口径：Windows 不分大小写、分隔符统一、去尾部分隔符。 */
export function normalizePath(value) {
  return String(value ?? '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** 这条命令行像不像「会写 target 的 maven 侧进程」（mvn 本身、surefire fork、plexus 启动器）。 */
export function looksLikeMaven(commandLine) {
  const cmd = String(commandLine ?? '');
  if (!cmd) return false;
  return (
    /(^|[\s"'=])mvn(\.cmd|\.bat|\.ps1)?(\s|$)/i.test(cmd) ||
    /surefirebooter|maven-surefire|org\.codehaus\.plexus\.classworlds/i.test(cmd) ||
    /-Dmaven\.|org\.apache\.maven/i.test(cmd)
  );
}

/**
 * 从命令行还原该进程写的是哪个 target 目录。
 * ① 显式 `-Dxihe.target.dir=<v>`（stack 的 `spring-boot:run`、dev-hot 都走这条）；
 * ② 命令行里出现的 `…/packages/control-plane/target<suffix>/…` 类路径（surefire fork）。
 * 无法判定时返回 null —— 调用方据此决定「保守拦截」还是「只告警」，绝不猜。
 */
export function declaredTargetDir(commandLine, packageDir = PACKAGE_DIR) {
  const cmd = String(commandLine ?? '');
  const explicit = cmd.match(/-Dxihe\.target\.dir=(?:"([^"]+)"|([^\s"';]+))/);
  if (explicit) return path.resolve(packageDir, (explicit[1] ?? explicit[2]).trim());
  const fromClasspath = cmd.match(/packages[\\/]control-plane[\\/](target[^\\/;"'\s:]*)/i);
  if (fromClasspath) return path.resolve(packageDir, fromClasspath[1]);
  return null;
}

/**
 * 在进程全表里找「正在写同一棵 target 的外来 maven」。
 * **只拦同一 targetDir**：`-Dxihe.target.dir` 不同的一律放行（stack lane 的 per-sha 目录，
 * 误拦的症状是「起栈失败」，没人会想到是测试锁）。
 * @param {{pid:number, parentPid?:number, commandLine:string}[]} entries
 */
export function findForeignMaven(
  entries,
  { targetDir, packageDir = PACKAGE_DIR, selfPids = new Set() } = {},
) {
  const wanted = normalizePath(targetDir);
  const inPackage = normalizePath(packageDir);
  const defaultTarget = normalizePath(path.join(packageDir, 'target'));
  const hits = [];
  for (const entry of entries ?? []) {
    const pid = Number(entry?.pid);
    if (!Number.isInteger(pid) || pid <= 0 || selfPids.has(pid)) continue;
    const commandLine = String(entry?.commandLine ?? '');
    if (!looksLikeMaven(commandLine)) continue;
    const normalizedCmd = normalizePath(commandLine);
    const declared = declaredTargetDir(commandLine, packageDir);
    if (declared) {
      // 能判定它写哪棵树：只拦**同一棵**（stack 的 per-sha 目录一律放行，误拦症状是「起栈失败」）。
      if (normalizePath(declared) === wanted) {
        hits.push({ pid, commandLine, targetDir: declared, reason: 'explicit' });
      }
      continue;
    }
    // 判定不了 target：裸 `mvn`（本次事故那一路，cwd 就在 packages/control-plane，命令行里没有路径），
    // 或只提到 control-plane 包的 mvn。这里必须**保守**：
    //   - 本树就是默认 `<pkg>/target` ⇒ 拦（默认树是全仓唯一共用目标，宁可拒绝也不制造假红）；
    //   - 本树是隔离目录 ⇒ 只告警（别把 dev-hot/stack 的正常构建变成红）。
    const mentionsThisPackage =
      normalizedCmd.includes(inPackage) || normalizedCmd.includes('packages/control-plane');
    const mentionsOtherModule = /packages\/(?!control-plane)/.test(normalizedCmd);
    if (!mentionsThisPackage && mentionsOtherModule) continue;
    const reason = mentionsThisPackage ? 'unknown-default' : 'unknown-bare';
    if (wanted === defaultTarget) {
      hits.push({ pid, commandLine, targetDir: path.join(packageDir, 'target'), reason });
    } else {
      hits.push({
        pid,
        commandLine,
        targetDir: null,
        reason: 'unknown-other-tree',
        advisory: true,
      });
    }
  }
  return hits;
}

/** 自己 + 祖先链：探测时豁免，避免「自己那条 mvn 把自己拦住」。 */
export function selfProcessIds(table, pid = process.pid, maxDepth = 8) {
  const ids = new Set([Number(pid)]);
  let current = Number(pid);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const info = (table ?? []).find((row) => Number(row?.pid) === current);
    const parent = Number(info?.parentPid ?? 0);
    if (!Number.isInteger(parent) || parent <= 0 || ids.has(parent)) break;
    ids.add(parent);
    current = parent;
  }
  return ids;
}

/* ------------------------------------------------------------ fork 假红分类 */

/**
 * mvn 非 0 之后判断「是不是并发构建把 target 换掉了」。
 * 只看**本轮**（mtime >= since）的报告，避免拿上一轮 dumpstream 当证据。
 * @returns {{conflict:boolean, evidence:{file:string,reason:string,detail:string}[], note:string|null}}
 */
export function classifyForkConflict({
  targetDir,
  since,
  fsImpl = fs,
  packageDir: _packageDir = PACKAGE_DIR,
} = {}) {
  const reports = path.join(targetDir, 'surefire-reports');
  const evidence = [];
  let names = [];
  try {
    names = fsImpl.readdirSync(reports);
  } catch {
    // 目录还不存在（第一次构建就失败）时无需分类：没有本轮报告就没有并发证据。
    return {
      conflict: false,
      evidence,
      note: '本轮没有 surefire-reports（构建在 fork 前就失败了）',
    };
  }
  for (const name of names) {
    const file = path.join(reports, name);
    let stat;
    try {
      stat = fsImpl.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.mtimeMs + 2000 < since) continue;
    let content = '';
    try {
      content = fsImpl.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (/\.dumpstream$/i.test(name)) {
      const offending = content.match(/.*(has different root|absolute paths in classpath).*/i);
      if (offending) {
        evidence.push({
          file,
          reason: 'dumpstream：fork 期 classpath 指向被替换的 target',
          detail: offending[0].trim().slice(0, 200),
        });
      }
      continue;
    }
    if (!/\.txt$/i.test(name)) continue;
    const missing = content.match(/(?:NoClassDefFoundError|ClassNotFoundException):\s*([\w$./]+)/);
    if (!missing) continue;
    const className = missing[1].replace(/\//g, '.');
    const classFile = path.join(
      targetDir,
      'test-classes',
      `${className.replace(/\./g, '/')}.class`,
    );
    const present = [
      classFile,
      path.join(targetDir, 'classes', `${className.replace(/\./g, '/')}.class`),
    ].some((candidate) => {
      try {
        return fsImpl.existsSync(candidate);
      } catch {
        return false;
      }
    });
    if (present) {
      evidence.push({
        file,
        reason: '缺类但 .class 在盘：fork 期目录被换掉（不是真缺类）',
        detail: `${missing[0].trim()} | 在盘：${path.relative(targetDir, classFile)}`,
      });
    }
  }
  return { conflict: evidence.length > 0, evidence, note: null };
}

/* ------------------------------------------------------------ 主流程 */

/* ------------------------------------------------------------ 基线 / 新红分类（task-116） */

/** 分类器脚本名（与包装器同目录）。 */
export const BASELINE_SCRIPT = 'check-cp-baseline.mjs';

/**
 * 把「本轮 surefire 里的红」机械分成**已知基线**与**新红**，只打一行读数。
 *
 * 纪律（四条，全部由被调用方 `check-cp-baseline.mjs` 自己判定，本函数一律不放宽）：
 *   1. 基线只许缩小 —— 本函数**从不写** `cp-known-baseline.json`，只读；
 *   2. 条目转绿必须删 —— 由分类器的 `greenEntries` WARN 负责，这里原样转述；
 *   3. `reviewBy` 过期即失败 —— 分类器 exit 1 / `expired`，这里不改判；
 *   4. 报告早于 HEAD ⇒ exit 2 要求重跑 —— **不传 `--allow-stale-reports`**，
 *      拿不到可判定的 JSON 时如实报「不可判定」，绝不把旧树的失败当成新树的读数。
 *
 * 退出码不参与：返回值只用于打印，`main()` 的 return 与它无关（卡面要求 2）。
 *
 * @returns {{state:'ok'|'indeterminate'|'error', failures?:number, baseline?:number, fresh?:number, code?:number} | null}
 */
export function classifyBaseline({
  root = ROOT,
  targetDir,
  // 这两个只用于 `--selftest` 的三情形判据（在临时目录造红/造绿）。**生产路径保持 null**
  // ⇒ 分类器读真实的 `scripts/cp-known-baseline.json` 与真实 HEAD 时刻，判据不被放宽。
  baselineFile = null,
  headTime = null,
  execPath = process.execPath,
  spawn = spawnSync,
  log = defaultLog,
} = {}) {
  const script = path.join(root, 'scripts', BASELINE_SCRIPT);
  const reports = path.join(targetDir, 'surefire-reports');
  const argv = [script, '--reports', reports, '--json'];
  if (baselineFile) argv.push('--baseline', baselineFile);
  if (headTime) argv.push('--head-time', String(headTime));
  let result;
  try {
    result = spawn(execPath, argv, {
      cwd: root,
      // stdout 走管道解析，stderr **原样 inherit**：过期条目 / 新红点名 / report-health WARN
      // 一条都不许被这个包装器吞掉。
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
    });
  } catch (error) {
    log(`[cp-baseline] 分类未运行（子进程启动失败：${error?.message ?? error}）⇒ 跳过读数，不影响退出码`);
    return { state: 'error' };
  }
  const code = result?.status;
  let payload = null;
  try {
    payload = JSON.parse(String(result?.stdout ?? '').trim());
  } catch {
    payload = null;
  }
  if (code !== 0 && code !== 1) {
    // exit 2 = 缺报告 / 基线文件读不出 / **报告早于 HEAD**；null = 分类器自身崩了。
    // 这一档不是「没有红」，是「本轮判不了」——措辞必须区分，否则又造出一个假绿。
    log(
      `[cp-baseline] 分类**不可判定**（exit ${code ?? 'n/a'}）：surefire 报告缺失或早于 HEAD ⇒` +
        ' 先确认 `mise run test:cp` 真跑了本轮，勿拿旧树判新树（不影响退出码）',
    );
    return { state: 'indeterminate', code: code ?? null };
  }
  if (!payload || !Array.isArray(payload.failures) || !Array.isArray(payload.newFailures)) {
    log('[cp-baseline] 分类**不可判定**：--json 输出解析失败 ⇒ 请手工跑 `mise run test:cp:baseline`');
    return { state: 'indeterminate', code: code ?? null };
  }
  const failures = payload.failures.length;
  const fresh = payload.newFailures.length;
  const baseline = failures - fresh;
  const expired = Array.isArray(payload.expired) ? payload.expired.length : 0;
  const green = Array.isArray(payload.greenEntries) ? payload.greenEntries.length : 0;
  log(
    `[cp-baseline] ${failures} 条失败中 基线 ${baseline} / 新红 ${fresh}` +
      `（exit ${code} 仅供人看，不改本任务退出码 · 过期条目 ${expired} · 已转绿待删 ${green} · ` +
      `判据日 ${payload.today ?? '?'}）`,
  );
  return { state: 'ok', failures, baseline, fresh };
}

/**
 * @param {{argv?:string[], deps?:object}} [options]
 * @returns {number} 退出码（0/1/2/3/4）
 */
export function main({ argv = process.argv.slice(2), deps = {} } = {}) {
  const {
    fsImpl = fs,
    spawn = spawnSync,
    now = Date.now,
    alive = pidIsAlive,
    table = processTable,
    log = defaultLog,
    platform = process.platform,
    packageDir = PACKAGE_DIR,
    env = process.env,
    execPath = process.execPath,
    root = ROOT,
  } = deps;

  if (argv.includes(SELFTEST)) return runSelftest({ deps: { ...deps, log } });

  const startedAt = now();
  const enforceResidue = argv.includes(ENFORCE_RESIDUE);
  const noLock = argv.includes(NO_LOCK);
  const dryRun = argv.includes(DRY_RUN);
  const args = argv.filter((arg) => arg !== ENFORCE_RESIDUE && arg !== NO_LOCK && arg !== DRY_RUN);
  const mvn = platform === 'win32' ? 'mvn.cmd' : 'mvn';

  const runId =
    env.XIHE_E2E_RUN_ID ??
    `cp-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`;
  log(`[cp-test-run] XIHE_E2E_RUN_ID=${runId}（容器标签来源；用于残留归属）`);

  const { targetDir, source } = resolveTargetDir(args, packageDir);
  log(`[cp-test-run] target 目录：${targetDir}（来源：${source}）`);

  let lock = null;
  try {
    if (noLock) {
      log('[cp-test-run] --no-lock：跳过单树锁与外来 mvn 探测（仅当你确认只有自己在跑）');
    } else {
      const acquired = acquireTestLock({
        targetDir,
        argv0: process.argv[1] ?? 'cp-test-run',
        runId,
        now,
        fsImpl,
        alive,
        log,
      });
      if (acquired.kind === 'held') {
        const holder = acquired.holder?.payload ?? {};
        log(
          `[cp-test-run] 拒绝并发：target 目录正被另一轮 test:cp 占住（pid ${acquired.holder?.pid ?? '?'}，`,
        );
        log(
          `  startedAt ${holder.startedAt ?? acquired.holder?.acquiredAt ?? '?'}，targetDir ${holder.targetDir ?? '?'}，argv0 ${holder.argv0 ?? '?'}）`,
        );
        log(`  锁文件：${acquired.path}；确认对方已结束后可删该文件，或加 --no-lock 自担并发风险`);
        return 3;
      }
      if (acquired.kind === 'unusable') {
        log(
          `[cp-test-run] WARN 无法创建单树锁（${acquired.reason}），降级为仅探测外来 mvn：${acquired.path}`,
        );
      } else {
        lock = acquired;
        log(`[cp-test-run] 单树锁：已取得 ${acquired.path}（pid ${process.pid}）`);
        const hits = probeForeignMaven({ targetDir, packageDir, table, log, fsImpl });
        const blocking = hits.filter((hit) => !hit.advisory);
        if (blocking.length > 0) {
          for (const hit of blocking) {
            log(`[cp-test-run] 拒绝并发：pid ${hit.pid} 正在写同一棵 target（${hit.reason}）`);
            log(`  ${hit.commandLine.slice(0, 240)}`);
          }
          log('[cp-test-run] 等它结束再跑；或改隔离目录（-Dxihe.target.dir=…）后重跑');
          return 3;
        }
        for (const hit of hits) {
          log(
            `[cp-test-run] WARN 有 mvn 在跑但其 target 无法判定（pid ${hit.pid}），本树是隔离目录 ⇒ 放行：${hit.commandLine.slice(0, 160)}`,
          );
        }
      }
    }

    if (dryRun) {
      log('[cp-test-run] --dry-run：只做目录解析 / 锁 / 探测，不启动 maven');
      return 0;
    }

    const maven = spawn(mvn, ['test', ...args], {
      cwd: packageDir,
      stdio: 'inherit',
      shell: platform === 'win32',
      // 显式传 env：被测进程（含其拉起的 runtime）据此给容器打 xihe.e2e.run-id 标签。
      env: { ...env, XIHE_E2E_RUN_ID: runId },
    });
    if (maven.error) {
      console.error(`[cp-test-run] failed to launch Maven: ${maven.error.message}`);
      return 2;
    }
    if (maven.status !== 0) {
      const verdict = classifyForkConflict({
        targetDir,
        since: startedAt,
        fsImpl,
        packageDir,
      });
      if (verdict.conflict) {
        log('[cp-test-run] 判定：环境冲突（fork 期 target 被并发构建替换），不是测试失败');
        for (const item of verdict.evidence)
          log(`  证据 ${item.file}\n         ${item.reason}：${item.detail}`);
        log('[cp-test-run] ⇒ exit 4（按裁定不自动重跑；确认无并发后原样重跑即可）');
        // 卡面要求 1「跑完 mvn 后**无论成败**都调一次」⇒ 这一档也要出读数，但**分开记账**：
        // exit 4 是包装器对「本轮证据是否可信」的判定，不是用例红；真正的用例账由下面这行的
        // 「基线 a / 新红 b」回答。实测（task-116, 2026-11-22）dumpstream 在默认树里**每轮都在**
        // （2026-11-21 一天 13 个 dumpstream，含全绿轮），若在 exit 4 分支跳过分类，
        // 「基线 / 新红」就永远不会被打出来——正是本卡要消灭的「红点被当存量长期放过」。
        log('[cp-baseline] 注：本轮已被判 exit 4（fork 期 target 漂移）——该判定与下面这行的用例账**分开记**');
        classifyBaseline({ root, targetDir, execPath, spawn, log });
        return 4;
      }
      if (verdict.note) log(`[cp-test-run] 分类：${verdict.note}`);
      // mvn 因**用例**红而失败：先出分类读数（打印在 mvn 输出之后），退出码仍按 mvn 定。
      classifyBaseline({ root, targetDir, execPath, spawn, log });
      return maven.status ?? 1;
    }

    const guard = spawn(
      execPath,
      [
        path.join(root, 'scripts', 'check-test-executed.mjs'),
        '--since',
        String(startedAt),
        // 隔离树（-Dxihe.target.dir / -Dxihe.build.suffix）下报告不在默认 target；
        // 不传 --reports 会把真跑成 0 的隔离运行误判成「零执行假绿」。
        '--reports',
        path.join(targetDir, 'surefire-reports'),
      ],
      {
        cwd: packageDir,
        stdio: 'inherit',
      },
    );
    const guardStatus = guard.status ?? 1;

    // task-104 债①：残留报告放在「用例确实执行过」之后 —— 这一层要回答的正是
    // 「用例全绿了，环境复原了吗」。执行守卫本身失败时优先保留它的退出码。
    const residue = reportResidue(runId, enforceResidue, { spawn, env, platform, log });
    // report-only 下这一项**永不**改变退出码；enforce 下「有残留」和「查不到」都算不通过
    // （把未知读成干净是典型的假绿）。
    const residueFails = enforceResidue && (residue.count > 0 || residue.unverifiable !== null);
    // 成功路径同样分类一次：全绿时应读出「0 条失败中 基线 0 / 新红 0」，
    // 这也是「基线没被悄悄扩容」的正面证据（entries 仍为空 ⇒ 任何红都会判新红）。
    classifyBaseline({ root, targetDir, execPath, spawn, log });
    return guardStatus !== 0 ? guardStatus : residueFails ? 2 : 0;
  } finally {
    if (lock) lock.release();
  }
}

/** 探测失败（非 Windows / PowerShell 不可用）⇒ 明确告警，不静默当成「没有」。 */
function probeForeignMaven({ targetDir, packageDir, table, log, fsImpl }) {
  void fsImpl;
  let entries = [];
  try {
    const raw = table();
    entries =
      raw instanceof Map
        ? [...raw.entries()].map(([pid, info]) => ({
            pid,
            commandLine: info?.commandLine ?? '',
            parentPid: info?.parentPid,
          }))
        : [...(raw ?? [])];
  } catch (error) {
    log(`[cp-test-run] WARN 无法读取进程表（${error?.message ?? error}），只靠单树锁互斥`);
    return [];
  }
  if (!entries.some((entry) => String(entry?.commandLine ?? '').trim())) {
    log('[cp-test-run] WARN 进程表为空（非 Windows 或探测不可用），只靠单树锁互斥');
  }
  return findForeignMaven(entries, { targetDir, packageDir, selfPids: selfProcessIds(entries) });
}

/* ------------------------------------------------------------ 残留报告（task-104 债①） */

/**
 * 本轮（run-id 相同）还留着的容器，按两个标签族分别查——**两个族是不同的东西**，
 * 混在一起会让人以为「已打标」就是全部：
 *   ① `xihe.cp.test.run-id`：Testcontainers 容器（`TestContainerLabels`，由本轮写入）；
 *   ② `xihe.e2e.run-id`：Runtime 的 workspace 沙箱容器（`workspace.rs:248-251`），
 *      即 VW-08/-09 真正漏收的那一族。
 * 只查容器，**不断言卷/网络**（Testcontainers 默认不建命名卷/网络；越界断言会误红）。
 *
 * 语义边界（别把它读成「残留检测」）：查询是 `label=<key>=<value>` 的**精确匹配** ⇒ 标签值必须与被查
 * run id 相等；所以本门只保证「**本轮没漏**」，**跨轮残留不归它**（归窗口收尾，如 task-95 那一类）。
 */
export function reportResidue(
  runId,
  enforce,
  { spawn = spawnSync, env = process.env, platform = process.platform, log = defaultLog } = {},
) {
  const families = [
    { label: 'xihe.cp.test.run-id', what: 'CP 测试容器(Testcontainers)' },
    { label: 'xihe.e2e.run-id', what: 'workspace 沙箱容器' },
  ];
  log(
    `[cp-test-run] 残留检查（只报不删，run-id=${runId}，模式=${enforce ? 'enforce' : 'report-only'}）`,
  );
  let total = 0;
  let unverifiable = null;
  const docker = platform === 'win32' ? 'docker.exe' : 'docker';
  for (const family of families) {
    const listed = listByLabel(`${family.label}=${runId}`, { spawn, env, docker });
    if (!listed.ok) {
      unverifiable = listed.error;
      log(`  WARN  ${family.label}（${family.what}）：无法查询 —— ${listed.error}`);
      continue;
    }
    total += listed.rows.length;
    log(
      `  ${listed.rows.length === 0 ? 'OK   ' : 'FOUND'} ${family.label}（${family.what}）：${listed.rows.length} 个`,
    );
    for (const row of listed.rows) log(`          ${row}`);
  }
  if (total > 0) {
    log(
      '[cp-test-run] 上面这些容器**本轮没有自行消失**。清理不由本脚本执行：' +
        '按 one/AGENTS.md「删除与清理分级」列出清单、确认归属与可重建性后逐项授权再删。',
    );
  }
  if (unverifiable) {
    // fail-closed 只在 enforce 模式生效：report-only 下「查不到」不改变退出码，
    // enforce 下「查不到」不能当「干净」用（那是把未知读成通过）。
    if (enforce) log('[cp-test-run] --enforce-residue：残留**无法验证** ⇒ exit 2（未知≠干净）');
    return { count: total, unverifiable };
  }
  if (enforce && total > 0) {
    log('[cp-test-run] --enforce-residue：本轮残留 ⇒ exit 2（默认 report-only 时不阻断）');
  }
  return { count: total, unverifiable: null };
}

function listByLabel(filter, { spawn, env, docker }) {
  const result = spawn(
    docker,
    ['ps', '-a', '--filter', `label=${filter}`, '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}'],
    { encoding: 'utf8', env },
  );
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return {
      ok: false,
      error: (result.stderr ?? '').trim().split('\n')[0] || `exit ${result.status}`,
    };
  }
  const rows = (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return { ok: true, rows };
}

/* ------------------------------------------------------------ 自检（不起真 mvn） */

/**
 * 全部用注入替身跑完所有分支（Lead 硬要求：`--selftest` 不起真 mvn）。
 * 覆盖：目录解析 4 例 / 锁 5 例（含**不同 targetDir 放行**）/ 探测 5 例 / 分类 3 例 / 主流程 2 例。
 */
export function runSelftest({ deps = {} } = {}) {
  const log = deps.log ?? ((...args) => console.log(...args));
  const fsImpl = deps.fsImpl ?? fs;
  const now = 1_700_000_000_000;
  const tmpRoot = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'cp-test-run-selftest-'));
  const pkg = path.join(tmpRoot, 'packages', 'control-plane');
  fsImpl.mkdirSync(pkg, { recursive: true });
  const cases = [];
  const check = (name, fn) => {
    try {
      fn();
      cases.push({ name, ok: true });
    } catch (error) {
      cases.push({ name, ok: false, error: error?.message ?? String(error) });
    }
  };
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const silent = () => {};

  // ① 目录解析
  check('resolveTargetDir: 默认 -> <pkg>/target', () => {
    const got = resolveTargetDir([], pkg);
    assert(
      got.targetDir === path.join(pkg, 'target') && got.source === 'default',
      JSON.stringify(got),
    );
  });
  check('resolveTargetDir: -Dxihe.build.suffix 生效', () => {
    const got = resolveTargetDir(['-Dxihe.build.suffix=-race'], pkg);
    assert(
      got.targetDir === path.join(pkg, 'target-race') && got.source === 'suffix',
      JSON.stringify(got),
    );
  });
  check('resolveTargetDir: 显式绝对 -Dxihe.target.dir 优先', () => {
    const abs = path.join(tmpRoot, 'elsewhere', 'target');
    const got = resolveTargetDir([`-Dxihe.target.dir=${abs}`, '-Dxihe.build.suffix=-race'], pkg);
    assert(got.targetDir === abs && got.source === 'target-dir', JSON.stringify(got));
  });
  check('resolveTargetDir: 相对 -Dxihe.target.dir 按 pkg 解析', () => {
    const got = resolveTargetDir(['-Dxihe.target.dir=target-lane'], pkg);
    assert(got.targetDir === path.join(pkg, 'target-lane'), JSON.stringify(got));
  });

  // ② 锁：元数据 / 释放 / 活持有者拒绝 / 死持有者清扫 / 不同树放行
  const dirA = path.join(tmpRoot, 'tree-a');
  const dirB = path.join(tmpRoot, 'tree-b');
  fsImpl.mkdirSync(dirA, { recursive: true });
  fsImpl.mkdirSync(dirB, { recursive: true });
  check('锁：元数据含 targetDir/pid/startedAt/argv0，且落在该树的 target 目录内', () => {
    const lock = acquireTestLock({
      targetDir: dirA,
      argv0: 'node cp-test-run.mjs',
      runId: 'r1',
      now: () => now,
      fsImpl,
      alive: () => true,
      log: silent,
    });
    assert(lock.kind === 'acquired', `expected acquired, got ${lock.kind}`);
    const body = JSON.parse(fsImpl.readFileSync(lock.path, 'utf8'));
    assert(path.basename(lock.path) === LOCK_FILENAME, 'lock filename');
    assert(path.dirname(lock.path) === dirA, 'lock must live inside the tree it locks');
    assert(body.pid === process.pid, 'pid');
    assert(typeof body.startedAt === 'string' && body.startedAt.endsWith('Z'), 'startedAt');
    assert(body.targetDir === path.resolve(dirA), 'targetDir');
    assert(body.argv0 === 'node cp-test-run.mjs', 'argv0');
    assert(lock.release() === true, 'release returns true');
    assert(!fsImpl.existsSync(lock.path), 'release removes the lock');
  });
  check('锁：活持有者 ⇒ 拒绝（exit 3 路径），不覆盖对方锁', () => {
    const lock = acquireTestLock({
      targetDir: dirA,
      now: () => now,
      fsImpl,
      alive: () => true,
      log: silent,
    });
    assert(lock.kind === 'acquired', 'first acquire');
    const second = acquireTestLock({
      targetDir: dirA,
      now: () => now + 1000,
      fsImpl,
      alive: () => true,
      log: silent,
    });
    assert(second.kind === 'held', `expected held, got ${second.kind}`);
    assert(second.holder?.pid === process.pid, 'holder pid visible');
    lock.release();
  });
  check('锁：持有者 pid 已死 ⇒ 判过期并接管（改名留现场）', () => {
    const deadDir = path.join(tmpRoot, 'tree-dead');
    fsImpl.mkdirSync(deadDir, { recursive: true });
    const stalePath = lockPathFor(deadDir);
    fsImpl.writeFileSync(
      stalePath,
      `${JSON.stringify({ pid: 999999, startedAt: new Date(now).toISOString(), targetDir: deadDir })}\n`,
    );
    const acquired = acquireTestLock({
      targetDir: deadDir,
      now: () => now + 5000,
      fsImpl,
      alive: () => false,
      log: silent,
    });
    assert(acquired.kind === 'acquired', `expected acquired after sweep, got ${acquired.kind}`);
    const parked = fsImpl.readdirSync(deadDir).filter((name) => name.includes('.stale-'));
    assert(parked.length === 1, `expected one parked stale lock, got ${parked.length}`);
    acquired.release();
  });
  check('锁：不同 targetDir ⇒ 各自取锁、互不干扰（必须放行）', () => {
    const a = acquireTestLock({
      targetDir: dirA,
      now: () => now,
      fsImpl,
      alive: () => true,
      log: silent,
    });
    const b = acquireTestLock({
      targetDir: dirB,
      now: () => now,
      fsImpl,
      alive: () => true,
      log: silent,
    });
    assert(a.kind === 'acquired', `tree-a: ${a.kind}`);
    assert(b.kind === 'acquired', `tree-b: ${b.kind}`);
    a.release();
    b.release();
  });
  check('锁：非本进程写入的锁不会被 release 删掉（pid 守卫）', () => {
    const guardDir = path.join(tmpRoot, 'tree-guard');
    fsImpl.mkdirSync(guardDir, { recursive: true });
    const p = lockPathFor(guardDir);
    fsImpl.writeFileSync(p, `${JSON.stringify({ pid: 424242 })}\n`);
    assert(releaseLock(p, { fsImpl }) === false, 'must not delete a foreign lock');
    assert(fsImpl.existsSync(p), 'foreign lock still there');
  });

  // ③ 外来 mvn 探测
  const baseCmd = 'mvn.cmd test -Dxihe.target.dir=';
  check('探测：同显式 targetDir ⇒ 拦', () => {
    const entries = [
      { pid: 111, parentPid: 1, commandLine: `${baseCmd}${path.join(pkg, 'target')}` },
    ];
    const hits = findForeignMaven(entries, {
      targetDir: path.join(pkg, 'target'),
      packageDir: pkg,
    });
    assert(hits.length === 1 && !hits[0].advisory, JSON.stringify(hits));
  });
  check('探测：stack 的 per-sha targetDir ⇒ 放行（不得拦住起栈）', () => {
    const entries = [
      {
        pid: 222,
        parentPid: 1,
        commandLine: `${baseCmd}C:\\xihe-build\\cp\\stack-2\\1fc5d4b57eb1`,
      },
    ];
    const hits = findForeignMaven(entries, {
      targetDir: path.join(pkg, 'target'),
      packageDir: pkg,
    });
    assert(hits.length === 0, JSON.stringify(hits));
  });
  check('探测：裸 mvn（无 -D，事故那一路）且本树是默认 target ⇒ 拦', () => {
    const entries = [{ pid: 333, parentPid: 1, commandLine: 'mvn.cmd -B -o clean test-compile' }];
    const hits = findForeignMaven(entries, {
      targetDir: path.join(pkg, 'target'),
      packageDir: pkg,
    });
    assert(hits.length === 1 && hits[0].reason === 'unknown-bare', JSON.stringify(hits));
  });
  check('探测：提到别的模块（packages/runtime）的 mvn ⇒ 放行', () => {
    const entries = [
      { pid: 334, parentPid: 1, commandLine: 'mvn.cmd -f packages/runtime/pom.xml test' },
    ];
    const hits = findForeignMaven(entries, {
      targetDir: path.join(pkg, 'target'),
      packageDir: pkg,
    });
    assert(hits.length === 0, JSON.stringify(hits));
  });
  check('探测：无 -D 但本树是隔离目录 ⇒ 只告警不拦', () => {
    const entries = [{ pid: 444, parentPid: 1, commandLine: 'mvn.cmd -B -o clean test-compile' }];
    const hits = findForeignMaven(entries, {
      targetDir: path.join(pkg, 'target-lane'),
      packageDir: pkg,
    });
    assert(hits.length === 1 && hits[0].advisory === true, JSON.stringify(hits));
  });
  check('探测：surefire fork 的 classpath 也能还原 target 目录', () => {
    const cls = path.join(pkg, 'target', 'test-classes');
    const entries = [
      { pid: 555, parentPid: 1, commandLine: `java.exe -cp ${cls};x surefirebooter.jar` },
    ];
    const hits = findForeignMaven(entries, {
      targetDir: path.join(pkg, 'target'),
      packageDir: pkg,
    });
    assert(hits.length === 1, JSON.stringify(hits));
  });
  check('探测：自己的 pid 与祖先链豁免', () => {
    const entries = [
      {
        pid: process.pid,
        parentPid: 1,
        commandLine: `mvn.cmd test -Dxihe.target.dir=${path.join(pkg, 'target')}`,
      },
      { pid: 777, parentPid: process.pid, commandLine: 'node cp-test-run.mjs' },
    ];
    const hits = findForeignMaven(entries, {
      targetDir: path.join(pkg, 'target'),
      packageDir: pkg,
      selfPids: selfProcessIds(entries),
    });
    assert(hits.length === 0, JSON.stringify(hits));
  });

  // ④ fork 假红分类
  const raceDir = path.join(tmpRoot, 'tree-race');
  const reports = path.join(raceDir, 'surefire-reports');
  fsImpl.mkdirSync(path.join(raceDir, 'test-classes', 'com', 'x'), { recursive: true });
  fsImpl.mkdirSync(reports, { recursive: true });
  fsImpl.writeFileSync(
    path.join(reports, '2026-11-21T13-04-37_523.dumpstream'),
    "Boot Manifest-JAR contains absolute paths in classpath 'C:\\p\\target\\test-classes'\n'other' has different root\n",
  );
  check('分类：本轮 dumpstream 命中 ⇒ conflict（exit 4 路径）', () => {
    const verdict = classifyForkConflict({
      targetDir: raceDir,
      since: now - 60_000,
      fsImpl,
      packageDir: pkg,
    });
    assert(verdict.conflict === true, JSON.stringify(verdict));
    assert(verdict.evidence[0].reason.includes('dumpstream'), verdict.evidence[0].reason);
  });
  check('分类：上一轮 dumpstream（mtime 早于 since）不算本轮证据', () => {
    // since 必须取**真实**现在的未来值：假 now(2023) 与文件真实 mtime(2026) 不可比。
    const verdict = classifyForkConflict({
      targetDir: raceDir,
      since: Date.now() + 3_600_000,
      fsImpl,
      packageDir: pkg,
    });
    assert(verdict.conflict === false, JSON.stringify(verdict));
  });
  check('分类：缺类但 .class 在盘 ⇒ conflict；.class 不在盘 ⇒ 不误判', () => {
    fsImpl.writeFileSync(
      path.join(reports, 'com.x.RealT.txt'),
      'java.lang.NoClassDefFoundError: com/x/RealT\n',
    );
    fsImpl.writeFileSync(path.join(raceDir, 'test-classes', 'com', 'x', 'RealT.class'), 'x');
    fsImpl.writeFileSync(
      path.join(reports, 'com.x.MissingT.txt'),
      'java.lang.NoClassDefFoundError: com/x/MissingT\n',
    );
    const verdict = classifyForkConflict({
      targetDir: raceDir,
      since: now - 60_000,
      fsImpl,
      packageDir: pkg,
    });
    const reasons = verdict.evidence.map((item) => item.detail).join('|');
    assert(reasons.includes('RealT'), reasons);
    assert(!reasons.includes('MissingT'), reasons);
  });

  // ⑤ 主流程：--no-lock / --dry-run 不得启动 mvn
  const spawnCalls = [];
  const fakeSpawn = (command, args) => {
    spawnCalls.push([command, ...(args ?? [])]);
    return { status: 0, stdout: '', stderr: '' };
  };
  const mainDeps = {
    fsImpl,
    spawn: fakeSpawn,
    table: () => [],
    log: silent,
    now: () => now,
    packageDir: pkg,
    env: {},
    platform: 'linux',
    root: tmpRoot,
    execPath: process.execPath,
  };
  check('主流程：--dry-run 不启动 mvn 且 exit 0', () => {
    spawnCalls.length = 0;
    const code = main({ argv: ['--dry-run'], deps: mainDeps });
    assert(code === 0, `exit ${code}`);
    assert(spawnCalls.length === 0, `spawned: ${JSON.stringify(spawnCalls)}`);
  });
  check('主流程：隔离树的 check-test-executed 收到该树的 --reports（否则真跑被误判零执行）', () => {
    const tree = path.join(tmpRoot, 'tree-reports');
    fsImpl.mkdirSync(tree, { recursive: true });
    const spawnCalls = [];
    const deps = {
      ...mainDeps,
      spawn: (cmd, args) => {
        spawnCalls.push([cmd, ...args].join(' '));
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    const code = main({ argv: ['--no-lock', `-Dxihe.target.dir=${tree}`], deps });
    assert(code === 0, `exit ${code}`);
    const guardCall = spawnCalls.find((call) => call.includes('check-test-executed.mjs'));
    assert(guardCall, JSON.stringify(spawnCalls));
    assert(
      guardCall.includes(path.join(tree, 'surefire-reports')),
      `guard 没拿到隔离树的 reports：${guardCall}`,
    );
  });

  check('主流程：--no-lock 不写锁文件且照常启动（替身）', () => {
    spawnCalls.length = 0;
    const tree = path.join(tmpRoot, 'tree-nolock');
    fsImpl.mkdirSync(tree, { recursive: true });
    const code = main({ argv: ['--no-lock', `-Dxihe.target.dir=${tree}`], deps: mainDeps });
    assert(code === 0, `exit ${code}`);
    assert(
      spawnCalls.some((call) => call.includes('test')),
      JSON.stringify(spawnCalls),
    );
    assert(!fsImpl.existsSync(lockPathFor(tree)), 'no-lock must not leave a lock');
  });
  // 卡面要求 2：分类**不得改退出码**；要求 1：**无论成败**都要分类。
  const blTree = path.join(tmpRoot, 'tree-exitcode');
  fsImpl.mkdirSync(path.join(blTree, 'surefire-reports'), { recursive: true });
  const blTreeArg = `-Dxihe.target.dir=${blTree}`;
  check('主流程：mvn 因用例红而失败 ⇒ 退出码仍是 mvn 的，且分类器已被调用', () => {
    spawnCalls.length = 0;
    const deps = {
      ...mainDeps,
      spawn: (cmd, args) => {
        spawnCalls.push([cmd, ...(args ?? [])].join(' '));
        // mvn 红，且本轮报告里**没有**并发证据 ⇒ 不走 exit 4。
        return cmd === 'mvn' || /mvn(\.cmd)?$/i.test(cmd)
          ? { status: 1, stdout: '', stderr: '' }
          : { status: 0, stdout: '', stderr: '' };
      },
    };
    const code = main({ argv: ['--no-lock', blTreeArg], deps });
    assert(code === 1, `期望 mvn 的退出码 1（分类器 exit 不得覆盖），实得 ${code}`);
    assert(
      spawnCalls.some((call) => call.includes('check-cp-baseline.mjs')),
      `失败路径必须分类：${JSON.stringify(spawnCalls)}`,
    );
  });
  check('主流程：fork 期冲突 ⇒ 仍 exit 4，但分类照跑（分开记账，不静默跳过）', () => {
    const raceTree = path.join(tmpRoot, 'tree-exit4');
    const raceReports = path.join(raceTree, 'surefire-reports');
    fsImpl.mkdirSync(raceReports, { recursive: true });
    // 本轮 dumpstream（mtime 新于注入的 now=2023）⇒ classifyForkConflict 命中。
    fsImpl.writeFileSync(
      path.join(raceReports, '2026-11-22T00-46-51_042.dumpstream'),
      "Boot Manifest-JAR contains absolute paths in classpath 'H:\\p\\target\\test-classes'\n'other' has different root\n",
    );
    spawnCalls.length = 0;
    const deps = {
      ...mainDeps,
      spawn: (cmd, args) => {
        spawnCalls.push([cmd, ...(args ?? [])].join(' '));
        return { status: 1, stdout: '', stderr: '' };
      },
    };
    const code = main({ argv: ['--no-lock', `-Dxihe.target.dir=${raceTree}`], deps });
    assert(code === 4, `期望 exit 4（判定不变），实得 ${code}`);
    assert(
      spawnCalls.some((call) => call.includes('check-cp-baseline.mjs')),
      `exit 4 也要出「基线 / 新红」读数：${JSON.stringify(spawnCalls)}`,
    );
  });

  // ⑥ 基线 / 新红分类（task-116）：三种情形各给原文读数。
  // 这里**真跑** `check-cp-baseline.mjs` 子进程（不起 mvn），所以读数就是分类器的真实判定；
  // 临时目录里的 baseline 与生产 `cp-known-baseline.json` 无关，生产文件全程只读、不写。
  const blPkg = path.join(tmpRoot, 'bl-tree');
  const blReports = path.join(blPkg, 'surefire-reports');
  fsImpl.mkdirSync(blReports, { recursive: true });
  const blBaseline = path.join(tmpRoot, 'bl-baseline.json');
  /** head-time 取 1：临时报告永远「不比 HEAD 旧」，新鲜度门由 check-cp-baseline.test.mjs 单独覆盖。 */
  const blOpts = { root: ROOT, targetDir: blPkg, baselineFile: blBaseline, headTime: 1, fsImpl, log: silent };
  const writeBlReport = (lines) => {
    fsImpl.writeFileSync(
      path.join(blReports, 'com.acme.BlFixtureTest.txt'),
      ['Test set: com.acme.BlFixtureTest', ...lines, ''].join('\n'),
    );
  };
  const redLine = (name, kind) => `com.acme.BlFixtureTest.${name} -- Time elapsed: 0.01 s <<< ${kind}!`;
  check('基线分类：1 条已知基线红 ⇒「基线 1 / 新红 0」', () => {
    writeBlReport([
      'Tests run: 2, Failures: 1, Errors: 0, Skipped: 0',
      redLine('known', 'FAILURE'),
      'org.opentest4j.AssertionFailedError: boom',
    ]);
    fsImpl.writeFileSync(
      blBaseline,
      JSON.stringify({
        reviewedAt: '2026-11-22',
        entries: [
          { test: 'com.acme.BlFixtureTest.known', kind: 'fail', reason: 'fixture', reviewBy: '2999-01-01' },
        ],
      }),
    );
    const got = classifyBaseline(blOpts);
    assert(got.state === 'ok', JSON.stringify(got));
    assert(
      got.failures === 1 && got.baseline === 1 && got.fresh === 0,
      `期望 基线 1 / 新红 0，实得 ${JSON.stringify(got)}`,
    );
  });
  check('基线分类：1 条不在基线的红 ⇒「基线 0 / 新红 1」', () => {
    writeBlReport([
      'Tests run: 1, Failures: 1, Errors: 0, Skipped: 0',
      redLine('brandNew', 'FAILURE'),
      'org.opentest4j.AssertionFailedError: boom',
    ]);
    fsImpl.writeFileSync(blBaseline, JSON.stringify({ reviewedAt: '2026-11-22', entries: [] }));
    const got = classifyBaseline(blOpts);
    assert(got.state === 'ok', JSON.stringify(got));
    assert(
      got.failures === 1 && got.baseline === 0 && got.fresh === 1,
      `期望 基线 0 / 新红 1，实得 ${JSON.stringify(got)}`,
    );
  });
  check('基线分类：全绿 ⇒「基线 0 / 新红 0」', () => {
    writeBlReport(['Tests run: 3, Failures: 0, Errors: 0, Skipped: 0']);
    const got = classifyBaseline(blOpts);
    assert(got.state === 'ok', JSON.stringify(got));
    assert(
      got.failures === 0 && got.baseline === 0 && got.fresh === 0,
      `期望 基线 0 / 新红 0，实得 ${JSON.stringify(got)}`,
    );
  });
  check('基线分类：报告缺失 ⇒ 判「不可判定」且不改退出码（不冒充 0/0）', () => {
    const got = classifyBaseline({ ...blOpts, targetDir: path.join(tmpRoot, 'no-such-tree') });
    assert(got.state === 'indeterminate', JSON.stringify(got));
    assert(got.code === 2, `期望分类器 exit 2（缺证据），实得 ${got.code}`);
  });

  const failed = cases.filter((item) => !item.ok);
  for (const item of cases)
    log(`  ${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.ok ? '' : `：${item.error}`}`);
  log(`[selftest] ${cases.length - failed.length}/${cases.length} cases as expected`);
  try {
    fsImpl.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不影响判定（os.tmpdir 由系统回收）。
  }
  if (failed.length > 0) {
    log('[selftest] FAIL：上面标 FAIL 的判据必须修；不许靠放宽断言变绿');
    return 1;
  }
  log('[selftest] OK：锁（含不同 targetDir 放行）/ 探测 / 分类 / 主流程分支都按设计判定');
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  process.exit(main());
}
