#!/usr/bin/env node
// verify-evidence-snapshot.mjs — 证据栈「窗口前后一致性」快照（**只读**，task-228 G2）
//
// 用途：验证窗口**开窗前**与**关窗后**各跑一次，比较两次 JSON 的 `commit` / `digest`：
//   - 任一不一致 ⇒ 该窗口证据作废（classes 被 dev 热编、或构建被重跑过）。
//   - 相同 ⇒ 证明 classes 与 build-info 在窗口期间没被动过。
//
// 读法：`.xihe-stacks/<n>/.current` 的 `targetDir`（launcher 写的"该栈上次启动用的目录"），
// **不写死任何机器路径**；`classes` 摘要 = 相对路径清单 + 每文件 SHA256 合成再 SHA256。
//
// 用法：
//   node scripts/verify-evidence-snapshot.mjs                      # 默认 --stack 1，打到 stdout
//   node scripts/verify-evidence-snapshot.mjs --out <file.json>     # 另存 JSON（不得写进仓库）
//   node scripts/verify-evidence-snapshot.mjs --stack 2 --json
// 约束：只读（除 --out）；不删除、不写 build root、不改栈。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { cpBuildRoot, readPointer } from './lib/cp-build-dir.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const args = { stack: 1, out: null, help: false };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--stack') args.stack = Number(argv[(i += 1)]);
  else if (a.startsWith('--stack=')) args.stack = Number(a.slice('--stack='.length));
  else if (a === '--out') args.out = argv[(i += 1)];
  else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
  else if (a === '--help' || a === '-h') args.help = true;
  else {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  }
}
if (args.help) {
  console.log('usage: node scripts/verify-evidence-snapshot.mjs [--stack N=1] [--out <file.json>]');
  console.log('  开窗前/关窗后各跑一次；commit 或 digest 不一致 ⇒ 证据作废。只读（--out 除外）。');
  process.exit(0);
}
if (!Number.isInteger(args.stack) || args.stack < 1 || args.stack > 8) {
  console.error(`--stack must be 1..8 (got ${args.stack})`);
  process.exit(2);
}

const stackId = args.stack === 1 ? 'stack-1' : `stack-${args.stack}`;
const pointer = readPointer({ root: cpBuildRoot({ env: process.env }), stackId });
if (!pointer?.targetDir) {
  console.error(`E_NO_POINTER: ${stackId} 没有 .current 指针（先起栈，或该栈从未 start）`);
  process.exit(2);
}
const targetDir = pointer.targetDir;
const classesDir = path.join(targetDir, 'classes');
if (!fs.existsSync(classesDir)) {
  console.error(`E_NO_CLASSES: ${classesDir} 不存在（targetDir 指针可能过期）`);
  process.exit(2);
}

const buildInfoFile = path.join(classesDir, 'META-INF', 'build-info.properties');
const info = { commit: null, builtAt: null, dirty: null };
if (fs.existsSync(buildInfoFile)) {
  for (const line of fs.readFileSync(buildInfoFile, 'utf8').split(/\r?\n/)) {
    const m = /^(commit|builtAt|dirty)=(.+)$/.exec(line.trim());
    if (m) info[m[1]] = m[2].trim();
  }
}

// 遍历 classes：相对路径清单 (按路径排序) + 每文件 SHA256 → 再哈希一次作为 digest。
function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile()) acc.push(full);
  }
  return acc;
}
const files = walk(classesDir, []).sort((a, b) => a.localeCompare(b));
const manifest = files.map((full) => {
  const rel = path.relative(classesDir, full).replace(/\\/g, '/');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  return `${rel} ${hash}`;
}).join('\n');
const digest = crypto.createHash('sha256').update(manifest, 'utf8').digest('hex');
const bytes = files.reduce((sum, full) => sum + fs.statSync(full).size, 0);

const snapshot = {
  stack: stackId,
  targetDir,
  commit: info.commit,
  builtAt: info.builtAt,
  dirty: info.dirty,
  files: files.length,
  bytes,
  digest,
  capturedAt: new Date().toISOString(),
};

const text = `${JSON.stringify(snapshot, null, 2)}\n`;
if (args.out) {
  const outPath = path.resolve(args.out);
  if (outPath.toLowerCase().startsWith(projectRoot.toLowerCase() + path.sep)) {
    console.error(`E_OUT_IN_REPO: --out 不得写进仓库（${outPath}）；请用 .tmp/xh/ 或 zeotmp 下的临时目录`);
    process.exit(2);
  }
  fs.writeFileSync(outPath, text, 'utf8');
  process.stdout.write(text);
  console.error(`[snapshot] 已写入 ${outPath}`);
} else {
  process.stdout.write(text);
}
