#!/usr/bin/env node
// 检查 Runtime target 占用与 workspace 缓存归属（DEV-002 §6 水位线只适用于 in-tree runtime target）。
// 输出：默认人类可读（首行保持 target=/debug=/release=/h_free=/verdict= 兼容既有调用）；--json 输出结构化 JSON。
// 退出码：0 = 正常/观察，1 = 越过强制线（in-tree >=20G 或 H 余量 <5G），2 = 检查不完整（无法读取 H 余量/扫描失败）。
// 零依赖，Node 24+；只读 fs 统计，不枚举删除、不调用 cargo。
import { existsSync, readdirSync, readFileSync, statSync, statfsSync } from 'node:fs';
import { join, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = join(root, 'packages', 'runtime', 'target');
const GB = 1024 ** 3;
const NORMAL_BYTES = 12 * GB;
const WARN_BYTES = 15 * GB;
const FORCE_BYTES = 20 * GB;
const FREE_FORCE_BYTES = 5 * GB;
const JSON_MODE = process.argv.includes('--json');
// task-80: the per-stack cargo target family may live on another volume. This check must
// look at THAT root — a check that measures a directory nobody builds into reports green
// about nothing. Unset => the pre-080 `<one>/.tmp/cargo-target` derivation, unchanged.
const CARGO_TARGET_ROOT_ENV = 'XH_CARGO_TARGET_ROOT';

// Runtime 自身 crate 与 XS（xingshu）独有 crate：作为归属的一级证据（fingerprint 目录名去 hash）。
const XH_CRATE_PREFIXES = ['xihe-runtime', 'xihe-container-runtime', 'xihe-stdio-fixture'];
const XS_CRATE_PREFIXES = ['xingshu-cli', 'xingshu-core', 'xingshu-server'];
// dep-info 源路径前缀（二级证据）：workspace 下的仓库目录名。
const SOURCE_OWNER = { 'A03-xihe': 'XH', 'A08-xingshu': 'XS' };

function fmt(bytes) {
  return `${(bytes / GB).toFixed(2)}G`;
}

function dirStats(dir, allowMissing = false) {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return { bytes: 0, files: 0, exists: false };
    throw error;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirStats(p, true);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      bytes += statSync(p).size;
      files += 1;
    }
  }
  return { bytes, files, exists: true };
}

function profileStats(profileDir) {
  return dirStats(profileDir, true);
}

function fingerprintOwner(profileDir) {
  const fingerprintDir = join(profileDir, '.fingerprint');
  let entries;
  try {
    entries = readdirSync(fingerprintDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name.replace(/-[0-9a-f]{16}$/, ''));
  const xh = names.find((name) => XH_CRATE_PREFIXES.some((prefix) => name === prefix));
  if (xh) return { owner: 'XH', evidence: `fingerprint:${xh}` };
  const xs = names.find((name) => XS_CRATE_PREFIXES.some((prefix) => name === prefix));
  if (xs) return { owner: 'XS', evidence: `fingerprint:${xs}` };
  return null;
}

// 二级证据：target 根只有 bin 的 *.d（deps/*.d 只含 registry 源，不用于归属）。
function depInfoOwner(profileDir) {
  let entries;
  try {
    entries = readdirSync(profileDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const found = new Set();
  const roots = new Set();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.d')) continue;
    let text;
    try {
      text = readFileSync(join(profileDir, entry.name), 'utf8');
    } catch (error) {
      continue;
    }
    for (const match of text.matchAll(/[A-Za-z]:[\\/]zeogit[\\/]one[\\/]([^\\/\s]+)/g)) {
      if (match[1] === '.local') continue; // 输出路径（target 自身）不是源树证据
      roots.add(match[1]);
      const owner = SOURCE_OWNER[match[1]];
      if (owner) found.add(`${owner}:${match[1]}`);
    }
  }
  if (found.size === 0) {
    // 有源路径但不属于已知项目（如 PLAN 探针 crate）：保留线索，owner 仍为 unknown。
    if (roots.size > 0) return { owner: 'unknown', evidence: `depinfo:${[...roots].sort().join(',')}` };
    return null;
  }
  const owners = new Set([...found].map((item) => item.split(':')[0]));
  if (owners.size > 1) return { owner: 'mixed', evidence: [...found].join(',') };
  const [first] = found;
  return { owner: first.split(':')[0], evidence: `depinfo:${first.split(':')[1]}` };
}

function detectOwner(dir) {
  for (const profile of ['debug', 'release']) {
    const profileDir = join(dir, profile);
    const byFingerprint = fingerprintOwner(profileDir);
    if (byFingerprint) return byFingerprint;
    const byDepInfo = depInfoOwner(profileDir);
    if (byDepInfo) return byDepInfo;
  }
  return { owner: 'unknown', evidence: 'no-fingerprint-or-depinfo-evidence' };
}

// one/.tmp/cargo-target：从当前仓库根向上找到包含 .tmp/cargo-target 的 workspace 根（2026-11-01 起构建输出统一落 .tmp）。
// task-80: `XH_CARGO_TARGET_ROOT` wins over the walk-up derivation. A set-but-unusable
// value is a hard failure: reporting on a directory nobody builds into is the exact
// "green about nothing" failure this script exists to prevent.
function configuredExternalRoot() {
  const raw = typeof process.env[CARGO_TARGET_ROOT_ENV] === 'string' ? process.env[CARGO_TARGET_ROOT_ENV].trim() : '';
  if (raw === '') return null;
  if (!isAbsolute(raw)) {
    console.error(`error: ${CARGO_TARGET_ROOT_ENV} must be an absolute path (got "${raw}")`);
    process.exit(2);
  }
  const resolved = resolve(raw);
  if (!existsSync(resolved)) {
    console.error(
      `error: ${CARGO_TARGET_ROOT_ENV}=${resolved} does not exist; refusing to report on a directory that no build writes to`,
    );
    process.exit(2);
  }
  return resolved;
}

function deriveExternalRoot() {
  const override = process.env.CARGO_TARGET_DIR;
  if (override) {
    // Pre-080 this used the regex `\.[\\/]tmp[\\/]cargo-target…`, which expects ".<sep>tmp"
    // while real paths are "<sep>.tmp" — it never matched, so a CARGO_TARGET_DIR pointing
    // outside the walk-up tree was silently ignored. Fixed while adding the root variable
    // (task-80); behavior only changes when CARGO_TARGET_DIR really points at such a root.
    const resolved = resolve(override);
    const matched = /[\\/]\.tmp[\\/]cargo-target(?:[\\/][^\\/]+)?$/.test(resolved);
    if (matched) return /[\\/]\.tmp[\\/]cargo-target$/.test(resolved) ? resolved : join(resolved, '..');
  }
  let current = root;
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(current, '.tmp', 'cargo-target');
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch (error) {
      // 继续向上找
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function findExternalRoot() {
  return configuredExternalRoot() ?? deriveExternalRoot();
}

// task-80: after the target family moved volumes the stacks keep running from an already
// deleted image, and `<root>/main/debug/xihe-runtime.exe` only reappears on the next build
// or restart. That absence is EXPECTED, so it must never read as FAIL/gate-block. Classify
// explicitly (present / migrated-away / unverifiable) and never let it touch `verdict`.
function probeRuntimeBinary() {
  const raw = typeof process.env[CARGO_TARGET_ROOT_ENV] === 'string' ? process.env[CARGO_TARGET_ROOT_ENV].trim() : '';
  // A linked worktree namespaces its keys under <root>/<worktree-dir>/ (see
  // stack-cargo-target.mjs), so probe that layout too when this checkout is one.
  let laneName = null;
  try {
    if (statSync(join(root, '.git')).isFile()) laneName = root.split(/[\\/]/).pop();
  } catch (error) {
    laneName = null;
  }
  const roots = [];
  if (raw !== '') roots.push({ root: resolve(raw), source: 'env' });
  const derived = deriveExternalRoot();
  if (derived) roots.push({ root: derived, source: 'derived' });
  const candidates = [];
  for (const entry of roots) {
    candidates.push({ bin: join(entry.root, 'main', 'debug', 'xihe-runtime.exe'), root: entry.root, rootSource: entry.source });
    if (laneName) {
      candidates.push({
        bin: join(entry.root, laneName, 'main', 'debug', 'xihe-runtime.exe'),
        root: entry.root,
        rootSource: entry.source,
      });
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate.bin)) {
      return {
        path: candidate.bin,
        root: candidate.root,
        rootSource: candidate.rootSource,
        exists: true,
        classification: 'present',
        note: 'default-stack runtime binary present; not a freshness assertion',
      };
    }
  }
  const configured = candidates.find((c) => c.rootSource === 'env');
  if (configured) {
    return {
      path: configured.bin,
      root: configured.root,
      rootSource: 'env',
      exists: false,
      classification: 'migrated-away',
      note: `${CARGO_TARGET_ROOT_ENV} is set and that root has no default-stack runtime binary yet: normal state right after the target family moved volumes (and after a clean); it comes back on the next build or stack restart. NOT a failure, never gate-blocking.`,
    };
  }
  return {
    path: candidates.length ? candidates[0].bin : null,
    root: candidates.length ? candidates[0].root : null,
    rootSource: candidates.length ? candidates[0].rootSource : null,
    exists: false,
    classification: 'unverifiable',
    note: 'no runtime binary at any known root and no configured root: cannot tell "never built" from "moved without configuration"; not gate-blocking.',
  };
}

// 2026-11-01 用户裁定：构建输出统一落 one/.tmp（cargo-target / venvs），.local 只放运行产物与证据。
// 这里检测历史遗留的 `.local/cargo-target`，只报告不删除。
function legacyLocalRoot(externalRoot) {
  const base = externalRoot ? dirname(dirname(externalRoot)) : root;
  const candidate = join(base, '.local', 'cargo-target');
  try {
    return statSync(candidate).isDirectory() ? candidate : null;
  } catch (error) {
    return null;
  }
}

function scanExternalRoot() {
  const externalRoot = findExternalRoot();
  if (!externalRoot) {
    return { path: null, exists: false, note: 'workspace .tmp/cargo-target not found' };
  }
  let entries;
  try {
    entries = readdirSync(externalRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { path: externalRoot, exists: false, note: 'not found' };
    throw error;
  }
  const dirs = [];
  let totalBytes = 0;
  let totalFiles = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(externalRoot, entry.name);
    const item = { name: entry.name, bytes: 0, files: 0, owner: 'unknown', evidence: 'scan-failed' };
    try {
      const stats = dirStats(dir, true);
      const owner = detectOwner(dir);
      item.bytes = stats.bytes;
      item.files = stats.files;
      item.owner = owner.owner;
      item.evidence = owner.evidence;
    } catch (error) {
      // 并发构建可能瞬时拒绝访问：保留该目录项并标注，而不是让整个检查失败。
      item.evidence = `scan-error:${error.code ?? error.message}`;
    }
    totalBytes += item.bytes;
    totalFiles += item.files;
    dirs.push(item);
  }
  dirs.sort((a, b) => b.bytes - a.bytes);
  const legacy = legacyLocalRoot(externalRoot);
  return {
    path: externalRoot,
    exists: true,
    totalBytes,
    totalFiles,
    dirs,
    ...(legacy ? { legacyLocal: legacy } : {}),
  };
}

function scanCargoTargetDir(externalRoot) {
  const value = process.env.CARGO_TARGET_DIR;
  if (!value) return { set: false };
  const resolved = resolve(value);
  const stats = dirStats(resolved, true);
  const debug = profileStats(join(resolved, 'debug'));
  const release = profileStats(join(resolved, 'release'));
  // Prefix check instead of a `.tmp/cargo-target` regex: with XH_CARGO_TARGET_ROOT the
  // root can be any absolute path, but "is this inside the shared root?" stays answerable.
  const normalizedRoot = externalRoot ? resolve(externalRoot) : null;
  const insideExternalRoot = Boolean(normalizedRoot) && (resolved === normalizedRoot || resolved.startsWith(normalizedRoot + sep));
  return {
    set: true,
    path: resolved,
    exists: stats.exists,
    bytes: stats.bytes,
    files: stats.files,
    debugBytes: debug.bytes,
    releaseBytes: release.bytes,
    insideExternalRoot,
    name: insideExternalRoot ? relative(normalizedRoot, resolved).split(sep)[0] : null,
  };
}

let inTree = { bytes: 0, files: 0, exists: false };
let debugBytes = 0;
let releaseBytes = 0;
try {
  const debug = profileStats(join(targetDir, 'debug'));
  const release = profileStats(join(targetDir, 'release'));
  debugBytes = debug.bytes;
  releaseBytes = release.bytes;
  inTree = { bytes: debugBytes + releaseBytes, files: debug.files + release.files, exists: existsSync(targetDir) };
} catch (error) {
  console.error(`error: unable to scan Runtime target directories: ${error.message}`);
  process.exit(2);
}

let free = null;
let freeError = null;
try {
  const fsStat = statfsSync(root.slice(0, 3));
  free = Number(fsStat.bavail) * Number(fsStat.bsize);
} catch (error) {
  // An unknown free-space measurement cannot be reported as a successful check.
  freeError = error.message;
}

let verdict = 'UNKNOWN';
if (inTree.bytes >= FORCE_BYTES || (free !== null && free < FREE_FORCE_BYTES)) verdict = 'FORCE';
else if (free !== null && inTree.bytes >= WARN_BYTES) verdict = 'WARN';
else if (free !== null && inTree.bytes > NORMAL_BYTES) verdict = 'WATCH';
else if (free !== null) verdict = 'OK';

let externalRoot = { path: null, exists: false, note: 'not scanned' };
let cargoTargetDir = { set: false };
if (JSON_MODE || verdict !== 'UNKNOWN') {
  try {
    externalRoot = scanExternalRoot();
    cargoTargetDir = scanCargoTargetDir(externalRoot.path);
  } catch (error) {
    console.error(`error: unable to scan workspace cargo-target root: ${error.message}`);
    process.exit(2);
  }
}
const runtimeBinary = probeRuntimeBinary();

if (JSON_MODE) {
  const payload = {
    generatedAt: new Date().toISOString(),
    repoRoot: root,
    driveFreeBytes: free,
    driveFreeGiB: free === null ? null : Number((free / GB).toFixed(3)),
    verdict,
    waterLines: {
      note: 'DEV-002 §6 applies to in-tree Runtime target only; never to workspace-wide totals',
      normalBytes: NORMAL_BYTES,
      warnBytes: WARN_BYTES,
      forceBytes: FORCE_BYTES,
      freeForceBytes: FREE_FORCE_BYTES,
    },
    inTreeTarget: {
      path: relative(root, targetDir).split('\\').join('/'),
      exists: inTree.exists,
      bytes: inTree.bytes,
      files: inTree.files,
      debugBytes,
      releaseBytes,
    },
    cargoTargetDir,
    runtimeBinary,
    externalRoot: {
      path: externalRoot.path,
      exists: externalRoot.exists,
      source: typeof process.env[CARGO_TARGET_ROOT_ENV] === 'string' && process.env[CARGO_TARGET_ROOT_ENV].trim() !== '' ? 'env' : 'derived',
      totalBytes: externalRoot.totalBytes ?? 0,
      totalFiles: externalRoot.totalFiles ?? 0,
      dirs: externalRoot.dirs ?? [],
      note: 'workspace-shared root; per-dir owner is evidence-based (XH/XS/unknown), not compared to Runtime water lines',
      ...(externalRoot.note ? { detail: externalRoot.note } : {}),
    },
  };
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(
    `target=${fmt(inTree.bytes)} debug=${fmt(debugBytes)} release=${fmt(releaseBytes)} h_free=${free !== null ? fmt(free) : 'unknown'} verdict=${verdict}`,
  );
  console.log('water lines (DEV-002 §6): normal <=12G, watch >12G, warn >=15G, force >=20G, H free <5G = force');
  if (externalRoot.legacyLocal) {
    console.log('WARN legacy .local/cargo-target still exists: ' + externalRoot.legacyLocal + ' (build outputs must live under one/.tmp; see AGENTS.md)');
  }
  console.log(
    `in-tree runtime target: ${relative(root, targetDir).split('\\').join('/')} exists=${inTree.exists} ` +
      `total=${fmt(inTree.bytes)} debug=${fmt(debugBytes)} release=${fmt(releaseBytes)} files=${inTree.files}`,
  );
  if (cargoTargetDir.set) {
    console.log(
      `current CARGO_TARGET_DIR: ${cargoTargetDir.path} exists=${cargoTargetDir.exists} ` +
        `total=${fmt(cargoTargetDir.bytes)} files=${cargoTargetDir.files}` +
        (cargoTargetDir.insideExternalRoot ? ` (external root dir: ${cargoTargetDir.name})` : ''),
    );
  } else {
    console.log('current CARGO_TARGET_DIR: <unset>');
  }
  console.log(
    `default-stack runtime binary: ${runtimeBinary.path ?? '<unknown>'} classification=${runtimeBinary.classification} ` +
      `(rootSource=${runtimeBinary.rootSource ?? 'none'}; informational only, never blocks)`,
  );
  if (!runtimeBinary.exists && runtimeBinary.classification !== 'present') {
    console.log(`  note: ${runtimeBinary.note}`);
  }
  if (externalRoot.exists) {
    const rootSource =
      typeof process.env[CARGO_TARGET_ROOT_ENV] === 'string' && process.env[CARGO_TARGET_ROOT_ENV].trim() !== ''
        ? ` via ${CARGO_TARGET_ROOT_ENV}`
        : ' (derived: workspace .tmp/cargo-target)';
    console.log(
      `shared external root: ${externalRoot.path}${rootSource} total=${fmt(externalRoot.totalBytes)} files=${externalRoot.totalFiles} dirs=${externalRoot.dirs.length}`,
    );
    console.log('  (owner is evidence-based: fingerprint local crate > dep-info source path > unknown; not compared to Runtime water lines)');
    for (const dir of externalRoot.dirs) {
      console.log(
        `  - ${dir.name} ${fmt(dir.bytes)} ${dir.files} files owner=${dir.owner} (${dir.evidence})`,
      );
    }
  } else {
    console.log(`shared external root: <not found>${externalRoot.note ? ` (${externalRoot.note})` : ''}`);
  }
}

if (verdict === 'FORCE') {
  console.log('action: run `mise run clean:runtime-sweep`; if still >=20G, remove target/debug/incremental (DEV-002 §6)');
  process.exit(1);
}
if (verdict === 'UNKNOWN') {
  console.error(`error: unable to determine H drive free space (${freeError}); runtime target check is incomplete`);
  process.exit(2);
}
process.exit(0);
