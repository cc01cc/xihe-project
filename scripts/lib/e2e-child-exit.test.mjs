/**
 * task-257: positive/negative cases for the child-exit classifier.
 *
 * Run: node --test scripts/lib/e2e-child-exit.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyChildExit } from './e2e-child-exit.mjs';

test('a nonzero exit while the suite is running still fails the run (fail-fast kept)', () => {
    assert.equal(classifyChildExit({ code: 1, phase: 'boot' }), 'fail');
    assert.equal(classifyChildExit({ code: 1, phase: 'tests' }), 'fail');
    assert.equal(classifyChildExit({ code: 2, phase: 'tests', signal: null }), 'fail');
});

test('a signal death while running is a failure, not a clean exit', () => {
    assert.equal(classifyChildExit({ code: null, signal: 'SIGKILL', phase: 'tests' }), 'fail');
});

test('clean exits are ignored in every phase', () => {
    assert.equal(classifyChildExit({ code: 0, phase: 'boot' }), 'ignore');
    assert.equal(classifyChildExit({ code: 0, phase: 'tests' }), 'ignore');
    assert.equal(classifyChildExit({ code: 0, phase: 'cleanup' }), 'ignore');
});

test('a nonzero exit inside the cleanup window is downgraded to WARN (no abortRun)', () => {
    assert.equal(classifyChildExit({ code: 1, phase: 'cleanup' }), 'warn');
    assert.equal(classifyChildExit({ code: 1, phase: 'tests', shuttingDown: true }), 'warn');
    assert.equal(classifyChildExit({ code: 1, phase: 'boot', shuttingDown: true }), 'warn');
});

test('defaults are conservative: boot phase + unknown code', () => {
    assert.equal(classifyChildExit({}), 'ignore');
    assert.equal(classifyChildExit({ code: 1 }), 'fail');
});

// ── BL-538：声明式停机窗口（既有 task-257 的 5 组断言原样保留） ──────────
// 新增档位只有 'declared'：窗口内的非零退出不 abort，但调用方必须打审计日志。

const declaredWindow = { matches: true, spec: 'journey-b.spec.ts:B1-fail-human', startedAt: 0, expiresAt: 1 };

test('BL-538 声明窗口内的非零退出记 declared（不 abort，但必须打审计日志）', () => {
    assert.equal(classifyChildExit({ code: 1, phase: 'tests', intent: declaredWindow }), 'declared');
});

test('BL-538 窗口外/过期的声明不得放宽判据（仍 fail）', () => {
    assert.equal(classifyChildExit({ code: 1, phase: 'tests', intent: { ...declaredWindow, matches: false } }), 'fail');
    assert.equal(classifyChildExit({ code: 1, phase: 'tests', intent: {} }), 'fail');
});

test('BL-538 信号退出与 boot 阶段不因声明而放行', () => {
    assert.equal(classifyChildExit({ code: null, signal: 'SIGTERM', phase: 'tests', intent: declaredWindow }), 'fail');
    assert.equal(classifyChildExit({ code: 1, phase: 'boot', intent: declaredWindow }), 'fail');
});

test('BL-538 cleanup 窗口与干净退出的既有结论不受声明影响', () => {
    assert.equal(classifyChildExit({ code: 1, phase: 'cleanup', intent: declaredWindow }), 'warn');
    assert.equal(classifyChildExit({ code: 0, phase: 'tests', intent: declaredWindow }), 'ignore');
});
