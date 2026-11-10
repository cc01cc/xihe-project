#!/usr/bin/env node
// 回归（task-59 / BL-572 前半）：`shard-report.mjs` 必须从任意子目录解析到 git toplevel。
//
// 背景：`execFileSync` 曾经缺 `node:child_process` import ⇒ 调用即 `ReferenceError` ⇒ 被 `catch {}` 吞掉
// ⇒ `readToplevel()` 恒返回 null ⇒ `ROOT` 静默退回 `process.cwd()`。从子目录跑会读错根，
// 而且**一声不响**（输出仍然是 `coverage ok=true` / exit 0 ⇒ 假绿）。
//
// 跑法：`node --test scripts/l2/shard-report.test.mjs`（已挂进 `mise run test:cli`）。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./shard-report.mjs', import.meta.url));
/** 仓库根：本文件在 `scripts/l2/` 下，不依赖 cwd。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** 任意子目录都行；这里选一个有 git 上下文但不是 toplevel 的真实目录。 */
const SUBDIR = join(REPO_ROOT, 'packages', 'control-plane');

function run(args, cwd) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `exit ${result.status}; stderr=${result.stderr}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

/** Windows 路径大小写与分隔符都不稳定，比较前统一。 */
function normalise(path) {
  return resolve(path).replaceAll('\\', '/').toLowerCase();
}

function rootLine(stdout) {
  const match = /^=== root: (.+)$/m.exec(stdout);
  assert.ok(match, `output has no "=== root:" line:\n${stdout}`);
  return match[1].trim();
}

test('resolves the git toplevel when invoked from a subdirectory', () => {
  const { stdout } = run([], SUBDIR);
  assert.equal(normalise(rootLine(stdout)), normalise(REPO_ROOT));
});

test('does not fall back to cwd instead of the toplevel', () => {
  const { stdout, stderr } = run([], SUBDIR);
  assert.notEqual(normalise(rootLine(stdout)), normalise(SUBDIR), 'ROOT collapsed to cwd — the toplevel lookup silently failed');
  assert.equal(stderr.trim(), '', `toplevel lookup must not fall back here: ${stderr}`);
});

test('explicit --root still wins over the toplevel lookup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shard-report-root-'));
  try {
    const { stdout } = run(['--root', dir], SUBDIR);
    assert.equal(normalise(rootLine(stdout)), normalise(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
