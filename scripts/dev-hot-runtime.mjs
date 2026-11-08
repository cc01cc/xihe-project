#!/usr/bin/env node
// dev-hot-runtime.mjs — Runtime（Rust）侧 dev 增量循环：改保存 → `cargo build`（该栈稳定 target dir）
// → 成功才谈重启（默认只打印**精确重启命令**，`--restart` 才真的按 pid 文件重启）。
//
// 为什么不是"热更新"：safe Rust 没有进程内类重载（`task-218` 报告 §1）。能省的是**编译**这一层：
// 实测改一行注释增量编 4.35 s vs 冷编 60.47–66.09 s（≈15×），且栈 runtime 本来就是稳定 target dir
// （`cargoTargetForStack` 每栈一个目录，不随 sha 变）——所以收益今天已在生效，本脚本只是把
// "保存→编译→（可选）重启"串起来，省掉手工三步。
//
// 不装 `cargo-watch`（新增全局工具需审批）；这里用 `fs.watch` + `spawnSync('cargo', ...)`。
//
// 用法：
//   node scripts/dev-hot-runtime.mjs [--stack N] [--debounce 300] [--once] [--dry-run] [--restart] [--quiet-build]
//   node scripts/dev-hot-runtime.mjs --help
//
// 硬边界：不重启栈（`--restart` 只重启 **runtime 这一个子进程**，且先读 pid 文件确认 pid 属于本栈）；
// 不改 `dev-stack.mjs`/`mise.toml`/产物代码；不动其它栈的 target dir。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';

import { cargoTargetForStack } from './lib/stack-cargo-target.mjs';
import { DEFAULT_STACK_ID, deriveStack } from './lib/stack-ports.mjs';

const projectRoot = dirname(import.meta.dirname);
const HELP = `usage: node scripts/dev-hot-runtime.mjs [--stack N] [--debounce 300] [--once] [--dry-run] [--restart] [--quiet-build]

  --stack N        目标栈（默认 2 = dev 栈）
  --debounce MS    防抖窗口（默认 300）
  --once           只编一次就退出
  --dry-run        只打印命令与 target dir，不编译
  --restart        编译成功后**真的重启**该栈 runtime 子进程（默认只打印精确命令）
  --quiet-build    编译用 -q（默认 -q；保留开关以便调试时看全量）
  --help, -h       打印本帮助

为什么默认不重启：栈的 runtime 由 dev-stack.mjs supervisor 持有（pid 在
.xihe-stacks/<n>/logs/dev-stack-pids.json，启动命令 cargo run --bin xihe-runtime）。
外部替换 exe + 重启会让 supervisor 记录的 pid 与真实进程不一致（Windows 上还常见
"目标 exe 被占用 ⇒ 编译失败 os error 5"）。所以默认只编译并打印重启命令，由人决定；
--restart 适合"明确知道自己在干什么"的 dev 循环。`;

// task-228：与 dev-hot-cp 同款证据栈守卫——stack-1 是证据栈，热编/重启它的 runtime 会让
// 真栈证据失真；默认只允许 stack-2，stack-1 必须显式 --i-understand-this-dirties-evidence。
const args = { stack: 2, debounce: 300, once: false, dryRun: false, restart: false, quiet: true, dirtiesEvidence: false };
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
  else if (a === '--restart') args.restart = true;
  else if (a === '--quiet-build') args.quiet = true;
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
// ① 证据栈守卫（task-228）：与 dev-hot-cp.mjs:111-120 同款口径。
if (args.stack === 1 && !args.dirtiesEvidence) {
  console.error(
    '[hot-runtime] 拒绝：stack-1 是本仓的证据栈（真栈/L2 证据从它取）。\n'
    + '  热编/重启它的 runtime 会让证据面失真。\n'
    + '  确实要动证据栈：加 --i-understand-this-dirties-evidence；dev 循环请用 --stack 2。',
  );
  process.exit(2);
}

const stackId = args.stack === DEFAULT_STACK_ID ? 'stack-1' : `stack-${args.stack}`;
let derived;
try {
  derived = deriveStack(stackId);
} catch (error) {
  console.error(`FAILED to derive stack ${stackId}: ${error.message}`);
  process.exit(2);
}
const pidFile = join(projectRoot, derived.logDir, 'dev-stack-pids.json');
const runtimeCwd = join(projectRoot, 'packages', 'runtime');

// 与 dev-stack 同一派生：非默认栈必须用 <root>/<stackId>；默认栈返回 undefined（沿用 ambient config）。
const perStack = cargoTargetForStack({ stackId, projectRoot, env: process.env });
const cargoTargetDir = perStack ?? (process.env.CARGO_TARGET_DIR ?? '').trim() ?? '';
const buildEnv = { ...process.env };
if (cargoTargetDir) buildEnv.CARGO_TARGET_DIR = cargoTargetDir;

console.log(`[hot-runtime] stack=${stackId} cwd=${projectRoot}`);
console.log(`[hot-runtime] CARGO_TARGET_DIR: ${cargoTargetDir || '(沿用 .cargo/config.toml)'}`);
console.log(`[hot-runtime] pid file: ${pidFile} (exists=${existsSync(pidFile)})`);

const cargoArgs = ['build', ...(args.quiet ? ['-q'] : []), '--bin', 'xihe-runtime'];
const watchPaths = [join(runtimeCwd, 'src'), join(runtimeCwd, 'Cargo.toml'), join(runtimeCwd, 'Cargo.lock')];
let timer = null;
let running = false;
let pending = false;
let builds = 0;

function readRuntimePid() {
  try {
    const record = JSON.parse(readFileSync(pidFile, 'utf8'));
    const pid = record?.services?.runtime?.pid;
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function printRestartCommand(pid) {
  console.log('[hot-runtime] 重启方式（二选一，**默认不自动执行**）：');
  console.log('  # A) 让 supervisor 自己重启（推荐：无 pid 漂移）');
  console.log(`      node scripts/dev-stack.mjs stop --stack ${args.stack} --json && node scripts/dev-stack.mjs start --stack ${args.stack} --json`);
  console.log('  # B) 只换 runtime 子进程（pid 会与 supervisor 记录漂移；失败时不要杀旧进程）');
  if (pid) console.log(`      taskkill /PID ${pid} /T /F   &&   cargo run --bin xihe-runtime   (cwd packages/runtime, CARGO_TARGET_DIR=${cargoTargetDir || '(未设)'})`);
  else console.log('      (pid 文件里没有 runtime pid —— 栈可能没起）');
}

function restartRuntime() {
  const pid = readRuntimePid();
  if (!pid) {
    console.error('[hot-runtime] WARN: 读不到 runtime pid，不重启（保留旧进程）');
    return false;
  }
  console.log(`[hot-runtime] 重启 runtime pid=${pid}（--restart）`);
  const killed = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'inherit', windowsHide: true });
  if (killed.status !== 0) {
    console.error(`[hot-runtime] ERROR: taskkill exit=${killed.status} —— 旧进程可能仍在跑（Windows 文件锁/权限），不继续起新的（避免双 runtime）`);
    return false;
  }
  const child = spawn('cargo', ['run', '--bin', 'xihe-runtime'], {
    cwd: runtimeCwd,
    env: buildEnv,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  console.log(`[hot-runtime] 已起新 runtime（pid ${child.pid}）；注意: supervisor 的 pid 文件仍记着旧 pid`);
  return true;
}

function buildOnce() {
  const startedAt = Date.now();
  console.log(`[hot-runtime] running: cargo ${cargoArgs.join(' ')}  (cwd packages/runtime)`);
  const result = spawnSync('cargo', cargoArgs, {
    cwd: runtimeCwd,
    stdio: 'inherit',
    windowsHide: true,
    env: buildEnv,
  });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  if (result.status !== 0) {
    console.error(`[hot-runtime] BUILD FAILED (exit ${result.status ?? 'null'}) after ${elapsed}s —— **不动**运行中的 runtime`);
    return false;
  }
  builds += 1;
  console.log(`[hot-runtime] BUILD OK (#${builds}) in ${elapsed}s`);
  if (args.restart) restartRuntime();
  else printRestartCommand(readRuntimePid());
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
  console.log(`[hot-runtime] change (${reason}) → 将在 ${args.debounce} ms 后编译`);
}

if (args.dryRun) {
  console.log(`[hot-runtime] --dry-run: 将执行 cargo ${cargoArgs.join(' ')}（未执行）`);
  process.exit(0);
}
if (args.once) process.exit(buildOnce() ? 0 : 1);

const watchers = [];
for (const p of watchPaths) {
  try {
    if (!existsSync(p)) continue;
    watchers.push(watch(p, { recursive: p.endsWith('src') }, (event, filename) => schedule(`${event} ${filename ?? p}`)));
  } catch (error) {
    console.warn(`[hot-runtime] WARN: 无法 watch ${p}: ${error.message}`);
  }
}
console.log(`[hot-runtime] watching ${watchPaths.join(', ')} (debounce=${args.debounce} ms)`);

const shutdown = () => {
  for (const w of watchers) w.close();
  console.log(`[hot-runtime] 停止（共 ${builds} 次编译）`);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
