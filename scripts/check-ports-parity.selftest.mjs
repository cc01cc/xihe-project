#!/usr/bin/env node
/**
 * check-ports-parity.mjs 的 parent-less 自测（PLAN-0703 M4）：
 * 把脚本 + stack-ports + .env.dev 复制到一个没有 ONE 祖先的临时目录，断言
 * 输出含 standalone 且 exit 0（不是 skip，也不是失败）。
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'xh-parity-standalone-'));
try {
  mkdirSync(join(temp, 'scripts', 'lib'), { recursive: true });
  for (const rel of ['scripts/check-ports-parity.mjs', 'scripts/lib/stack-ports.mjs', '.env.dev']) {
    cpSync(join(root, rel), join(temp, rel));
  }
  const res = spawnSync(process.execPath, ['scripts/check-ports-parity.mjs'], {
    cwd: temp,
    encoding: 'utf8',
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  assert.equal(res.status, 0, out);
  assert.match(out, /standalone/u);
  console.log('[selftest] OK: parent-less parity exits 0 with standalone line');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
