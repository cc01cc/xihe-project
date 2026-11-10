#!/usr/bin/env node
/**
 * XH dev-stack — detached, turn-surviving full-stack supervisor (PLAN-0603 B′).
 *
 * Why: `mise run dev:host` is a foreground mise task; when the launching terminal /
 * agent turn ends the child tree is reaped. The ONE workspace's `ports.mjs dev xihe`
 * wrapper is detached but only starts services that declare a `runner` (xihe: UI only)
 * and always uses the main checkout as cwd; it is also outside this repo (PLAN-0612).
 * This supervisor launches CP / Agent /
 * Runtime / UI through the existing `scripts/stack-run.mjs` targets (which own the
 * per-service command, cwd and stack env derivation), keeps per-service logs and a
 * PID JSON, waits for HTTP readiness, and supports status / stop / residual checks.
 *
 * Contract:
 *   node scripts/dev-stack.mjs start   [--stack N] [--cwd <repo>] [--with-pg] [--json] [--timeout S]
 *   node scripts/dev-stack.mjs status  [--stack N] [--cwd <repo>] [--json] [--all]
 *   node scripts/dev-stack.mjs stop    [--stack N] [--cwd <repo>] [--with-pg] [--json]
 *   node scripts/dev-stack.mjs acquire [--stack N] [--cwd <repo>] [--json]
 *   node scripts/dev-stack.mjs release [--stack N] [--cwd <repo>] [--json]
 *   node scripts/dev-stack.mjs gc      [--stack N] [--cwd <repo>] [--json]
 *
 * Lease layer (PLAN-0694 P0):
 * - `start` writes `<root>/.xihe-stacks/<n>/lease.json` once the services are launched, `stop`
 *   releases it (or keeps it and marks `releaseFailed` when residual ports survive — never a
 *   silent delete). `acquire` adopts a stack that is already running (writes the current facts),
 *   `release` deletes only the lease file, `gc` is a **read-only** sweep: it reports orphan/ghost
 *   stacks plus the exact command to clean each one and never kills anything itself.
 * - `status` is not allowed to echo the lease: every field it shows has been cross-checked against
 *   independent facts (pid ⇄ alive, port ⇄ bind+owner, heartbeat ⇄ freshness, instanceId ⇄ this
 *   instance, cpVersion ⇄ the CP build actually running). `healthy` requires zero mismatches;
 *   anything that cannot be verified is reported as `unverifiable` and blocks `healthy`.
 * - The exit-code contract of `status`/`status --all --json` is unchanged: 0 = every stack
 *   healthy, 1 = some stack is not healthy (JSON still complete), 2 = bad args/env. `ok` is now
 *   the stricter reading of "healthy" (facts + cross-check), which can only turn 0 into 1 for a
 *   stack that is lying about itself.
 *
 * - Stack ports come from this repo's `scripts/lib/stack-ports.mjs` deriveStack() (PLAN-0612:
 *   the port fact source belongs to A03; no parent-directory lookup).
 * - Works from the main checkout and from `.worktrees/<name>`: project root defaults
 *   to the directory that contains this script; `--cwd` points it at another checkout.
 * - `stop` keeps PostgreSQL by default; pass `--with-pg` to stop the compose container
 *   (volumes are never removed).
 * - No `--next`: xihe uses explicit stack slots. Use `--stack <n>`.
 *
 * Zero dependencies, Node 24+.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARGO_TARGET_ROOT_ENV, cargoTargetForStack } from './lib/stack-cargo-target.mjs';
import { ensureEnvFromUser } from './lib/user-env.mjs';
import { cpBuildRoot, resolveBuildTargetForStack } from './lib/cp-build-dir.mjs';
import { cpBuildStatus, cpTargetDir, gitHead, shortSha } from './lib/cp-build-info.mjs';
import { buildCommitEnv, describeBuildCommit, resolveBuildCommit } from './lib/build-commit-env.mjs';
import { CP_NO_REBUILD_FLAG, describeCpNoRebuild, resolveCpNoRebuild, serviceArgs } from './lib/stack-cp-args.mjs';
import {
  DEFAULT_STALE_AFTER_MS,
  acquireLease,
  computeVerdict,
  crossCheckLease,
  leasePath,
  markReleaseFailed,
  readLease,
  releaseLease,
  renewLease,
  setLeasePhase,
} from './lib/stack-lease.mjs';
import { classifyListener, stackListeners, sweepOrphanProcesses } from './lib/stack-orphan.mjs';
import { buildAdoptedRecord, deadRecordedServices } from './lib/stack-adopt.mjs';
import { STACK_IDS, deriveStack, normalizeStackArg } from './lib/stack-ports.mjs';
import {
  assertPasswordString,
  buildResetAdminCommand,
  devAdminPasswordFrom,
  formatDevAdminPassword,
  resetAdminEnv,
  resetAdminWrapperPath,
  resolveDevAdminPasswordSafe,
  resolveLocalMode,
} from './lib/dev-admin-password.mjs';
import { assertEnvValues, makeChildEnv } from './lib/env-values.mjs';

// task-234 B：DSH 子 shell 不继承 User 级 env ⇒ 直启时 process.env 里没有
// `XH_CARGO_TARGET_ROOT`，cargo 会回落 `<one>/.tmp/cargo-target` 使单根不变量失效。
// 这里在**任何派生/起进程之前**兜底读一次 HKCU\Environment（fail-open：读不到就保持原行为）。
ensureEnvFromUser(CARGO_TARGET_ROOT_ENV);

const scriptPath = fileURLToPath(import.meta.url);
const scriptProjectRoot = resolve(dirname(scriptPath), '..');
const isWindows = process.platform === 'win32';
const SERVICES = ['cp', 'runtime', 'agent', 'ui'];
const ENDPOINTS = {
  cp: '/api/v1/auth/bootstrap-status',
  runtime: '/health',
  agent: '/internal/v1/agent/health',
  ui: '/',
};

/* ------------------------------------------------------------------ args */

function usage(exitCode = 2) {
  console.log('usage: node scripts/dev-stack.mjs <start|status|stop|acquire|release|gc> [options]');
  console.log('  --stack N        stack id (stack-1..stack-8); default XIHE_STACK_ID or stack-1');
  console.log('  --cwd <repo>     checkout to run (default: this script\'s project root)');
  console.log('  --with-pg        start (start) / stop (stop) this stack\'s PostgreSQL container');
  console.log('  --timeout <s>    readiness timeout for start (default 300)');
  console.log('  --json           machine-readable output');
  console.log('  --all            status: overview of EVERY stack that has a pid file or a listening port');
  console.log('  --help           this message');
  console.log('');
  console.log('lease verbs (PLAN-0694 P0; lease lives at <root>/.xihe-stacks/<n>/lease.json):');
  console.log('  acquire   adopt a stack that is already running: write the lease AND the pid record from');
  console.log('            CURRENT facts (task-76: status reads alive from the pid record, so lease-only');
  console.log('            adoption left every adopted stack permanently "not fully up")');
  console.log('            (refuses when no profile-matched listener exists — nothing to adopt)');
  console.log('  release   delete the lease file only; never stops anything');
  console.log('  gc        read-only sweep: report orphan/ghost stacks + the exact cleanup command;');
  console.log('            never kills, never deletes. exit 0 = nothing to collect, 1 = candidates');
  console.log('');
  console.log('status adds `lease` + `verdict` (PLAN-0694 P0) next to the existing contract fields:');
  console.log('  verdict         healthy | stale | orphan | ghost | null(未运行) — from lease+bind+pid');
  console.log('  lease.checks    每个租约字段一条「声明 vs 独立事实」的核对结果');
  console.log('  lease.mismatch  核不上的字段（非空 ⇒ 不可能 healthy）；unverifiable = 声明了却核不了');
  console.log('  ok              false unless facts are up AND every lease field verifies');
  console.log('');
  console.log('status adds `cpBuild` (PLAN-0662 L4; **field names are a contract** for lane scripts):');
  console.log('  runningCommit   stamped commit of the classes this stack\'s CP runs (null = no stamp)');
  console.log('  headCommit      git rev-parse HEAD of this checkout (null = git unavailable)');
  console.log('  behind          git rev-list --count runningCommit..headCommit (null = unknown)');
  console.log('  stale           true when the classes are provably not from HEAD (verdict stale|missing)');
  console.log('  verdict         fresh | stale | dirty | missing | unverified (same vocabulary as the start gate)');
  console.log('                  dirty = commit matches HEAD but the stamp says the tree was dirty at build time;'
    + ' BL-325: treat it as NOT fresh (never as stale)');
  console.log('  targetDirSource pointer | newest | env | derived — where targetDir came from');
  console.log('                  (pointer =该栈 .current 记录的最后一次启动目录；newest = 磁盘最新构建槽；');
  console.log('                   env = 显式 XIHE_CP_TARGET_DIR；derived = 尚未构建时按 HEAD 推出的路径)');
  console.log('  builtAt, dirty, targetDir, file   stamp metadata / where it was read from');
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { action: 'status', stack: undefined, cwd: undefined, withPg: false, json: false, all: false, timeout: 300 };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    else if (arg === '--json') args.json = true;
    else if (arg === '--all') args.all = true;
    else if (arg === '--with-pg') args.withPg = true;
    // `gc` 永远 dry-run（P0 不给自动化口），`--dry-run` 只是让调用方把意图写明，不改变行为。
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--stack' || arg === '--stack=') {
      args.stack = arg.includes('=') ? arg.slice('--stack='.length) : argv[(i += 1)];
    } else if (arg.startsWith('--stack=')) args.stack = arg.slice('--stack='.length);
    else if (arg === '--cwd') args.cwd = argv[(i += 1)];
    else if (arg.startsWith('--cwd=')) args.cwd = arg.slice('--cwd='.length);
    // G12 反证逃生门（task-154）：把 `--no-rebuild` 透传给 cp 子进程；默认关闭。
    else if (arg === CP_NO_REBUILD_FLAG) args.cpNoRebuild = true;
    else if (arg === '--timeout') args.timeout = Number(argv[(i += 1)]);
    else if (arg.startsWith('--timeout=')) args.timeout = Number(arg.slice('--timeout='.length));
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else rest.push(arg);
  }
  if (rest.length > 0) args.action = rest[0];
  if (!['start', 'status', 'stop', 'acquire', 'release', 'gc'].includes(args.action)) usage(2);
  // `gc` is a sweep tool: without an explicit --stack it inspects every registered stack.
  args.explicitStack = args.stack !== undefined || process.env.XIHE_STACK_ID !== undefined;
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error('--timeout must be a positive number of seconds');
  return args;
}

/* ---------------------------------------------------------- stack ports */

/* Ports/derived paths come from the in-repo module (PLAN-0612). */

/* ---------------------------------------------------------------- utils */

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function isPortListening(port, timeoutMs = 500) {
  return new Promise((done) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      done(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function httpStatus(url, timeoutMs = 1500) {
  return new Promise((done) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      done(response.statusCode ?? 0);
    });
    request.once('timeout', () => {
      request.destroy();
      done(null);
    });
    request.once('error', () => done(null));
  });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandLine(pid) {
  if (!isWindows) return '';
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
    { encoding: 'utf8', windowsHide: true },
  );
  return result.status === 0 ? String(result.stdout || '') : '';
}

/** The recorded PID is the cmd.exe wrapper started by `start`; never kill pid-reused strangers. */
function looksLikeOurWrapper(pid) {
  if (!isWindows) return true;
  const line = commandLine(pid);
  return /stack-run\.mjs/i.test(line);
}

/* ------------------------------------------------- orphan sweep (PLAN-0656 R3) */

// PLAN-0656 R3: kill ORPHANED processes of this stack (a crashed/partial stop leaves the
// runtime holding our port, so the next `start` fails with "port already in use"). The
// sweep itself is shared with `stack-run.mjs` (PLAN-0656 R5: the `dev:host` path) and
// lives in `scripts/lib/stack-orphan.mjs`; see that file for the ownership contract
// (stack port + service identity profile; foreign occupants are warned, never killed).

async function waitForPortFree(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortListening(port))) return true;
    await sleep(250);
  }
  return !(await isPortListening(port));
}


function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function checkProjectRoot(projectRoot) {
  const missing = ['packages/control-plane', 'packages/runtime', 'packages/agent', 'packages/ui', 'scripts/stack-run.mjs'].filter(
    (rel) => !existsSync(join(projectRoot, rel)),
  );
  if (missing.length > 0) {
    throw new Error(`not an A03-xihe checkout (missing ${missing.join(', ')}): ${projectRoot}`);
  }
}

function tableRows(rows, columns) {
  const lines = [];
  for (const column of columns) lines.push(column);
  return lines;
}

/**
 * PLAN-0662 L4 + BL-253 L3: build freshness of **this stack's** CP build.
 *
 * With per-stack build dirs a single env-derived path is no longer the answer, so this reads the
 * same facts the launcher wrote: the stack's `.current` pointer first, then the newest build slot
 * on disk, then the computed target (explicit `XIHE_CP_TARGET_DIR` or derived from HEAD).
 * `targetDirSource` says which of those answered, so an operator can tell "the stack's last start
 * used this dir" from "we guessed what a start *would* use".
 *
 * Read-only: it never rebuilds and never touches a stack — it only reports `verdict`.
 */
function cpBuildFor(root = projectRoot, stackId = derived.stackId) {
  const head = gitHead({ cwd: root });
  const target = resolveBuildTargetForStack({
    root: cpBuildRoot({ env: process.env }),
    stackId,
    env: process.env,
    commit: head.commit,
    dirty: head.dirty,
  });
  return cpBuildStatus({
    targetDir: target.targetDir ?? cpTargetDir({ projectRoot: root, env: process.env }),
    headCommit: head.commit,
    cwd: root,
    targetDirSource: target.source,
  });
}

function formatCpBuild(cpBuild) {
  return (
    `commit=${shortSha(cpBuild.runningCommit) || '(none)'}`
    + ` head=${shortSha(cpBuild.headCommit) || '(unknown)'}`
    + ` behind=${cpBuild.behind ?? '?'} stale=${cpBuild.stale} verdict=${cpBuild.verdict}`
    + ` built=${cpBuild.builtAt || '(none)'}`
    + ` dirty=${cpBuild.dirty === null ? '?' : cpBuild.dirty}`
    + ` source=${cpBuild.targetDirSource}`
    + ` target=${cpBuild.targetDir}`
  );
}

/* --------------------------------------------------------------- context */

// 参数错误恒 exit 2（design「退出码与输出契约」）：顶层 throw 会落到 Node 的未捕获异常（exit 1 +
// 栈帧），既不符合契约也难读 —— 所以在解析这一层就兜住，和下面的 context 错误同一口径。
let args;
// G12 反证开关：flag 与 env 只允许一个来源（同时给出直接抛错，见 lib/stack-cp-args.mjs）。
let cpNoRebuild = { active: false, source: null };
try {
  args = parseArgs(process.argv.slice(2));
  cpNoRebuild = resolveCpNoRebuild({ flag: args.cpNoRebuild === true, env: process.env });
} catch (error) {
  console.error(`[dev-stack] ERROR: ${error.message}`);
  process.exit(2);
}
const derived = (() => {
  try {
    return deriveStack(normalizeStackArg(args.stack ?? process.env.XIHE_STACK_ID ?? undefined));
  } catch (error) {
    console.error(`[dev-stack] ERROR: ${error.message}`);
    process.exit(2);
  }
})();
const projectRoot = resolve(args.cwd ?? scriptProjectRoot);
try {
  checkProjectRoot(projectRoot);
} catch (error) {
  console.error(`[dev-stack] ERROR: ${error.message}`);
  process.exit(2);
}
const logDir = resolve(projectRoot, derived.logDir);
const pidFile = join(logDir, 'dev-stack-pids.json');
const stackRun = join(projectRoot, 'scripts', 'stack-run.mjs');
const ports = derived.ports;
// task-56（BL-527 同类风险）：子进程 env 走**单一出口**并冻结 —— 任何散点赋值
// （如 `childEnv.X = <对象>`）在这里立刻 TypeError，而不是被 Node `String()` 静默强转成
// "[object Object]" 传给子进程（那正是 BL-527 把一个 15 字符串写进库的通道）。
// G12（task-154）：把本栈 CP build-info 的戳翻成 `XIHE_BUILD_COMMIT`，注入 cp/agent/runtime 三个子进程。
// env-first（PLAN-0534）契约不变：项目侧仍只读 env，CP/agent/runtime 代码一行不动 —— 用户裁定 (a)
// 运维面注入，**禁止 (a)(b) 各修一半**（那会造出「两个来源两个值」的新假信号）。
// 三个服务共用这一个 childEnv ⇒「三处一致」由构造保证，而不是三处各写一遍。
// 缺失/非法 ⇒ 注入空串（`buildCommitEnv` 恒返回一个键）而不是跳过：跳过会让「没有字段」和「值为空」
// 两种状态混在一起，运维面就分不清了。
const stackBuildCommit = resolveBuildCommit({ targetDir: cpBuildFor(projectRoot).targetDir });
let childEnv = makeChildEnv({
  stackId: derived.stackId,
  env: process.env,
  extra: buildCommitEnv(stackBuildCommit),
});

/* ------------------------------------------------------- lease (PLAN-0694) */

// 三层真相：租约（意图）/ 监听（事实）/ pid（佐证）。本段只做**采集与合成**；判定逻辑全在
// `scripts/lib/stack-lease.mjs`（纯函数、可单测、不碰系统），这里不重复实现任何阈值。

/**
 * 本实例身份：同一台机器 + 同一棵 checkout（`XIHE_INSTANCE_ID` 可覆盖）。
 * 用途是回答「这份租约是不是**我**写的」——租约里任何字段都必须能被核对，实例身份也一样。
 */
const instanceId =
  process.env.XIHE_INSTANCE_ID ?? `${hostname().toLowerCase()}@${projectRoot.replaceAll('\\', '/').toLowerCase()}`;

/**
 * 租约声明哪些端口：只声明本 supervisor **自己起**的 4 个服务。
 *
 * PostgreSQL 由 compose 管理、默认常驻（`stop` 不带 `--with-pg` 就不动它），持有它的进程是 docker
 * 而非本栈画像进程——塞进租约只会造出「声明了却永远核不上」的字段（那就是注释），所以 PG 仍只在
 * `status.pg` 里独立呈现。
 */
function leasePorts(p = ports) {
  return Object.fromEntries(SERVICES.map((service) => [service, p[service]]));
}

/** 采集端口归属：画像匹配的归 own，其余归 external（external 只作附注，不参与四值判定）。 */
function listenFacts(p = ports) {
  const own = [];
  const external = [];
  for (const listener of stackListeners(Object.values(p))) {
    const decision = classifyListener(listener, { ports: p });
    if (decision.kind === 'unsupported') break;
    // task-76: startedAt 必须带出来——acquire 要把它写进 pid 记录（进程真实启动时刻），
    // 丢在这里就会退化成「认领时刻」，重复 acquire 也就没法幂等。
    const base = {
      port: listener.port,
      pid: listener.pid,
      name: listener.name ?? '',
      service: decision.service ?? null,
      startedAt: listener.startedAt ?? null,
    };
    if (decision.kind === 'kill') own.push(base);
    else external.push({ ...base, cmdline: listener.cmdline ?? '' });
  }
  return { own, external };
}

/** 当前 CP 构建戳 commit：CP 实际在跑的 classes 来自哪个 commit（读不到 = null，不猜）。 */
function currentCpVersion() {
  try {
    return cpBuildFor(projectRoot).runningCommit ?? null;
  } catch {
    return null;
  }
}

/** 从 pid 记录 + 当前监听拼「当时观测到的进程」：没观测到就不写（absent claims are fine）。 */
function observedPids(record, listeners, p = ports) {
  const pids = {};
  for (const service of SERVICES) {
    const launcher = record?.services?.[service]?.pid ?? null;
    const listener = listeners.own.find((entry) => entry.port === p[service])?.pid ?? null;
    if (launcher === null && listener === null) continue;
    pids[service] = { launcher, listener };
  }
  return pids;
}

/** 写租约（`start` 起栈后 / `acquire` 认领在跑的栈）。写的是声明，`status` 会逐字段核对。 */
function writeLease({ d = derived, p = ports, record, phase = 'started' }) {
  const listeners = listenFacts(p);
  const lease = acquireLease({
    projectRoot,
    stackId: d.stackId,
    ports: leasePorts(p),
    pids: observedPids(record, listeners, p),
    instanceId,
    cpVersion: currentCpVersion(),
    now: Date.now(),
    phase,
  });
  return { lease, listeners, path: leasePath(projectRoot, d.stackId) };
}

/**
 * 起栈前先「认领」（task-75）：只声明 ports/instanceId + `phase:"starting"`，**不探监听**。
 *
 * 为什么必须在 spawn 之前写：实测启动头 40 秒里（`stack1=2/4` 观测于 03:52:05，而租约
 * `startedAt` 是 03:52:45）栈既没就绪、也没有租约 ⇒ 10 分钟层的「端口不全」必然误报成 P1。
 * 租约语义本来就是「有人认领了这个栈」，认领的时刻应当是 spawn 之前，而不是 `waitReady` 之后。
 */
function claimStarting({ d = derived, p = ports, record = null } = {}) {
  const lease = acquireLease({
    projectRoot,
    stackId: d.stackId,
    ports: leasePorts(p),
    pids: observedPids(record, { own: [] }, p),
    instanceId,
    cpVersion: null,
    now: Date.now(),
    phase: 'starting',
  });
  return { lease, path: leasePath(projectRoot, d.stackId) };
}

/**
 * 一次完整的「租约 vs 事实」快照：读租约 → 逐字段核对 → 合成 verdict。
 * `status` / `status --all` / `gc` / `acquire` 共用同一条判定链路，避免四处各判一套。
 */
function leaseState({ d = derived, p = ports, listeners = null, cpVersion = undefined } = {}) {
  const now = Date.now();
  const path = leasePath(projectRoot, d.stackId);
  const facts = listeners ?? listenFacts(p);
  const { lease, corrupt } = readLease(path);
  const checks = crossCheckLease({
    lease,
    facts: {
      stackId: d.stackId,
      instanceId,
      projectRoot,
      expectedPorts: leasePorts(p),
      listeners: facts,
      isAlive: processAlive,
      cpVersion: cpVersion === undefined ? currentCpVersion() : cpVersion,
      now,
    },
  });
  const alivePids = Object.values(lease?.pids ?? {})
    .flatMap((entry) => [entry?.launcher, entry?.listener])
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  const verdict = computeVerdict({
    lease,
    listeners: facts,
    corrupt,
    pidAlive: alivePids.some((pid) => processAlive(pid)),
    checks: checks.checks,
    now,
  });
  return { path, lease, corrupt, checks, verdict, listeners: facts };
}

/** 租约的机器可读摘要（JSON 输出用；字段即契约，别改语义）。 */
function leaseSummary(state) {
  return {
    path: state.path,
    exists: state.lease !== null || state.corrupt,
    corrupt: state.corrupt,
    instanceId: state.lease?.instanceId ?? null,
    startedAt: state.lease?.startedAt ?? null,
    heartbeatAt: state.lease?.heartbeatAt ?? null,
    ageMs: state.verdict.leaseAgeMs,
    fresh: state.verdict.leaseFresh,
    // 冷暖：`live` = 最近 TTL 内做过交叉核对；`cold` = 超 TTL 没人核对（信息项，与 verdict 无关）。
    state: state.verdict.leaseState,
    cpVersion: state.lease?.cpVersion ?? null,
    pids: state.lease?.pids ?? null,
    releaseFailed: state.lease?.releaseFailed ?? null,
    checks: state.checks.checks,
    mismatch: state.checks.mismatches,
    unverifiable: state.checks.unverifiable,
    skipped: state.checks.skipped,
    allOk: state.checks.allOk,
  };
}

/**
 * 核对全绿 ⇒ 刷新心跳，返回是否刷新。
 *
 * `heartbeatAt` 的语义是「最近一次**核对通过**的时间」，不是「进程还活着」的自述——后者正是本计划
 * 要消灭的那类字段。所以刷新只发生在 `status` 真的核过事实之后，且结果显式出现在输出
 * （`leaseRenewed`）里，不静默改状态。`gc` 是只读口子，绝不写。
 */
function refreshHeartbeat(state, d = derived) {
  if (!state.lease || state.checks.mismatches.length > 0 || state.checks.unverifiable.length > 0) return false;
  if (state.verdict.verdict !== 'healthy') return false;
  return renewLease({ projectRoot, stackId: d.stackId }).renewed;
}

/** 租约已冷时的 P3 提示文案（信息项：不改 verdict、不改退出码）。 */
function coldLeaseHint({ leaseState, ageMs }) {
  if (leaseState !== 'cold' || !Number.isFinite(ageMs)) return null;
  const ageMin = Math.round(ageMs / 60000);
  const ttlMin = Math.round(DEFAULT_STALE_AFTER_MS / 60000);
  return `P3 lease-cold  ${ageMin}min > ${ttlMin}min：这段时间没人跑过一次交叉核对（不是故障，不影响 verdict/退出码；跑一次 status 全绿即自动续租）`;
}

/** 把租约核对结果打成人类可读的几行（非 --json 输出）。 */
function printLease(state, { indent = '  ' } = {}) {
  const { verdict, reasons } = state.verdict;
  console.log(`${indent}verdict  ${verdict ?? '-'} (${reasons.join(' ') || 'no signals'})`);
  console.log(
    `${indent}lease    ${state.path} exists=${state.lease !== null || state.corrupt}` +
      ` corrupt=${state.corrupt} instance=${state.lease?.instanceId ?? '-'}` +
      ` heartbeat=${state.lease?.heartbeatAt ?? '-'} age=${state.verdict.leaseAgeMs ?? '-'}ms` +
      ` cpVersion=${state.lease?.cpVersion ?? '-'} startedAt=${state.lease?.startedAt ?? '-'}` +
      ` state=${state.verdict.leaseState ?? '-'}`,
  );
  const cold = coldLeaseHint({ leaseState: state.verdict.leaseState, ageMs: state.verdict.leaseAgeMs });
  if (cold) console.log(`${indent}  ${cold}`);
  for (const check of state.checks.checks) {
    if (check.code === 'ok' || check.code === 'skipped' || check.code === 'lease-cold') continue;
    console.log(`${indent}  ${check.code.padEnd(22)} ${check.field} expected=${JSON.stringify(check.expected)} actual=${JSON.stringify(check.actual)}`);
  }
  if (state.checks.checks.length > 0 && state.checks.mismatches.length === 0 && state.checks.unverifiable.length === 0) {
    console.log(`${indent}  all ${state.checks.checks.length} lease fields verified`);
  }
}

/* ---------------------------------------------------------------- spawn */

function spawnDetached(service, outPath, errPath) {
  // 默认 args 与原先逐字节相同；只有反证开关生效时 cp 才多一个 `--no-rebuild`（见 lib/stack-cp-args.mjs）。
  const childArgs = serviceArgs({ stackRun, service, noRebuild: cpNoRebuild.active });
  const inner = `node "${stackRun}" ${childArgs.slice(1).join(' ')}`;
  if (isWindows) {
    const safeCwd = projectRoot.replace(/'/g, "''");
    const script =
      `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/s','/c','${inner.replace(/'/g, "''")} 1> "${outPath.replace(/'/g, "''")}" 2> "${errPath.replace(/'/g, "''")}"' ` +
      `-WorkingDirectory '${safeCwd}' -WindowStyle Hidden -PassThru; $p.Id`;
    return new Promise((done) => {
      assertEnvValues(childEnv, 'spawn:powershell-launcher');
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.once('error', () => done(null));
      child.once('exit', () => {
        const pid = Number(stdout.trim().split(/\r?\n/).pop());
        done(Number.isInteger(pid) && pid > 0 ? pid : null);
      });
    });
  }
  const outFd = openSync(outPath, 'a');
  const errFd = openSync(errPath, 'a');
  assertEnvValues(childEnv, 'spawn:' + service);
  const child = spawn(process.execPath, childArgs, {
    cwd: projectRoot,
    env: childEnv,
    detached: true,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
  });
  child.unref();
  closeSync(outFd);
  closeSync(errFd);
  return Promise.resolve(child.pid ?? null);
}

/* -------------------------------------------------------------- readiness */

async function probeService(service, d = derived, p = ports) {
  const listening = await isPortListening(p[service]);
  if (!listening) return { service, port: p[service], listening, status: null, ready: false };
  const status = await httpStatus(`http://127.0.0.1:${p[service]}${ENDPOINTS[service]}`);
  const ready = status !== null && status < 500;
  return { service, port: p[service], listening, status, ready };
}

async function waitReady(timeoutSeconds, servicesToWait) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const state = {};
  while (Date.now() < deadline) {
    let allReady = true;
    for (const service of servicesToWait) {
      const result = await probeService(service);
      state[service] = result;
      if (!result.ready) allReady = false;
    }
    if (allReady) return { ready: true, state };
    if (!args.json) {
      const parts = servicesToWait.map((s) => `${s}=${state[s].ready ? 'ready' : state[s].listening ? 'http?' : 'port?'}`);
      console.log(`[dev-stack] waiting ${Math.round((deadline - Date.now()) / 1000)}s: ${parts.join(' ')}`);
    }
    await sleep(3000);
  }
  for (const service of servicesToWait) state[service] ??= await probeService(service);
  return { ready: servicesToWait.every((s) => state[s].ready), state };
}

/* ------------------------------------------------------------------- pg */

async function ensurePg() {
  if (!args.withPg) {
    if (!(await isPortListening(ports.postgres))) {
      throw new Error(
        `PostgreSQL is not listening on ${ports.postgres}; re-run with --with-pg (or start this stack's PG first)`,
      );
    }
    return { started: false, listening: true };
  }
  console.log(`[dev-stack] starting PostgreSQL for ${derived.stackId} (compose project ${derived.composeProject}) ...`);
  assertEnvValues(childEnv, 'spawn:postgres');
  const result = spawnSync(process.execPath, [stackRun, 'pg', '--stack', derived.stackId], {
    cwd: projectRoot,
    env: childEnv,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`PostgreSQL start failed (exit ${result.status}); see docker compose output above`);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await isPortListening(ports.postgres)) return { started: true, listening: true };
    await sleep(1000);
  }
  throw new Error(`PostgreSQL did not listen on ${ports.postgres} within 60s`);
}

async function stopPg() {
  console.log(`[dev-stack] stopping PostgreSQL for ${derived.stackId} (compose project ${derived.composeProject}; volume kept) ...`);
  const result = spawnSync('docker', ['compose', '-p', derived.composeProject, 'stop', 'postgres'], {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`failed to stop PostgreSQL (exit ${result.status})`);
}

/* ---------------------------------------------------------------- start */

/**
 * D-766 乙案最小版：让**存量库**也用上本轮注入的 dev 管理员密码。
 *
 * 为什么必须补这一步：`DataSeeder` 只在 `admin@xihe.local` 不存在时按
 * `XIHE_DEV_ADMIN_PASSWORD` 建行（只建不更）——存量库还挂着某个旧随机密码，
 * 起了栈也登不上，正是这张卡要消掉的空转。这里复用**既有**入口
 * `scripts/reset-admin.ps1`（内部 `ResetAdmin.java` 走 UPDATE/INSERT upsert），
 * 不新写 SQL，也不碰产品代码。
 *
 * 秘密面：密码只从子进程 env（`$env:XIHE_DEV_ADMIN_PASSWORD`）读，不进命令行；
 * 日志只打非密元数据（栈/字符数/耗时），**绝不打印密码值**。
 *
 * 失败**不阻塞起栈**：四端口就绪才是 `start` 的既有契约。失败给 WARN + 显式补救命令，
 * 让操作者能修，而不是把一次 upsert 失败升级成「栈起不来」。
 */
function applyDevAdminPassword(adminPassword) {
  // BL-527 护栏 A：这一层只接受**字符串**密码。事故就是解析结果对象从这里漏进 env 的，
  // 所以入口再断言一次（调用方已用 devAdminPasswordFrom() 取值，这里是第二道闸）。
  const password = assertPasswordString(adminPassword, "applyDevAdminPassword(adminPassword)");
  // local mode（PLAN-0526）的设计前提是「零用户首启」：此时 upsert 会凭空造出 admin 行，
  // 破坏首启引导语义，必须跳过。
  //
  // 判定必须与 CP 同口径：**OS env 优先，其次 `.env` 链**（D-770 / W-22 verify 发现）。
  // CP 的 DotenvLoader 把 `.env*` 读进 system properties，所以「只在 `.env.local` 写
  // XIHE_LOCAL_MODE=true」时 CP 真的进了 local mode —— 这里只读 process.env 就会漏判。
  const localMode = resolveLocalMode({ env: childEnv, cwd: projectRoot });
  if (localMode.enabled) {
    console.log(
      `[dev-stack] dev admin upsert: skipped (XIHE_LOCAL_MODE=true via ${localMode.source} keeps the first-run zero-user state)`,
    );
    return { ok: false, skipped: 'local-mode' };
  }
  if (!isWindows) {
    console.log('[dev-stack] dev admin upsert: skipped (scripts/reset-admin.ps1 is Windows-only); run `mise run reset-admin` manually');
    return { ok: false, skipped: 'non-windows' };
  }
  const wrapper = resetAdminWrapperPath(projectRoot);
  const { args: psArgs } = buildResetAdminCommand({ wrapperPath: wrapper, stackId: derived.stackId });
  // BL-523：密码**只经 env** 传给入口（`XIHE_RESET_ADMIN_PASSWORD`，ResetAdmin 内部优先级
  // stdin > env > --password），argv 里不再出现明文 —— 进程表 / shell 历史都看不到。
  const upsertEnv = assertEnvValues(resetAdminEnv({ env: childEnv, password }), 'spawn:reset-admin');
  const startedAt = Date.now();
  let result = spawnSync('pwsh', psArgs, {
    cwd: projectRoot,
    env: upsertEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  });
  // pwsh 7 不一定装（mise 任务用 pwsh，但 DSH/裸 shell 下的宿主可能只有 5.1）：ENOENT 时退回
  // powershell.exe，命令体对两者通用（`-Command`）。
  if (result.error?.code === 'ENOENT') {
    result = spawnSync('powershell.exe', psArgs, {
      cwd: projectRoot,
      env: upsertEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
    });
  }
  const elapsed = Date.now() - startedAt;
  if (result.status === 0 && !result.error) {
    // BL-527 护栏 A（可观测）：把 **java 自己报的 `source=` 行回显出来**。
    // 事故当时 java 的输出只在失败时摘尾，于是「库里的密码来自哪个通道」没有任何信号；
    // 现在成功也回显（该行只含来源/邮箱，**不含密码值**）。
    const javaLine = [result.stdout, result.stderr]
      .map((chunk) => String(chunk ?? ""))
      .join("\n")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("[reset-admin]") && /source=/.test(line) && !line.includes("XIHE_RESET_ADMIN_PASSWORD"));
    if (javaLine) console.log(`[dev-stack] ${javaLine}`);
    console.log(
      `[dev-stack] dev admin upsert: ok stack=${derived.stackId} length=${password.length} (value not logged, ${elapsed}ms)`,
    );
    return { ok: true };
  }
  // exit 3 = ResetAdmin 显式报告「用户行不存在」（BL-523：不再自建 admin 行），指向建行路径。
  const userMissing = result.status === 3;
  console.warn(
    `[dev-stack] dev admin upsert: FAILED (exit ${result.status ?? 'spawn-error'}${result.error ? `, ${result.error.code}` : ''}, ${elapsed}ms) — `
      + (userMissing
        ? 'the admin user row does not exist in this database; run `mise run dev:reset` or restart the stack so CP DataSeeder creates it, then re-run `start`.'
        : 'the stack is up, but the injected password may not match this database yet; run `mise run reset-admin` (or re-run `start`) to repair.'),
  );
  // 摘最后几行便于定位（密码只走 env、stdin，入口不回显；仍只摘尾部并限行数）。
  for (const chunk of [result.stdout, result.stderr]) {
    const text = String(chunk ?? '').trim();
    if (text === '') continue;
    console.warn(text.split(/\r?\n/).slice(-3).join('\n'));
  }
  return { ok: false };
}

async function start() {
  mkdirSync(logDir, { recursive: true });
  console.log(
    `[dev-stack] ${args.action} ${derived.stackId} cwd=${projectRoot} ports ui=${ports.ui} cp=${ports.cp} agent=${ports.agent} runtime=${ports.runtime} pg=${ports.postgres}`,
  );
  console.log(`[dev-stack] logs: ${logDir}`);
console.log(`[dev-stack] ${'XIHE_BUILD_COMMIT'}=${stackBuildCommit.value === '' ? '(空串)' : stackBuildCommit.value} — ${describeBuildCommit(stackBuildCommit)}（注入 cp/agent/runtime 三个子进程；env-first，项目侧只读 env）`);
if (cpNoRebuild.active) console.log(`[dev-stack] WARN ${describeCpNoRebuild(cpNoRebuild)}`);
  // D-766 乙案最小版：起栈前把**确定性**的 dev 管理员密码注入子进程环境（CP 的
  // DataSeeder 读 `XIHE_DEV_ADMIN_PASSWORD`），存量库的更新由 waitReady 之后的
  // reset-admin upsert 补上（见 applyDevAdminPassword）。0 产品面改动。
  // 日志只打来源/字符数/落盘路径 —— **绝不打印密码值**。
  //
  // D-770 / W-22 verify：解析或落盘失败发生在 spawn **之前**，原来会直接打断起栈（与文档承诺的
  // 「密码链路失败不阻塞起栈」不一致）。这里降级为 WARN + 跳过注入，`start` 继续走。
  const devAdmin = resolveDevAdminPasswordSafe({ projectRoot });
  // BL-527：这里**必须取 `.password` 字符串**。事故版本写的是 `devAdmin.ok ? devAdmin : null`，
  // 于是「解析结果对象」被塞进 `XIHE_RESET_ADMIN_PASSWORD`，Node 强转成 `"[object Object]"`
  // （15 字符，绕过 ResetAdmin 的 <12 位告警）写进库 ⇒ 任何真实密码登录都 401。
  // `devAdminPasswordFrom()` 只返回 string|null，拿不到就跳过 upsert（绝不传对象）。
  const devAdminPassword = devAdminPasswordFrom(devAdmin);
  if (devAdmin.ok) {
    // 冻结对象不能原地赋值：改走「复制 → 断言 → 替换」，仍然是单一出口。
    childEnv = Object.freeze({ ...childEnv, XIHE_DEV_ADMIN_PASSWORD: devAdmin.password });
    assertEnvValues(childEnv, 'childEnv+devAdminPassword');
    console.log(formatDevAdminPassword(devAdmin));
  } else {
    console.warn(
      `[dev-stack] dev admin password: unavailable (${devAdmin.reason}) — continuing WITHOUT injection; `
        + 'run `mise run reset-admin` if you need to log in to this stack.',
    );
  }
  const cargoTarget = cargoTargetForStack({ stackId: derived.stackId, projectRoot, env: process.env });
  console.log(
    `[dev-stack] cargo target: ${cargoTarget ? `${cargoTarget} (per-stack)` : 'default .cargo/config.toml target (shared warm cache)'}`,
  );

  const pg = await ensurePg();
  const previous = readJson(pidFile) ?? {};
  const record = {
    stackId: derived.stackId,
    projectRoot,
    startedAt: previous.startedAt ?? new Date().toISOString(),
    pgStarted: pg.started || Boolean(previous.pgStarted),
    services: {},
  };

  // task-75：**spawn 之前**先认领（phase=starting），`waitReady` 通过后再翻成 started。
  // 这一段窗口（实测可达 40 s）里端口从 0 逐步涨到 4，期间没有任何租约 ⇒ 10 分钟层只能
  // 按「无主半起」报 P1。租约语义是「有人认领了这个栈」，认领时刻本就在进程之前。
  const claimed = claimStarting({ record });
  console.log(`[dev-stack] lease: phase=starting claimed before spawn (${claimed.path})`);

  for (const service of SERVICES) {
    const prior = previous.services?.[service];
    if (prior?.pid && processAlive(prior.pid) && looksLikeOurWrapper(prior.pid)) {
      record.services[service] = prior;
      console.log(`[dev-stack] ${service} already running (pid ${prior.pid})`);
      continue;
    }
    if (await isPortListening(ports[service])) {
      // PLAN-0656 R3: a leftover process of THIS stack (e.g. the runtime orphaned by a
      // crashed stop) is cleaned here instead of failing the whole start; foreign
      // occupants are only reported, so the original error below still surfaces.
      sweepOrphanProcesses({ derived, reason: 'start' });
      if (!(await waitForPortFree(ports[service]))) {
        throw new Error(
          `${service}: port ${ports[service]} is already in use by another process; stop it or use a different --stack`,
        );
      }
      console.log(`[dev-stack] ${service} port ${ports[service]} freed by the orphan sweep; continuing`);
    }
    const outPath = join(logDir, `${service}.out.log`);
    const errPath = join(logDir, `${service}.err.log`);
    const pid = await spawnDetached(service, outPath, errPath);
    if (!pid) throw new Error(`${service}: launcher failed; see ${outPath} / ${errPath}`);
    record.services[service] = { pid, port: ports[service], startedAt: new Date().toISOString() };
    writeJson(pidFile, record);
    console.log(`[dev-stack] started ${service} (pid ${pid}) port=${ports[service]} log=${outPath}`);
  }
  writeJson(pidFile, record);
  console.log(`[dev-stack] pid file: ${pidFile}`);
  console.log(`[dev-stack] note: CP compiles on boot (~60-120s); Runtime uses the cargo cache; waiting for readiness ...`);

  const { ready, state } = await waitReady(args.timeout, SERVICES);
  // PLAN-0694 P0: 起栈后写租约——记录「谁、在哪、哪些 pid、CP 什么版本」的**声明**。
  // 写完不做自证；能不能算健康由 `status` 拿独立事实逐字段核对（核对不上就是 stale）。
  // task-75：这一步同时把 phase 从 starting 翻成 started —— **翻转点就在 waitReady 之后**，
  // 此后 `services<4` 不再被当成「过渡中」，回归真故障口径。
  const written = writeLease({ record, phase: 'started' });
  console.log(`[dev-stack] lease: ${written.path}`);
  // D-766 乙案最小版：CP 起来（DB 已迁移、admin 行可能已存在）之后再做 upsert ——
  // 存量库靠这一步拿到本轮注入的密码（DataSeeder 只建不更）。租约先翻 started，
  // 不让这一段 java 耗时把「phase=starting」窗口拉长。
  if (!devAdminPassword) {
    console.log('[dev-stack] dev admin upsert: skipped (no injected password; see the WARN above)');
  } else if (!ready) {
    console.log('[dev-stack] dev admin upsert: skipped (stack is not ready)');
  } else {
    applyDevAdminPassword(devAdminPassword);
  }
  const rows = SERVICES.map((service) => ({
    service,
    port: ports[service],
    pid: record.services[service]?.pid ?? null,
    listening: state[service]?.listening ?? false,
    httpStatus: state[service]?.status ?? null,
    ready: state[service]?.ready ?? false,
  }));

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          action: 'start',
          stackId: derived.stackId,
          projectRoot,
          pg,
          ready,
          services: rows,
          logDir,
          leasePath: written.path,
          lease: {
            path: written.path,
            instanceId,
            cpVersion: written.lease.cpVersion,
            pids: written.lease.pids,
            startedAt: written.lease.startedAt,
          },
        },
        null,
        2,
      ),
    );
  } else {
    for (const row of rows) {
      console.log(
        `  ${row.service.padEnd(8)} pid=${String(row.pid ?? '-').padEnd(7)} port=${String(row.port).padEnd(6)} ` +
          `listen=${row.listening} http=${row.httpStatus ?? '-'} ready=${row.ready}`,
      );
    }
    console.log(`[dev-stack] ${ready ? 'all four services are ready' : `not ready within ${args.timeout}s`}`);
  }
  if (!ready) {
    console.error(`[dev-stack] readiness timeout; inspect ${logDir}/*.err.log and retry status`);
    process.exitCode = 2;
  }
}

/* --------------------------------------------------------------- status */

async function status() {
  const record = readJson(pidFile);
  const rows = [];
  for (const service of SERVICES) {
    const saved = record?.services?.[service];
    const probe = await probeService(service);
    rows.push({
      service,
      port: ports[service],
      pid: saved?.pid ?? null,
      alive: saved?.pid ? processAlive(saved.pid) : false,
      listening: probe.listening,
      httpStatus: probe.status,
      ready: probe.ready,
    });
  }
  const pgListening = await isPortListening(ports.postgres);
  const factsOk = rows.every((row) => row.alive && row.listening) && pgListening;
  // task-76: 记录里写着、但进程已经不在的服务。status 必须点名到服务/pid，
  // 否则「租约在但进程死了」只能读成笼统的 "stack is not fully up"（无法归因）。
  const deadServices = deadRecordedServices({ record, services: SERVICES, isAlive: processAlive });
  // PLAN-0694 P0: 租约不许「回显即通过」—— 每个字段都拿独立事实核一遍，核不上就写进 mismatch。
  const lease = leaseState();
  const leaseRenewed = refreshHeartbeat(lease);
  // `healthy` 的必要条件：事实（进程活 + 端口听 + PG 在）+ 全部租约字段核对通过。
  const ok = factsOk && lease.checks.allOk;
  const cpBuild = cpBuildFor(projectRoot);
  // G12（task-154）：`buildCommit` 是**注入口径**（下一次 start 会塞给三个子进程的值），
  // 与 `cpBuild.runningCommit`（已经跑着的 classes 的戳）并列展示 —— 两者都来自同一次
  // `readBuildInfo`，不同的是「将要注入」与「正在运行」。unknown 时必须带 reason（缺失/解析失败/非法）。
  const buildCommit = resolveBuildCommit({ targetDir: cpBuild.targetDir });
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          action: 'status',
          stackId: derived.stackId,
          projectRoot,
          pidFile,
          pidFileExists: existsSync(pidFile),
          pg: { port: ports.postgres, listening: pgListening },
          cpBuild,
          buildCommit,
          services: rows,
          factsOk,
          deadServices,
          verdict: lease.verdict.verdict,
          reasons: lease.verdict.reasons,
          leaseRenewed,
          lease: leaseSummary(lease),
          ok,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`[dev-stack] status ${derived.stackId} cwd=${projectRoot}`);
    for (const row of rows) {
      console.log(
        `  ${row.service.padEnd(8)} pid=${String(row.pid ?? '-').padEnd(7)} alive=${row.alive} ` +
          `port=${String(row.port).padEnd(6)} listen=${row.listening} http=${row.httpStatus ?? '-'} ready=${row.ready}`,
      );
    }
    console.log(`  cpBuild  ${formatCpBuild(cpBuild)}`);
    console.log(`  buildCommit ${describeBuildCommit(buildCommit)}  (注入口径：下一次 start 注入 XIHE_BUILD_COMMIT)`);
    console.log(`  PostgreSQL port ${ports.postgres} listen=${pgListening}`);
    printLease(lease);
    if (leaseRenewed) console.log('  (心跳已刷新：本次核对全绿)');
    // task-76: 「租约还在、记录也还在，但进程已死」要说清楚是哪几个，
    // 不能和「端口缺」「租约不成立」混成同一句 not fully up。
    if (!factsOk && deadServices.length > 0) {
      console.log(
        `[dev-stack] lease exists but process(es) are dead: ${deadServices.map((entry) => `${entry.service}(pid ${entry.pid})`).join(', ')}`
          + ' — 租约与 pid 记录都还在，但监听进程已退出；确认后单服务重启（mise run dev:host:start:<svc>）或 stop 收尾',
      );
    } else if (!factsOk && !existsSync(pidFile) && lease.lease !== null) {
      console.log(
        `[dev-stack] lease exists but there is no pid record (${pidFile}): task-76 之前的认领只写了租约；`
          + '重跑一次 `dev-stack acquire --stack N` 即补齐',
      );
    }
    console.log(
      `[dev-stack] ${ok ? 'stack is up and every lease field verifies' : factsOk ? 'stack is up but the lease does not verify' : 'stack is not fully up'}`,
    );
  }
  if (!ok) process.exitCode = 1;
}

/* ------------------------------------------------------- status --all (R4) */

/**
 * PLAN-0656 R4: dual-stack observability. Read-only overview of every registered
 * stack that has a pid file OR any listening port (idle slots are skipped), with
 * per-service port/health, the PG database/compose project, and the cargo target
 * each stack builds into (per-stack for non-default stacks, shared default for
 * stack-1). This checkout's perspective: pid files are read from this projectRoot's
 * stack log dirs.
 */
async function statusAll() {
  const stacks = [];
  // One CP build per checkout in the current layout (BL-253: stacks share the classes dir), so
  // the overview prints it once and every live stack repeats it in its own row.
  const cpBuild = cpBuildFor(projectRoot);
  for (const stackId of STACK_IDS) {
    let d;
    try {
      d = deriveStack(stackId);
    } catch {
      continue;
    }
    const p = d.ports;
    const stackPidFile = join(resolve(projectRoot, d.logDir), 'dev-stack-pids.json');
    const record = readJson(stackPidFile);
    const services = [];
    for (const service of SERVICES) {
      const probe = await probeService(service, d, p);
      const saved = record?.services?.[service];
      services.push({
        service,
        port: p[service],
        pid: saved?.pid ?? null,
        alive: saved?.pid ? processAlive(saved.pid) : false,
        listening: probe.listening,
        httpStatus: probe.status,
        ready: probe.ready,
      });
    }
    const pgListening = await isPortListening(p.postgres);
    const leaseFilePath = leasePath(projectRoot, d.stackId);
    if (
      !existsSync(stackPidFile)
      && !existsSync(leaseFilePath)
      && !pgListening
      && services.every((row) => !row.listening)
    ) {
      continue;
    }
    const cargoTarget = cargoTargetForStack({ stackId: d.stackId, projectRoot, env: process.env });
    const stackCpBuild = cpBuildFor(projectRoot, d.stackId);
    const stackCommit = resolveBuildCommit({ targetDir: stackCpBuild.targetDir });
    // PLAN-0694 P0: 同一套核对链路，逐栈判定；`ok` 不再只看「端口在听」。
    const lease = leaseState({ d, p, cpVersion: stackCpBuild.runningCommit ?? null });
    const factsOk = services.every((row) => row.listening) && pgListening;
    stacks.push({
      stackId: d.stackId,
      pidFile: stackPidFile,
      pidFileExists: existsSync(stackPidFile),
      cargoTargetDir: cargoTarget ?? null,
      cpBuild: stackCpBuild,
      buildCommit: stackCommit,
      pg: { port: p.postgres, listening: pgListening, database: d.database, composeProject: d.composeProject },
      services,
      verdict: lease.verdict.verdict,
      reasons: lease.verdict.reasons,
      factsOk,
      lease: leaseSummary(lease),
      ok: factsOk && lease.checks.allOk,
    });
  }
  if (args.json) {
    console.log(JSON.stringify({ action: 'status-all', projectRoot, cpBuild, stacks }, null, 2));
    if (stacks.some((stack) => !stack.ok)) process.exitCode = 1;
    return;
  }
  console.log(`[dev-stack] status --all cwd=${projectRoot}`);
  console.log(`  cpBuild  ${formatCpBuild(cpBuild)}`);
  if (stacks.length === 0) console.log('  (no stack has a pid file or a listening port)');
  for (const stack of stacks) {
    console.log(
      `  ${stack.stackId} ok=${stack.ok} verdict=${stack.verdict ?? '-'} db=${stack.pg.database} compose=${stack.pg.composeProject}` +
        ` cargoTarget=${stack.cargoTargetDir ?? '(default .cargo/config.toml)'}`,
    );
    for (const row of stack.services) {
      console.log(
        `    ${row.service.padEnd(8)} port=${String(row.port).padEnd(6)} listen=${row.listening} ` +
          `http=${row.httpStatus ?? '-'} ready=${row.ready} pid=${row.pid ?? '-'}${row.alive ? '' : row.pid ? ' (record dead)' : ''}`,
      );
    }
    console.log(`    cpBuild  ${formatCpBuild(stack.cpBuild)}`);
    console.log(`    buildCommit ${describeBuildCommit(stack.buildCommit)}  (注入口径)`);
    console.log(`    PostgreSQL port ${stack.pg.port} listen=${stack.pg.listening}`);
    console.log(`    verdict  ${stack.verdict ?? '-'} (${stack.reasons.join(' ')})` +
      ` leaseExists=${stack.lease.exists} state=${stack.lease.state ?? '-'} mismatch=${stack.lease.mismatch.length}` +
      ` unverifiable=${stack.lease.unverifiable.length}`);
    const cold = coldLeaseHint({ leaseState: stack.lease.state, ageMs: stack.lease.ageMs });
    if (cold) console.log(`      ${cold}`);
    for (const entry of stack.lease.mismatch) {
      console.log(`      ${entry.code} ${entry.field} expected=${JSON.stringify(entry.expected)} actual=${JSON.stringify(entry.actual)}`);
    }
  }
  if (stacks.some((stack) => !stack.ok)) process.exitCode = 1;
}

/* ----------------------------------------------------------------- stop */

async function stop() {
  // task-75：**kill 之前**先声明「本实例正在停这个栈」（phase=stopping）。
  // 停栈时端口是 4→0 递减的，10 分钟层若恰好在中间采样，看到的就是「有租约、端口 2/4」——
  // 这正是「服务启动后死了」的形状。相位让「这叫停栈、不叫故障」有据可依；
  // 停栈失败留下的 stopping 租约随心跳过期自动失效（见 isTransitionLease），不会变成长期免报牌。
  if (setLeasePhase({ projectRoot, stackId: derived.stackId, phase: 'stopping' }).updated) {
    console.log('[dev-stack] lease: phase=stopping (declared before kill)');
  }
  const record = readJson(pidFile);
  if (!record) {
    console.log(`[dev-stack] no pid file at ${pidFile}; nothing recorded for this stack`);
  } else {
    for (const service of SERVICES) {
      const saved = record.services?.[service];
      if (!saved?.pid) continue;
      if (!processAlive(saved.pid)) {
        console.log(`[dev-stack] ${service} pid ${saved.pid} not running`);
        continue;
      }
      if (!looksLikeOurWrapper(saved.pid)) {
        console.error(`[dev-stack] WARN: pid ${saved.pid} (${service}) does not look like our wrapper; skipping kill`);
        continue;
      }
      if (isWindows) {
        spawnSync('taskkill', ['/PID', String(saved.pid), '/T', '/F'], { stdio: 'inherit', windowsHide: true });
      } else {
        try {
          process.kill(-saved.pid, 'SIGTERM');
        } catch {
          try {
            process.kill(saved.pid, 'SIGTERM');
          } catch {
            /* already gone */
          }
        }
      }
      console.log(`[dev-stack] stopped ${service} (pid ${saved.pid}, tree)`);
    }
  }

  // PLAN-0656 R3: after the recorded trees are down, sweep listeners that the pid file
  // never knew (crashed stop / restart leftovers). Runs even when no pid file exists —
  // that is exactly the orphan scenario that blocked the next start.
  sweepOrphanProcesses({ derived, reason: 'stop' });

  const deadline = Date.now() + 15000;
  let remaining = SERVICES.filter((service) => ports[service]);
  while (Date.now() < deadline) {
    remaining = [];
    for (const service of SERVICES) if (await isPortListening(ports[service])) remaining.push(service);
    if (remaining.length === 0) break;
    await sleep(500);
  }
  if (existsSync(pidFile)) rmSync(pidFile, { force: true });

  // PLAN-0694 P0: 正常停栈释放租约；端口没让出来 = 释放失败 ⇒ **保留租约并打标**
  // （`releaseFailed` 会被 status 核成 mismatch），绝不静默删 —— 残留 + 无租约正是 ghost 的温床。
  let leaseOutcome = { released: false, releaseFailed: false };
  if (remaining.length > 0) {
    const marked = markReleaseFailed({
      projectRoot,
      stackId: derived.stackId,
      services: remaining,
      reason: 'residual listener after stop',
    });
    leaseOutcome = { released: false, releaseFailed: marked.marked };
  } else {
    leaseOutcome = { released: releaseLease({ projectRoot, stackId: derived.stackId }).removed, releaseFailed: false };
  }

  let pg = { port: ports.postgres, listening: await isPortListening(ports.postgres), stopped: false };
  if (args.withPg) {
    await stopPg();
    pg = { port: ports.postgres, listening: await isPortListening(ports.postgres), stopped: true };
  }

  const residual = {
    listeningServices: remaining,
    pgListening: pg.listening,
    pgStopped: args.withPg,
    pidFileExists: existsSync(pidFile),
    lease: leaseOutcome,
  };
  if (args.json) {
    console.log(JSON.stringify({ action: 'stop', stackId: derived.stackId, projectRoot, ...residual }, null, 2));
  } else {
    console.log(`[dev-stack] residual: services=${remaining.length ? remaining.join(',') : 'none'} pgListening=${pg.listening} pidFile=${residual.pidFileExists}`);
    console.log(
      `[dev-stack] lease: released=${leaseOutcome.released} releaseFailed=${leaseOutcome.releaseFailed}`
        + (leaseOutcome.releaseFailed ? ' (租约保留并打标：先修掉残留端口，再 release)' : ''),
    );
    if (!args.withPg) console.log('[dev-stack] PostgreSQL left running (pass --with-pg to stop the container; volume always kept)');
  }
  if (remaining.length > 0 || residual.pidFileExists) process.exitCode = 1;
}

/* --------------------------------------------------- acquire / release / gc */

/**
 * PLAN-0694 P0: 认领一套**已经在跑**的栈（升级前起的栈、或 start 没写租约的旧栈）。
 *
 * 只从当前事实写租约：画像匹配的监听者、pid 记录、CP 构建戳。没有匹配的监听者就没有可认领的
 * 东西 —— 此时写租约会凭空造一份「意图」，那正是 ghost 误判的来源，所以直接拒绝（exit 2）。
 */
async function acquire() {
  const listeners = listenFacts();
  if (listeners.own.length === 0) {
    console.error(
      `[dev-stack] nothing to adopt on ${derived.stackId}: no profile-matched listener on ports `
        + `${SERVICES.map((service) => ports[service]).join(',')} (check --stack/--cwd, or start the stack first)`,
    );
    process.exitCode = 2;
    return;
  }
  // task-76: 认领=两份状态一起落盘。只写租约 ⇒ status 的 alive/factsOk 恒 false
  // （它只读 pidFile），认领完仍报 "stack is not fully up" —— 全绿却 exit 1 的假红。
  // 记录结构与 start() 写出的完全一致（buildAdoptedRecord，勿发明第二种格式）。
  const previous = readJson(pidFile);
  const record = buildAdoptedRecord({
    stackId: derived.stackId,
    projectRoot,
    listeners: listeners.own,
    ports,
    services: SERVICES,
    previous,
    isAlive: processAlive,
  });
  writeJson(pidFile, record);
  const written = writeLease({ record });
  // 写完立刻按同一链路自审一次：认领也得经得起核对，不是「写了就算」。
  const state = leaseState({ listeners: written.listeners });
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          action: 'acquire',
          stackId: derived.stackId,
          projectRoot,
          leasePath: written.path,
          pidFile,
          adoptedListeners: listeners.own,
          lease: leaseSummary(state),
          verdict: state.verdict.verdict,
          reasons: state.verdict.reasons,
          ok: state.checks.allOk,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`[dev-stack] acquired ${derived.stackId}: lease written to ${written.path}`);
    console.log(`[dev-stack] pid record written to ${pidFile} (${Object.keys(record.services).length} services)`);
    console.log(`  adopted  ${listeners.own.map((entry) => `${entry.service}:${entry.pid}@${entry.port}`).join(' ')}`);
    printLease(state);
    console.log(`[dev-stack] ${state.checks.allOk ? 'lease verifies' : 'lease written but does NOT verify (see mismatch above)'}`);
  }
  if (!state.checks.allOk) process.exitCode = 1;
}

/** PLAN-0694 P0: 只删租约文件，绝不碰进程（停栈是 `stop` 的事，两者不混）。 */
async function release() {
  const path = leasePath(projectRoot, derived.stackId);
  if (!existsSync(path)) {
    console.log(`[dev-stack] no lease at ${path}; nothing to release`);
    if (args.json) console.log(JSON.stringify({ action: 'release', stackId: derived.stackId, projectRoot, leasePath: path, existed: false, removed: false }, null, 2));
    return;
  }
  const { removed } = releaseLease({ projectRoot, stackId: derived.stackId });
  if (args.json) {
    console.log(JSON.stringify({ action: 'release', stackId: derived.stackId, projectRoot, leasePath: path, existed: true, removed }, null, 2));
  } else {
    console.log(`[dev-stack] released lease ${path} (removed=${removed}); processes untouched`);
    console.log('[dev-stack] note: 租约删掉后仍在跑的栈会被 status 判成 ghost —— 这是设计（没人认领的端口）；用 stop 收尾。');
  }
}

/**
 * PLAN-0694 P0: **只读**回收扫描。判定口径 = 租约 + 交叉校验双基础：
 *   - `orphan`（租约在但记录进程全死、端口还占着）/ `ghost`（无可用租约、端口还占着）→ 候选；
 *   - `stale`（租约自相矛盾）只报告，不算可回收；
 *   - 没有 own 监听也没有租约/pid 记录的栈直接跳过。
 *
 * 零 kill：只打印判据与建议命令，由人来执行（`gc` 的职责是「说清楚」，不是「动手」）。
 * **归属不装作知道**：端口空间全局、租约按 checkout 隔离，别的 checkout 的活栈在本 checkout 眼里
 * 也长得像 ghost；所以候选额外带 `serving`（端口上服务是否还响应）与 `ownTrace`（本 checkout 是否
 * 有痕证），建议命令据此分流成「直接 stop」或「先确认归属再动」。`gc` 的判据仍是租约+交叉校验，
 * 不因探测结果改 verdict。
 * exit 0 = 没有候选，1 = 有候选（与 `status` 同一读取习惯）。
 */
async function gc() {
  const findings = [];
  const targets = [];
  const byPort = new Map();
  for (const stackId of STACK_IDS) {
    let d;
    try {
      d = deriveStack(stackId);
    } catch {
      continue;
    }
    if (args.explicitStack && d.stackId !== derived.stackId) continue;
    targets.push(d);
    for (const port of Object.values(d.ports)) byPort.set(port, d.stackId);
  }
  // 一次扫全部槽位端口再按栈分区：8 个栈省成 1 次系统查询（gc 要能随手跑）。
  const listenersByStack = new Map(targets.map((d) => [d.stackId, { own: [], external: [] }]));
  for (const listener of stackListeners([...byPort.keys()])) {
    const stackId = byPort.get(listener.port);
    const d = targets.find((candidate) => candidate.stackId === stackId);
    if (!d) continue;
    const decision = classifyListener(listener, { ports: d.ports });
    if (decision.kind === 'unsupported') continue;
    const bucket = listenersByStack.get(stackId);
    const base = { port: listener.port, pid: listener.pid, name: listener.name ?? '', service: decision.service ?? null };
    if (decision.kind === 'kill') bucket.own.push(base);
    else bucket.external.push(base);
  }
  for (const d of targets) {
    const p = d.ports;
    const path = leasePath(projectRoot, d.stackId);
    const pidFileForStack = join(resolve(projectRoot, d.logDir), 'dev-stack-pids.json');
    const listeners = listenersByStack.get(d.stackId) ?? { own: [], external: [] };
    const hasTrace = existsSync(path) || existsSync(pidFileForStack) || listeners.own.length > 0;
    if (!hasTrace) continue;
    const state = leaseState({ d, p, listeners });
    const verdict = state.verdict.verdict;
    const candidate = verdict === 'orphan' || verdict === 'ghost';
    // 端口上还有活服务在响应吗？端口空间是**全局**的、租约空间按 checkout 隔离，所以别的 checkout
    // 起的栈在本 checkout 眼里恰好长得像 ghost（端口占着、这里没租约）。有响应就先别当垃圾删建议。
    const served = {};
    for (const service of SERVICES) {
      if (!listeners.own.some((entry) => entry.port === p[service])) continue;
      served[service] = await httpStatus(`http://127.0.0.1:${p[service]}${ENDPOINTS[service]}`);
    }
    const serving = Object.entries(served)
      .filter(([, status]) => status !== null && status < 500)
      .map(([service]) => service);
    const ownTrace = state.lease !== null || state.corrupt || existsSync(pidFileForStack);
    const stackNumber = String(d.stackId).replace(/^stack-/, '');
    const suggestion = !candidate
      ? null
      : ownTrace || serving.length === 0
        ? `node scripts/dev-stack.mjs stop --stack ${stackNumber} --cwd ${projectRoot}`
        : `端口上服务在响应（${serving.join(',')}），但本 checkout 没有它的租约/pid 记录 —— 可能是别的 checkout 起的栈：先到那个 checkout 执行 stop，或在此处 acquire --stack ${stackNumber} --cwd ${projectRoot} 认领`;
    findings.push({
      stackId: d.stackId,
      verdict,
      reasons: state.verdict.reasons,
      candidate,
      ownTrace,
      ownPorts: state.verdict.ownPorts,
      externalPorts: state.verdict.externalPorts,
      served,
      serving,
      leaseExists: state.lease !== null || state.corrupt,
      leasePath: path,
      pidFileExists: existsSync(pidFileForStack),
      mismatch: state.checks.mismatches,
      unverifiable: state.checks.unverifiable,
      suggestion,
    });
  }
  const candidates = findings.filter((entry) => entry.candidate);
  if (args.json) {
    // 契约（design L85）：`gc --dry-run --json` 恒含 `killed: 0`，且不提供 `--apply`。
    console.log(JSON.stringify({ action: 'gc', projectRoot, dryRun: true, killed: 0, findings, candidates: candidates.length }, null, 2));
  } else {
    console.log(`[dev-stack] gc (dry-run, read-only, killed=0) cwd=${projectRoot}`);
    if (findings.length === 0) console.log('  (no stack has a lease, a pid file or a profile-matched listener)');
    for (const entry of findings) {
      const flag = entry.candidate ? 'COLLECT' : 'keep';
      console.log(`  ${entry.stackId.padEnd(8)} ${flag} verdict=${entry.verdict ?? '-'} ownPorts=${entry.ownPorts.join(',') || '-'}`);
      console.log(`    reasons  ${entry.reasons.join(' ') || '-'}`);
      if (entry.serving.length > 0) {
        console.log(`    serving  ${entry.serving.map((service) => `${service}:${entry.served[service]}`).join(' ')}` +
          `${entry.ownTrace ? '' : ' (本 checkout 无痕证)'}`);
      }
      if (entry.externalPorts.length > 0) {
        console.log(`    external ${entry.externalPorts.join(',')} (别人家的端口：不参与判定，也不会被建议清理)`);
      }
      for (const mismatch of entry.mismatch) {
        console.log(`    mismatch ${mismatch.code} ${mismatch.field} expected=${JSON.stringify(mismatch.expected)} actual=${JSON.stringify(mismatch.actual)}`);
      }
      if (entry.suggestion) console.log(`    suggestion ${entry.suggestion}`);
    }
    console.log(
      `[dev-stack] ${candidates.length === 0 ? 'nothing to collect' : `${candidates.length} candidate(s) — 建议命令已给出，gc 不会自己 kill`}`,
    );
  }
  if (candidates.length > 0) process.exitCode = 1;
}

/* ----------------------------------------------------------------- main */

try {
  // task-234 A：注入失败时只提示正确启动方式（不改语义）。B 已尝试 User 级兜底，走到这里仍为空 ⇒ 真没有可用的根。
  if (!process.env[CARGO_TARGET_ROOT_ENV]) {
    console.warn(
      `[dev-stack] WARN: ${CARGO_TARGET_ROOT_ENV} 未注入（当前 shell 不继承 User 级 env，且 User 级也未配置）；` +
        `cargo 会回落 <one>/.tmp/cargo-target。请用 \`mise run dev:stack -- --stack ${args.stack ?? process.env.XIHE_STACK_ID ?? '1'}\` 启动。`,
    );
  }
  if (args.action === 'start') await start();
  else if (args.action === 'status') {
    if (args.all) await statusAll();
    else await status();
  } else if (args.action === 'stop') await stop();
  else if (args.action === 'acquire') await acquire();
  else if (args.action === 'release') await release();
  else await gc();
} catch (error) {
  console.error(`[dev-stack] ERROR: ${error.message}`);
  process.exit(2);
}
