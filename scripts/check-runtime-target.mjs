#!/usr/bin/env node
// 检查 packages/runtime/target 占用 vs DEV-002 §6 水位线：正常 <=12GB / 告警 15GB / 强制 20GB；H 余量 <5GB = 强制。
// 输出 key=value 一行 + 建议；exit 1 = 越过强制线。零依赖，Node 24+。
import { readdirSync, statSync, statfsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = join(root, 'packages', 'runtime', 'target');
const GB = 1024 ** 3;
const NORMAL_BYTES = 12 * GB;
const WARN_BYTES = 15 * GB;
const FORCE_BYTES = 20 * GB;
const FREE_FORCE_BYTES = 5 * GB;

function dirBytes(dir, allowMissing = false) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return 0;
    throw error;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

function fmt(bytes) {
  return `${(bytes / GB).toFixed(2)}G`;
}

let debugBytes = 0;
let releaseBytes = 0;
try {
  debugBytes = dirBytes(join(targetDir, 'debug'), true);
  releaseBytes = dirBytes(join(targetDir, 'release'), true);
} catch (error) {
  console.error(`error: unable to scan Runtime target directories: ${error.message}`);
  process.exit(2);
}
const total = debugBytes + releaseBytes;

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
if (total >= FORCE_BYTES || (free !== null && free < FREE_FORCE_BYTES)) verdict = 'FORCE';
else if (free !== null && total >= WARN_BYTES) verdict = 'WARN';
else if (free !== null && total > NORMAL_BYTES) verdict = 'WATCH';
else if (free !== null) verdict = 'OK';

console.log(
  `target=${fmt(total)} debug=${fmt(debugBytes)} release=${fmt(releaseBytes)} h_free=${free !== null ? fmt(free) : 'unknown'} verdict=${verdict}`,
);
console.log('water lines (DEV-002 §6): normal <=12G, watch >12G, warn >=15G, force >=20G, H free <5G = force');

if (verdict === 'FORCE') {
  console.log('action: run `mise run clean:runtime-sweep`; if still >=20G, remove target/debug/incremental (DEV-002 §6)');
  process.exit(1);
}
if (verdict === 'UNKNOWN') {
  console.error(`error: unable to determine H drive free space (${freeError}); runtime target check is incomplete`);
  process.exit(2);
}
process.exit(0);
