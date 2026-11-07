#!/usr/bin/env node
/**
 * 缺陷 3（PLAN-0680 / task-76）：开窗前置检查必须看**真的那个** cargo target 目录。
 *
 * 为什么单独成模块：`scripts/e2e-preflight.mjs` 是纯脚本（import 就会真跑 docker/端口/产物），
 * 数值/路径判定必须能喂假数据单测，故按仓库既有先例（`lib/e2e-preflight-disk.mjs`、
 * `lib/stack-cargo-target.mjs`）抽到 lib。
 *
 * 缺陷形状（"检查指向了一条永远走不到的路"）：
 * `packages/runtime/target/debug/xihe-runtime.exe` 是**历史布局**的产物（2026-11-04 02:16、
 * 35.2 MB），真实 host E2E 跑的却是 `.tmp/cargo-target/{main,stack-2}/debug/xihe-runtime.exe`
 * （2026-11-08 03:52、36.2 MB）。旧实现的检查永远读那个废弃目录 ⇒ 结果恒为"4d old 且 stale"，
 * 既报警报不到真问题，也无法证明真二进制新鲜。这与 `--help` 截断属于同一家族：**检查有了输出，
 * 但输出描述的不是现实**。
 *
 * 判定来源按优先级（**不手写 TOML parser** —— 工作区硬规则：成熟文件格式用成熟机制）：
 * 1. `CARGO_TARGET_DIR` 环境变量（worktree-env.ps1 / 手工覆盖，cargo 里优先级最高）；
 * 2. `cargo metadata --no-deps --offline --format-version 1` 的 `target_directory`
 *    —— 由 cargo 自己把 `.cargo/config.toml` 的 `[build] target-dir`、祖先目录搜索、
 *    环境变量优先级一并算好，我们不复制这套逻辑（复制就会漂移）；
 * 3. 都拿不到 ⇒ **不可验证**（`unverifiable: true`），由调用方按阻塞处理：
 *    "未知不等于安全"（与磁盘门同一条判据）。
 *
 * 另外：真实跑法会给每个栈一个子目录（PLAN-0656 R1：`.tmp/cargo-target/main`、
 * `.tmp/cargo-target/stack-2`），所以解析出 target 目录后还要扫它的兄弟栈目录，
 * 否则"两套栈都在跑今天的二进制"这种事实又被看不见。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** cargo 自己解析 target 目录（含 config.toml + env 优先级）；只读、不构建、不写 lockfile。 */
export const CARGO_METADATA_ARGS = Object.freeze([
  'metadata',
  '--no-deps',
  '--offline',
  '--locked',
  '--format-version',
  '1',
]);

/** 真实跑法里每个栈的 target 子目录名（PLAN-0656 R1）；`main` 是 stack-1 的默认目录。 */
const STACK_DIR_PATTERN = /^(?:main|stack-\d+)$/;

/** 历史布局（本次缺陷的当事人）：只为在输出里显式声明"它不被采信"，绝不参与判定。 */
export function legacyRuntimeTargetDir(projectRoot) {
  return `${projectRoot.replaceAll('\\', '/')}/packages/runtime/target`;
}

/**
 * 纯解析：`cargo metadata` 的 JSON → `target_directory`。
 * 拿不到/不是字符串/空串一律 `null`（调用方据此判"不可验证"，不猜、不回退拼路径）。
 * @param {string} stdout
 * @returns {string|null}
 */
export function parseCargoMetadataTargetDirectory(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? ''));
  } catch {
    return null;
  }
  const value = parsed?.target_directory;
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim();
}

function normalizeDir(value) {
  return value.replaceAll('\\', '/');
}

/** 路径归一化：`..`/`.` 与重复分隔符一律折叠（cargo 也是这么解析相对 target-dir 的）。 */
function absoluteDir(value, base) {
  return normalizeDir(isAbsolute(value) ? resolve(value) : resolve(base, value));
}

/**
 * 兄弟栈目录（只在这层 base 目录里找 `main` / `stack-N` 目录，顺序稳定：主目录在前）。
 * @returns {{dir: string, label: string}[]}
 */
export function siblingStackTargetDirs(primaryDir, { readdir = readdirSync } = {}) {
  const primary = normalizeDir(primaryDir);
  const base = primary.replace(/\/[^/]+$/, '');
  const entries = [{ dir: primary, label: primary.split('/').pop() || primary }];
  let names = [];
  try {
    names = readdir(base, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const entry of names) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const isDirectory = typeof entry === 'string' ? true : entry.isDirectory();
    if (!isDirectory || !STACK_DIR_PATTERN.test(name)) continue;
    const dir = `${base}/${name}`;
    if (dir === primary) continue;
    entries.push({ dir, label: name });
  }
  return entries;
}

/**
 * 解析"这一轮到底该看哪个 target 目录"。
 *
 * @param {object} options
 * @param {string} options.projectRoot 仓库根（cargo metadata 的 cwd）
 * @param {Record<string,string|undefined>} [options.env]
 * @param {(program: string, args: string[], timeoutMs?: number, cwd?: string) => {ok: boolean, code: number|null, stdout: string, stderr: string}} options.runCapture
 * @param {(path: string) => boolean} [options.exists]
 * @param {(path: string, options?: object) => any[]} [options.readdir]
 * @returns {{
 *   source: 'env'|'cargo-metadata'|'unverifiable',
 *   targetDirs: {dir: string, label: string}[],
 *   legacyDir: string,
 *   unverifiable: boolean,
 *   reason: string,
 * }}
 */
export function resolveRuntimeTargetDirs({
  projectRoot,
  env = process.env,
  runCapture,
  exists = existsSync,
  readdir = readdirSync,
  cargoRoot,
} = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    throw new TypeError('resolveRuntimeTargetDirs: projectRoot is required');
  }
  const root = normalizeDir(projectRoot);
  const legacyDir = legacyRuntimeTargetDir(root);
  const unverifiable = (reason) => ({
    source: 'unverifiable',
    targetDirs: [],
    legacyDir,
    unverifiable: true,
    reason,
  });

  // 1. 显式覆盖最高优先：worktree-env.ps1 / 手工 CARGO_TARGET_DIR 都是"事实"，不要扫它的兄弟目录
  //    （那些兄弟不属于这个栈，认进来就是新的错指向）。
  const envDir = typeof env?.CARGO_TARGET_DIR === 'string' ? env.CARGO_TARGET_DIR.trim() : '';
  if (envDir !== '') {
    const dir = absoluteDir(envDir, root);
    return {
      source: 'env',
      targetDirs: [{ dir, label: dir.split('/').pop() || dir }],
      legacyDir,
      unverifiable: false,
      reason: 'CARGO_TARGET_DIR is set (it outranks .cargo/config.toml in cargo)',
    };
  }

  // 2. 让 cargo 自己算（config.toml 的 [build] target-dir + 祖先搜索 + env 优先级）。
  //    注意 cwd：`cargo metadata` 必须在一个含 Cargo.toml 的目录里跑（XH 的 workspace 根是
  //    `packages/runtime`，仓库根没有 Cargo.toml）。cargo 从 cwd 向上找 `.cargo/config.toml`，
  //    所以在 `packages/runtime` 里跑仍会用到仓库根的那份配置。
  if (typeof runCapture !== 'function') return unverifiable('no runCapture available to ask cargo metadata');
  const metadataCwd = cargoRoot
    ? normalizeDir(cargoRoot)
    : (exists(`${root}/packages/runtime/Cargo.toml`) ? `${root}/packages/runtime` : root);
  const result = runCapture('cargo', [...CARGO_METADATA_ARGS], 30000, metadataCwd);
  if (!result || !result.ok) {
    const detail = String(result?.stderr ?? '').trim().split('\n').filter(Boolean)[0]
      || `exit ${result?.code ?? 'null'}`;
    return unverifiable(`cargo metadata failed (${detail})`);
  }
  const targetDirectory = parseCargoMetadataTargetDirectory(result.stdout);
  if (!targetDirectory) {
    return unverifiable('cargo metadata did not report a usable target_directory');
  }
  const normalizedTarget = absoluteDir(targetDirectory, root);
  const targetDirs = siblingStackTargetDirs(normalizedTarget, { readdir });
  return {
    source: 'cargo-metadata',
    targetDirs,
    legacyDir,
    unverifiable: false,
    reason: `.cargo/config.toml [build] target-dir resolved by cargo: ${normalizedTarget}`,
  };
}

/**
 * 判据（缺陷 3）：把"该看哪个 binary、看到什么、算不算阻塞"从 preflight 的打印里拆出来，
 * 好在不跑整段 preflight 的情况下单测（窗口期不允许跑只读门，见 PLAN-0680 task-76）。
 *
 * 判定规则：
 * - 解析不出 target 目录 ⇒ `unverifiable` + **阻塞**（"未知不等于安全"，与磁盘门同一条规则）；
 *   绝不退回废弃的 `packages/runtime/target`（那正是本缺陷的错指向）。
 * - 解析出来但 debug binary 都不存在 ⇒ `missing`，只 INFO：第一次 `cargo run` 本来就会构建。
 * - 最新的 debug binary 比源码旧 ⇒ `stale`，WARN（`cargo run` 会先重编，几分钟；不阻塞开窗）。
 * - 否则 `fresh`，OK。
 *
 * 多栈（`main` + `stack-N`，以及 E2E 自己的 `e2e` 目录）取**最新**的那个 binary 判定：那是本
 * checkout 跑一次 `cargo run` 会复用的产物；每个目录的存在性与 mtime 一并返回，报告里能逐条列出。
 *
 * @param {{resolution: object, binaryName: string, sourceNewest?: {path: string, mtimeMs: number}}} input
 */
export function inspectRuntimeBinaries({ resolution, binaryName, sourceNewest } = {}, deps = {}) {
  const exists = deps.exists ?? existsSync;
  const stat = deps.stat ?? statSync;
  if (!resolution || !Array.isArray(resolution.targetDirs)) {
    throw new TypeError('inspectRuntimeBinaries: a resolution from resolveRuntimeTargetDirs() is required');
  }
  if (typeof binaryName !== 'string' || binaryName.trim() === '') {
    throw new TypeError('inspectRuntimeBinaries: binaryName is required');
  }
  const dirs = resolution.targetDirs;
  if (resolution.unverifiable) {
    return {
      status: 'unverifiable',
      blocking: true,
      severity: 'FAIL',
      targetDirs: [],
      source: 'unverifiable',
      legacyDir: resolution.legacyDir,
      legacyPresent: false,
      binaries: [],
      releases: [],
      newest: null,
      staleByMs: 0,
      message: `runtime binary freshness UNVERIFIABLE — cargo target dir could not be resolved (${resolution.reason})`,
      hint: 'run `cargo metadata --no-deps --offline --locked --format-version 1` in packages/runtime (or set CARGO_TARGET_DIR); an unknown target dir means we cannot tell which runtime binary this window would run',
      reason: resolution.reason,
    };
  }
  const binaries = [];
  const releases = [];
  for (const target of dirs) {
    const debugPath = `${target.dir}/debug/${binaryName}`;
    if (exists(debugPath)) binaries.push({ label: target.label, path: debugPath, mtimeMs: stat(debugPath).mtimeMs });
    const releasePath = `${target.dir}/release/${binaryName}`;
    if (exists(releasePath)) releases.push({ label: target.label, path: releasePath, mtimeMs: stat(releasePath).mtimeMs });
  }
  const base = {
    targetDirs: dirs,
    source: resolution.source,
    legacyDir: resolution.legacyDir,
    legacyPresent: Boolean(exists(resolution.legacyDir)),
    binaries,
    releases,
    newest: null,
    staleByMs: 0,
  };
  if (binaries.length === 0) {
    return {
      ...base,
      status: 'missing',
      blocking: false,
      severity: null,
      message: '',
      hint: '',
      reason: 'no debug binary in any resolved target dir — the first `cargo run` will build it',
    };
  }
  const newest = binaries.reduce((best, entry) => (entry.mtimeMs > best.mtimeMs ? entry : best));
  const staleByMs = sourceNewest ? Math.max(0, sourceNewest.mtimeMs - newest.mtimeMs) : 0;
  if (staleByMs > 0) {
    return {
      ...base,
      newest,
      staleByMs,
      status: 'stale',
      blocking: false,
      severity: 'WARN',
      message: `runtime debug binary (${newest.label}) is older than runtime sources by ${Math.round(staleByMs / 1000)}s`,
      hint: '`cargo run` will rebuild first (minutes); prebuild to keep the window short',
      reason: 'newest debug binary is older than the newest runtime source file',
    };
  }
  return {
    ...base,
    newest,
    status: 'fresh',
    blocking: false,
    severity: null,
    message: '',
    hint: '',
    reason: 'newest debug binary is newer than every runtime source file',
  };
}
