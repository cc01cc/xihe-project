/**
 * task-257: classify the exit of a runner-owned service (CP / Agent / Runtime / UI / fixture).
 *
 * Why this exists: after the Playwright suite finishes, `cleanup()` stops the runner's own
 * services. On Windows a terminated python/uv child reports `code=1`, and the boot-time fail-fast
 * (`!shuttingDown && code !== 0 ⇒ abortRun`) read that as a test failure, turning a fully green
 * run into `exit=1`. The fail-fast must stay for `boot`/`tests` (a real crash there invalidates the
 * run), but a nonzero exit inside the cleanup window is expected and only WARNs.
 *
 * BL-538: the same blind spot exists *inside* `tests` — a spec that stops a service on purpose
 * (journey-b B1-fail-human kills the Runtime to exercise the human-readable error) is a runner-owned
 * child exiting non-zero during `tests`, so it was classified as a real crash and aborted the run.
 * Phase alone cannot tell "on purpose" from "crashed", so a spec may now **declare** a stop window
 * in advance (a single-use declaration the runner consumes on the first exit). Declared exits are
 * still graded (`declared`, never silent) and still audited by the caller; a `code=null + signal`
 * exit stays `fail` regardless of the declaration, because a signal death is not a planned stop.
 *
 * @param {object} options
 * @param {number|null} [options.code]          child exit code (`null` when killed by signal)
 * @param {string|null} [options.signal]        child signal (`null` on Windows)
 * @param {boolean} [options.shuttingDown]      runner already entered its shutdown path
 * @param {'boot'|'tests'|'cleanup'} [options.phase] lifecycle phase the exit was observed in
 * @param {{matches?: boolean}|null} [options.intent] BL-538 declared stop window (already validated
 *   by the caller: `matches` is `true` only while the declared window is still open)
 * @returns {'fail'|'warn'|'ignore'|'declared'} `fail` keeps the old abortRun behaviour, `warn` logs
 *   only, `ignore` is a clean exit, `declared` is a non-zero exit inside a declared stop window
 *   (the caller must log it with the spec/window for audit and must not abort).
 */
export function classifyChildExit({ code = null, signal = null, shuttingDown = false, phase = 'boot', intent = null } = {}) {
    if (shuttingDown || phase === 'cleanup') return code === 0 ? 'ignore' : 'warn';
    if (code === null) return signal ? 'fail' : 'ignore';
    if (code === 0) return 'ignore';
    if (phase === 'boot') return 'fail';
    if (phase === 'tests') return intent && intent.matches === true ? 'declared' : 'fail';
    return 'warn';
}
