/**
 * `run-with-timeout.mjs` tests: the gate's hard timeout must pass through exit codes unchanged and
 * must actually fire (a timeout that never trips is the same as no timeout at all).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

import { TIMEOUT_EXIT_CODE, parseArgs } from './run-with-timeout.mjs';

const runner = join(import.meta.dirname, 'run-with-timeout.mjs');
const node = process.execPath;

function run(args) {
    return spawnSync(node, [runner, ...args], { encoding: 'utf8', windowsHide: true });
}

test('parseArgs requires `--`, a command and a positive timeout', () => {
    assert.match(parseArgs(['--timeout-sec', '5']).error, /missing `--`/u);
    assert.match(parseArgs(['--timeout-sec', '5', '--']).error, /no command/u);
    assert.match(parseArgs(['--', 'echo']).error, /positive number/u);
    assert.deepEqual(parseArgs(['--timeout-sec', '5', '--', 'echo', 'hi']), {
        timeoutSec: 5,
        command: ['echo', 'hi'],
    });
});

test('passes a successful command through with exit 0', () => {
    const result = run(['--timeout-sec', '10', '--', node, '-e', 'process.exit(0)']);
    assert.equal(result.status, 0, result.stderr);
});

test('propagates a non-zero exit code unchanged', () => {
    const result = run(['--timeout-sec', '10', '--', node, '-e', 'process.exit(7)']);
    assert.equal(result.status, 7, result.stderr);
});

test('kills a hanging command and reports TIMEOUT with exit 124', () => {
    const result = spawnSync(
        node,
        [runner, '--timeout-sec', '1', '--', node, '-e', 'setTimeout(() => {}, 10000)'],
        { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
    );
    assert.equal(result.status, TIMEOUT_EXIT_CODE, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /TIMEOUT after 1s/u);
});

test('usage errors exit 2', () => {
    const result = run(['--timeout-sec', '5', 'echo']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage:/u);
});
