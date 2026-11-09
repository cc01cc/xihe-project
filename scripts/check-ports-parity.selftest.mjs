#!/usr/bin/env node
/**
 * check-ports-parity.mjs 的 parent-less 自测（PLAN-0703 M4 + task-61 P1-3）：
 * 把脚本 + stack-ports + .env.dev 复制到一个没有 ONE 祖先的临时目录，断言
 * ①默认仍 exit 0（单独 clone 可运行），但必须是**显式 SKIP**（`skipped:true` + 人读行 `SKIP (`）——跳过 ≠ 通过；
 * ②`--require-mirror` 必须 fail-closed：exit 2、输出点名 `require-mirror`、且不以 `OK (` 开头。
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
  const runSelf = (args) => spawnSync(process.execPath, ['scripts/check-ports-parity.mjs', ...args], {
    cwd: temp,
    encoding: 'utf8',
  });

  const res = runSelf([]);
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  assert.equal(res.status, 0, out);
  assert.match(out, /standalone/u);
  // task-61 P1-3 §2.5：缺陷正是「跳过与通过共用 exit 0，且人读行以 OK ( 开头」。
  assert.match(out, /SKIP \(standalone/u, '脱离 ONE 时必须是显式 SKIP，不能写成 OK（跳过 ≠ 通过）');
  assert.doesNotMatch(out, /OK \(/u, 'standalone 不得以 OK ( 开头');
  console.log('[selftest] OK: parent-less parity exits 0 with SKIP line');

  // AC-3.3：mode==="standalone" ⇒ skipped===true（旧版把 skipped 硬编码 false，消费方读成「没跳过」）
  const degraded = JSON.parse(runSelf(['--json']).stdout);
  assert.equal(degraded.mode, 'standalone');
  assert.equal(degraded.skipped, true, 'standalone ⇒ skipped 必须为 true');
  assert.equal(degraded.ok, true, '无漂移且未要求镜像 ⇒ ok:true');
  assert.equal(degraded.requireMirror, false);
  console.log('[selftest] OK: standalone json reports skipped:true (AC-3.3)');

  // AC-3.1：--require-mirror + 找不到 ONE 根 ⇒ exit 2 fail-closed（旧版把未识别 flag 直接忽略 ⇒ exit 0）
  const rm = runSelf(['--require-mirror']);
  const rmOut = `${rm.stdout ?? ''}${rm.stderr ?? ''}`;
  assert.equal(rm.status, 2, rmOut);
  assert.match(rmOut, /require-mirror/u, 'FAIL 文案必须点名 --require-mirror，否则读的人不知道该补 ONE 工作区');
  assert.doesNotMatch(rmOut, /OK \(/u, '--require-mirror 缺 ONE 根时不得报 OK');
  const rmJson = JSON.parse(runSelf(['--require-mirror', '--json']).stdout);
  assert.equal(rmJson.ok, false);
  assert.equal(rmJson.skipped, true, '仍然是「跳过」，只是门禁拒绝接受跳过');
  assert.equal(rmJson.requireMirror, true);
  console.log('[selftest] OK: --require-mirror without ONE root => exit 2 fail-closed (AC-3.1)');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
