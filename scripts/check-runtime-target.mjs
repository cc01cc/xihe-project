#!/usr/bin/env node
// 检查 Runtime target 占用与 workspace 缓存归属（DEV-002 §6 水位线只适用于 in-tree runtime target）。
// 输出：默认人类可读（首行保持 target=/debug=/release=/h_free=/verdict= 兼容既有调用）；--json 输出结构化 JSON。
// 退出码：0 = 正常/观察，1 = 越过强制线（in-tree >=20G 或 H 余量 <5G），2 = 检查不完整（无法读取 H 余量/扫描失败）。
// 零依赖，Node 24+；只读 fs 统计，不枚举删除、不调用 cargo。
import { existsSync, readdirSync, readFileSync, statSync, statfsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = join(root, 'packages', 'runtime', 'target');
const GB = 1024 ** 3;
const NORMAL_BYTES = 12 * GB;
const WARN_BYTES = 15 * GB;
const FORCE_BYTES = 20 * GB;
const FREE_FORCE_BYTES = 5 * GB;
const JSON_MODE = process.argv.includes('--json');

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

// one/.local/cargo-target：从当前仓库根向上找到包含 .local/cargo-target 的 workspace 根。
function findExternalRoot() {
  const override = process.env.CARGO_TARGET_DIR;
  if (override) {
    const resolved = resolve(override);
    if (/\.[\\/]local[\\/]cargo-target[\\/][^\\/]+$/.test(resolved)) {
      return join(resolved, '..', '..');
    }
    if (/\.[\\/]local[\\/]cargo-target$/.test(resolved)) return resolved;
  }
  let current = root;
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(current, '.local', 'cargo-target');
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

function scanExternalRoot() {
  const externalRoot = findExternalRoot();
  if (!externalRoot) {
    return { path: null, exists: false, note: 'workspace .local/cargo-target not found' };
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
  return { path: externalRoot, exists: true, totalBytes, totalFiles, dirs };
}

function scanCargoTargetDir(externalRoot) {
  const value = process.env.CARGO_TARGET_DIR;
  if (!value) return { set: false };
  const resolved = resolve(value);
  const stats = dirStats(resolved, true);
  const debug = profileStats(join(resolved, 'debug'));
  const release = profileStats(join(resolved, 'release'));
  const insideExternalRoot = Boolean(externalRoot) && /[\\/]\.local[\\/]cargo-target[\\/]/.test(resolved);
  return {
    set: true,
    path: resolved,
    exists: stats.exists,
    bytes: stats.bytes,
    files: stats.files,
    debugBytes: debug.bytes,
    releaseBytes: release.bytes,
    insideExternalRoot,
    name: insideExternalRoot ? resolved.split(/[\\/]/).pop() : null,
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
    externalRoot: {
      path: externalRoot.path,
      exists: externalRoot.exists,
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
  if (externalRoot.exists) {
    console.log(
      `shared external root: ${externalRoot.path} total=${fmt(externalRoot.totalBytes)} files=${externalRoot.totalFiles} dirs=${externalRoot.dirs.length}`,
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
