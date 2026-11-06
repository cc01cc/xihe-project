/**
 * BL-421: turn a Playwright JSON report into an explicit pass/fail decision about **how many
 * tests actually ran**.
 *
 * Why this exists: a spec that gates itself (`test.skip(!process.env.XIHE_E2E_ASK_USER, …)`)
 * makes `playwright test` exit 0 while running nothing. `exit 0` therefore says "no test
 * failed", not "the thing was verified" — the ask-user lane shipped exactly that shape and a
 * green run covered zero cases. The runner now reads the report it asked Playwright to write
 * and treats the numbers as part of the verdict.
 *
 * Pure functions only (no fs, no env): `scripts/e2e-host.mjs` owns the I/O so the decision
 * itself stays unit-testable without a stack.
 */

/** Playwright's own counters, normalised to integers (missing keys count as 0). */
function toCount(value) {
    const n = Number(value ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Flatten `stats` plus the titles of skipped specs.
 *
 * `executed` deliberately means "the test body ran at least once": expected + flaky +
 * unexpected. A skipped test never ran, so it must never contribute — that is the whole
 * point of the counter.
 */
export function summarizePlaywrightReport(report) {
    const stats = report?.stats ?? {};
    const expected = toCount(stats.expected);
    const unexpected = toCount(stats.unexpected);
    const flaky = toCount(stats.flaky);
    const skipped = toCount(stats.skipped);
    const skippedTitles = [];

    const walk = (suite) => {
        for (const spec of suite?.specs ?? []) {
            const tests = spec?.tests ?? [];
            const ran = tests.some((test) => (test?.results ?? []).length > 0);
            if (!ran) skippedTitles.push(spec?.title ?? '(untitled)');
        }
        for (const child of suite?.suites ?? []) walk(child);
    };
    for (const file of report?.suites ?? []) walk(file);

    return {
        expected,
        unexpected,
        flaky,
        skipped,
        executed: expected + unexpected + flaky,
        skippedTitles,
    };
}

/**
 * Decide whether a run is acceptable.
 *
 * `expectTests === null` means the caller did not pin a count; then only the skip rule applies
 * (any skip fails unless `allowSkip`). `expectTests === 0` is a legitimate pin and must not be
 * confused with "unset".
 *
 * Returns `{ ok, problems }`; every problem is a human-readable sentence the runner can print
 * verbatim — the failure has to say what was expected and what happened.
 */
export function judgeTestCounts({ stats, expectTests = null, allowSkip = false } = {}) {
    const summary = stats ?? summarizePlaywrightReport(null);
    const problems = [];

    if (expectTests !== null) {
        if (!Number.isInteger(expectTests) || expectTests < 0) {
            problems.push(`--expect-tests=${expectTests} is not a non-negative integer`);
        } else if (summary.executed !== expectTests) {
            problems.push(
                `expected exactly ${expectTests} executed test(s) but ${summary.executed} ran`
                    + ` (skipped=${summary.skipped})`,
            );
        }
    }

    if (summary.skipped > 0 && !allowSkip) {
        const detail = summary.skippedTitles.length > 0
            ? `\n  skipped: ${summary.skippedTitles.slice(0, 10).join('\n  skipped: ')}`
            : '';
        problems.push(
            `${summary.skipped} test(s) skipped; a gated spec that self-skips is a silent hole`
                + ` — set its gate env, or pass --allow-skip to accept it deliberately${detail}`,
        );
    }

    return { ok: problems.length === 0, problems, summary };
}

/** One line the runner always prints, so the counts are never implicit. */
export function formatTestCounts(summary) {
    return `tests: executed=${summary.executed}`
        + ` (expected=${summary.expected} flaky=${summary.flaky} unexpected=${summary.unexpected})`
        + ` skipped=${summary.skipped}`;
}
