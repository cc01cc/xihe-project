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
