/**
 * task-257: classify the exit of a runner-owned service (CP / Agent / Runtime / UI / fixture).
 *
 * Why this exists: after the Playwright suite finishes, `cleanup()` stops the runner's own
 * services. On Windows a terminated python/uv child reports `code=1`, and the boot-time fail-fast
 * (`!shuttingDown && code !== 0 ⇒ abortRun`) read that as a test failure, turning a fully green
 * run into `exit=1`. The fail-fast must stay for `boot`/`tests` (a real crash there invalidates the
 * run), but a nonzero exit inside the cleanup window is expected and only WARNs.
 *
 * @param {object} options
 * @param {number|null} [options.code]          child exit code (`null` when killed by signal)
 * @param {string|null} [options.signal]        child signal (`null` on Windows)
 * @param {boolean} [options.shuttingDown]      runner already entered its shutdown path
 * @param {'boot'|'tests'|'cleanup'} [options.phase] lifecycle phase the exit was observed in
 * @returns {'fail'|'warn'|'ignore'} `fail` keeps the old abortRun behaviour, `warn` logs only,
 *   `ignore` is a clean exit
 */
export function classifyChildExit({ code = null, signal = null, shuttingDown = false, phase = 'boot' } = {}) {
    if (shuttingDown || phase === 'cleanup') return code === 0 ? 'ignore' : 'warn';
    if (code === null) return signal ? 'fail' : 'ignore';
    if (code === 0) return 'ignore';
    return phase === 'boot' || phase === 'tests' ? 'fail' : 'warn';
}
