#!/usr/bin/env node
/**
 * Hard timeout for a single command (gate tasks need one; `mise` tasks have no `timeout` field —
 * verified 2026-11-04 on mise 2026.7.15: an unknown `timeout` key is silently ignored).
 *
 * Why a shared wrapper instead of occasional shell tricks: the ignored-suite gate (BL-262 follow-up)
 * pins **measured** baselines per test, and a timeout is only meaningful when it is derived from a
 * measurement and enforced the same way everywhere. A gate that hangs is worse than one that fails:
 * it blocks the lane instead of telling it what broke.
 *
 * Usage:
 *   node scripts/run-with-timeout.mjs --timeout-sec N -- <command> [args...]
 *
 * Exit codes: child's exit code; 124 on timeout; 2 on usage error.
 * Limitation (Windows): the timeout kills the spawned process, not its whole subtree — the runner
 * prints a TIMEOUT line so the caller can clean up (all gated commands here are `cargo test`).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const TIMEOUT_EXIT_CODE = 124;
const USAGE_EXIT_CODE = 2;

/** @param {string[]} argv */
export function parseArgs(argv) {
    const separator = argv.indexOf('--');
    if (separator < 0) return { error: 'missing `--` separator before the command' };
    const options = { timeoutSec: 0 };
    for (let index = 0; index < separator; index += 1) {
        const arg = argv[index];
        if (arg === '--timeout-sec') {
            options.timeoutSec = Number(argv[index + 1] ?? Number.NaN);
            index += 1;
        } else if (arg.startsWith('--timeout-sec=')) {
            options.timeoutSec = Number(arg.slice('--timeout-sec='.length));
        } else return { error: `unknown option: ${arg}` };
    }
    const command = argv.slice(separator + 1);
    if (!Number.isFinite(options.timeoutSec) || options.timeoutSec <= 0) {
        return { error: '--timeout-sec must be a positive number of seconds' };
    }
    if (command.length === 0) return { error: 'no command after `--`' };
    return { timeoutSec: options.timeoutSec, command };
}

function main() {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.error) {
        console.error(`[run-with-timeout] ERROR: ${parsed.error}`);
        console.error('usage: node scripts/run-with-timeout.mjs --timeout-sec N -- <command> [args...]');
        process.exit(USAGE_EXIT_CODE);
    }
    const { timeoutSec, command } = parsed;
    const [target, ...args] = command;
    // Windows: a bare `cargo` only resolves through cmd.exe (PATHEXT). An explicit `*.exe`/`*.cmd`
    // path must NOT go through the shell — a path like `C:\Program Files\…\node.exe` would be split
    // on its spaces and fail with "'C:\Program' is not recognized".
    const useShell = process.platform === 'win32' && !/\.(?:exe|cmd|bat)$/iu.test(target);
    const started = Date.now();
    const result = spawnSync(target, args, {
        stdio: 'inherit',
        timeout: timeoutSec * 1000,
        windowsHide: true,
        shell: useShell,
    });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (result.error && result.error.code === 'ETIMEDOUT') {
        console.error(`[run-with-timeout] TIMEOUT after ${timeoutSec}s (elapsed ${elapsed}s): ${command.join(' ')}`);
        process.exit(TIMEOUT_EXIT_CODE);
    }
    if (result.error) {
        console.error(`[run-with-timeout] ERROR spawning ${target}: ${result.error.message}`);
        process.exit(1);
    }
    if (result.status === null) {
        console.error(`[run-with-timeout] terminated by ${result.signal ?? 'unknown signal'} after ${elapsed}s`);
        process.exit(TIMEOUT_EXIT_CODE);
    }
    process.exit(result.status);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
