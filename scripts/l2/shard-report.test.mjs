#!/usr/bin/env node
// 回归（task-59 / BL-572）：`shard-report.mjs` 的两件事各自钉住 ——
//
// ① **根解析**：`execFileSync` 曾经缺 `node:child_process` import ⇒ 调用即 `ReferenceError` ⇒ 被
//    `catch {}` 吞掉 ⇒ `readToplevel()` 恒 null ⇒ `ROOT` 静默退回 `process.cwd()`。从子目录跑会
//    读错根，而且一声不响。
// ② **结论与退出码**：`coverage.ok` 曾经只看 missing/unexpected/duplicates 为空 ⇒ `expected==0`
//    时恒 true、整个脚本没有 exit ⇒ 空输入印 `coverage ok=true` 并 exit 0（假绿门）。
//    现在 expected==0 ⇒ NOT_EVALUATED + exit 2。判据矩阵在 `lib/coverage-verdict.test.mjs`，
//    这里只测**真进程**的行为（argv → stdout → 退出码）。
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

/** 只负责跑，不预设退出码 —— 结论由各用例自己断言（退出码本身就是被测行为之一）。 */
function run(args, cwd) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.error, undefined, `spawn failed: ${result.error}`);
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
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
  const { stdout, status } = run([], SUBDIR);
  assert.equal(normalise(rootLine(stdout)), normalise(REPO_ROOT));
  // 真根一定有分母（CP 有几百个测试类）⇒ 结论只能是 PASS(0) / FAIL(1)，**永不许是 NOT_EVALUATED(2)**。
  // 这条断言守的是「分母被读丢」：曾经读 `classes`/`classNames`，而 helper 返回的是 `expected` ⇒ 恒 0。
  assert.ok([0, 1].includes(status), `real repo root must have a denominator (exit 0/1), got ${status}:\n${stdout}`);
  assert.match(stdout, /expected=[1-9]\d*/, stdout);
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

test('空根（expected==0）⇒ NOT_EVALUATED + exit 2，且绝不印 coverage ok=true', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shard-report-empty-'));
  try {
    const { stdout, status } = run(['--root', dir], SUBDIR);
    assert.equal(status, 2, `expected NOT_EVALUATED/exit 2, got ${status}:\n${stdout}`);
    assert.match(stdout, /=== coverage NOT_EVALUATED /, stdout);
    assert.match(stdout, /expected=0\b/, stdout);
    // BL-572 的原始症状：这一行曾经长成 "=== coverage ok=true expected=0 ran=0 ..."。
    assert.doesNotMatch(stdout, /coverage ok=true/, stdout);
    assert.doesNotMatch(stdout, /=== coverage PASS /, stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
