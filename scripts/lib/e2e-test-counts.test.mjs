/**
 * BL-421 tests: the test-count gate that stops "exit 0" from meaning "verified".
 *
 * The contract that matters: a gated spec self-skipping must **not** produce an acceptable
 * run, and `--expect-tests=N` must compare against tests that actually executed — a skipped
 * test counts as "did not run", never as "passed".
 *
 * Run: node --test scripts/lib/e2e-test-counts.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    formatTestCounts,
    judgeTestCounts,
    summarizePlaywrightReport,
} from './e2e-test-counts.mjs';

/** Build a minimal report shaped like Playwright's JSON output. */
function report({ expected = 0, unexpected = 0, flaky = 0, skipped = 0, skippedTitles = [] } = {}) {
    return {
        stats: { expected, unexpected, flaky, skipped },
        suites: skippedTitles.map((title) => ({
            specs: [{ title, tests: [{ results: [] }] }],
        })),
    };
}

test('summarize: executed counts expected + flaky + unexpected, never skipped', () => {
    const summary = summarizePlaywrightReport(report({ expected: 3, flaky: 1, unexpected: 2, skipped: 4 }));
    assert.equal(summary.executed, 6);
    assert.equal(summary.skipped, 4);
});

test('summarize: a report with no stats degrades to zeros instead of NaN', () => {
    const summary = summarizePlaywrightReport({});
    assert.deepEqual(
        { executed: summary.executed, skipped: summary.skipped },
        { executed: 0, skipped: 0 },
    );
    const missing = summarizePlaywrightReport(null);
    assert.equal(missing.executed, 0);
});

test('summarize: negative or garbage counters are clamped to 0', () => {
    const summary = summarizePlaywrightReport({ stats: { expected: -5, unexpected: 'x', skipped: null } });
    assert.equal(summary.executed, 0);
    assert.equal(summary.skipped, 0);
});

test('summarize: collects the titles of specs that never executed', () => {
    const summary = summarizePlaywrightReport(report({ skipped: 2, skippedTitles: ['asks the user', 'second gap'] }));
    assert.deepEqual(summary.skippedTitles, ['asks the user', 'second gap']);
});

test('judge: an all-green run with no skips is acceptable', () => {
    const { ok, problems } = judgeTestCounts({ stats: summarizePlaywrightReport(report({ expected: 5 })) });
    assert.equal(ok, true);
    assert.deepEqual(problems, []);
});

test('judge: BL-421 — 1 skipped test fails the run even though Playwright exited 0', () => {
    const stats = summarizePlaywrightReport(report({ expected: 0, skipped: 1, skippedTitles: ['plan0660 ask user'] }));
    const { ok, problems } = judgeTestCounts({ stats });
    assert.equal(ok, false);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /1 test\(s\) skipped/);
    assert.match(problems[0], /plan0660 ask user/);
});

test('judge: --allow-skip accepts a skip deliberately', () => {
    const stats = summarizePlaywrightReport(report({ skipped: 1, skippedTitles: ['gated'] }));
    assert.equal(judgeTestCounts({ stats, allowSkip: true }).ok, true);
});

test('judge: --expect-tests matches only tests that actually executed', () => {
    const twoRan = summarizePlaywrightReport(report({ expected: 2 }));
    assert.equal(judgeTestCounts({ stats: twoRan, expectTests: 2 }).ok, true);

    // The exact BL-421 shape: the spec exists but self-skipped, so 0 ran while 2 were asked for.
    const noneRan = summarizePlaywrightReport(report({ skipped: 2, skippedTitles: ['a', 'b'] }));
    const { ok, problems } = judgeTestCounts({ stats: noneRan, expectTests: 2, allowSkip: true });
    assert.equal(ok, false);
    assert.match(problems[0], /expected exactly 2 executed test\(s\) but 0 ran/);
});

test('judge: --expect-tests=0 is a pin, not "unset"', () => {
    const zero = summarizePlaywrightReport(report({}));
    assert.equal(judgeTestCounts({ stats: zero, expectTests: 0 }).ok, true);

    const one = summarizePlaywrightReport(report({ expected: 1 }));
    const { ok, problems } = judgeTestCounts({ stats: one, expectTests: 0 });
    assert.equal(ok, false);
    assert.match(problems[0], /expected exactly 0 executed test\(s\) but 1 ran/);
});

test('judge: a non-integer --expect-tests is rejected rather than ignored', () => {
    const stats = summarizePlaywrightReport(report({ expected: 1 }));
    const { ok, problems } = judgeTestCounts({ stats, expectTests: -1 });
    assert.equal(ok, false);
    assert.match(problems[0], /not a non-negative integer/);
});

test('judge: flaky tests count as executed (they did run)', () => {
    const stats = summarizePlaywrightReport(report({ expected: 1, flaky: 1 }));
    assert.equal(judgeTestCounts({ stats, expectTests: 2 }).ok, true);
});

test('judge: skip and count problems are reported together, not first-one-wins', () => {
    const stats = summarizePlaywrightReport(report({ skipped: 1, skippedTitles: ['gated'] }));
    const { problems } = judgeTestCounts({ stats, expectTests: 3 });
    assert.equal(problems.length, 2);
});

test('format: the printed line carries all four counters', () => {
    const line = formatTestCounts(summarizePlaywrightReport(report({ expected: 2, flaky: 1, unexpected: 1, skipped: 3 })));
    assert.match(line, /executed=4/);
    assert.match(line, /expected=2/);
    assert.match(line, /flaky=1/);
    assert.match(line, /unexpected=1/);
    assert.match(line, /skipped=3/);
});
