// task-76: receipt "readout field" gate -- positive/negative cases + real-tree scan.
//
// Background (reported by task-74): e2e/mock/task43-rsi-observation.spec.ts emitted an evidence
// object carrying 'checks.pageFailures: 0' -- a hardcoded literal. The spec signature never
// destructured the pageFailures fixture, so that field is the ONLY occurrence in the whole file:
// it claims "this gate ran, and it was clean", while it is always 0.
//
// The real gate is fine (mock-test.ts auto fixture teardown -> expectNoPageFailures). What lies
// is only this receipt cell. This checker is the instrument for that class (a sibling of D-1760
// "observed != judged": claim = readout but written as a constant).
//
// Why node:test and not vitest: the criterion module lives under e2e/, while vitest include only
// covers src/** (vite.config.ts:162). Pure-code tests under e2e/ go to
// e2e/fixtures/__tests__/*.test.mjs (pnpm run test:e2e:fixtures, wired into mise validate).
//
// The criterion is not "the scanner runs" but both sides pinned (D-1760):
//   (1) real tree: zero hits (fix landed, no residue);
//   (2) put the task-43 literal back into a sample -> must go red, otherwise this instrument
//       cannot detect the very bug it was built for;
//   (3) five legitimate writing styles must stay at zero hits (stub response bodies / criterion
//       inputs / assertion expectation objects / accumulators / prose fields) -- a criterion that
//       misfires is worse than no criterion (same lesson as check-orphan-snapshots.mjs).
//
// Run: pnpm run test:e2e:fixtures
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanReceiptReadouts } from "../receipt-readouts.mjs";

const E2E_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Recursively collect .ts/.mts sources under e2e/ (skipping node_modules and report dirs). */
function collectSources(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "test-results" || entry === "playwright-report") {
            continue;
        }
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...collectSources(full));
            continue;
        }
        if (/\.(?:ts|mts)$/.test(entry)) out.push(full);
    }
    return out;
}

// -- (2) positive: the task-43 shape must go red ------------------------------------------------
test("positive: 'checks.pageFailures: 0' inside an emitted evidence object is a hit", () => {
    const source = [
        "test('x', async ({ page }, testInfo) => {",
        "    const receipt = {",
        "        task: 'task-43',",
        "        checks: {",
        "            composerMounted: true,",
        "            pageFailures: 0,",
        "        },",
        "        verdict: 'pass',",
        "    };",
        "    await testInfo.attach('r', { body: JSON.stringify(receipt, null, 2) });",
        "});",
    ].join("\n");
    const hits = scanReceiptReadouts(source, "sample.ts");
    assert.deepEqual(
        hits.map((hit) => hit.path).sort(),
        ["checks.pageFailures", "verdict"],
        "expected 2 hits, got " + JSON.stringify(hits),
    );
    assert.equal(
        hits.find((hit) => hit.path === "checks.pageFailures").line,
        6,
        "line number must point at the offending line",
    );
});

test("positive: a writeFileSync report is in scope too (not only testInfo.attach)", () => {
    const source = [
        "const report = { total: 0, ok: true };",
        "writeFileSync('out.json', JSON.stringify(report));",
    ].join("\n");
    assert.deepEqual(
        scanReceiptReadouts(source).map((hit) => hit.key),
        ["total", "ok"],
    );
});

// Two blind spots found BY MUTATION while building this gate (task-76) -- both were real green
// readings on a tree carrying the bug, so they are pinned as positive cases now:
// (a) a trailing comment after the literal ("pageFailures: 0, // explains why") defeated the
//     literal test; (b) a shorthand property ("{ ..., checks, ... }") hid the whole nested object.
test("positive: a literal followed by an explanatory comment is still a hit", () => {
    const source = [
        "test('x', async ({ page }, testInfo) => {",
        "    const receipt = {",
        "        checks: {",
        "            pageFailures: 0, // we check it below",
        "            noErrorMessage: true,",
        "        },",
        "    };",
        "    await testInfo.attach('r', { body: JSON.stringify(receipt) });",
        "});",
    ].join("\n");
    assert.deepEqual(
        scanReceiptReadouts(source).map((hit) => hit.path),
        ["checks.pageFailures"],
    );
});

test("positive: a shorthand property is followed into its own declaration", () => {
    const source = [
        "const checks = { pageFailures: 0, toolCardVisible: true };",
        "const receipt = { schemaVersion: 1, checks, verdict: 'pass' };",
        "writeFileSync('receipt.json', JSON.stringify(receipt));",
    ].join("\n");
    assert.deepEqual(
        scanReceiptReadouts(source)
            .map((hit) => hit.path)
            .sort(),
        ["checks.pageFailures", "verdict"],
    );
});

// -- (3) negatives: legitimate writing styles must stay at zero --------------------------------
test("negative: stub response body (failed: []) builds data, it does not claim a readout", () => {
    const source = [
        "await page.route('**/api/v1/upload', (route) =>",
        "    route.fulfill({ body: JSON.stringify({ success: ['a'], failed: [] }) }),",
        ");",
    ].join("\n");
    assert.deepEqual(scanReceiptReadouts(source), []);
});

test("negative: a criterion input literal is not a readout (task220 shape)", () => {
    const source = [
        "const report = classifyFailures({ consoleErrors: [], pageErrors: [], failedResponses: [] });",
        "expect(report.unexpected.pageErrors).toEqual([]);",
    ].join("\n");
    assert.deepEqual(scanReceiptReadouts(source), []);
});

test("negative: an assertion expectation object is not a receipt (checkpoint shape)", () => {
    const source = ["expect(body).toEqual({ finished: 3, failed: 0, total: 0 });"].join("\n");
    assert.deepEqual(scanReceiptReadouts(source), []);
});

test("negative: accumulators have provenance, so they pass (plan0352 shape)", () => {
    const source = [
        "const trace = { failed: [], pageErrors: [], consoleLines: [] };",
        "page.on('requestfailed', (request) => trace.failed.push(request.url()));",
        "page.on('pageerror', (error) => trace.pageErrors.push(error.message));",
        "writeFileSync('trace.json', JSON.stringify(trace));",
    ].join("\n");
    assert.deepEqual(scanReceiptReadouts(source), []);
});

test("negative: a prose field (verdictOrder) is not a readout (plan-0752 shape)", () => {
    const source = [
        "const summary = { verdictOrder: 'process-count-wins', note: 'see wrap-up report' };",
        "writeFileSync('v12.json', JSON.stringify(summary));",
    ].join("\n");
    assert.deepEqual(scanReceiptReadouts(source), []);
});

// -- (1) real tree: zero hits ----------------------------------------------------------------
test("real tree: no field under e2e/ claims a readout while being a literal", () => {
    const files = collectSources(E2E_ROOT);
    assert.ok(files.length > 200, "scan surface too narrow (" + files.length + " files)");
    const violations = [];
    for (const file of files) {
        violations.push(...scanReceiptReadouts(readFileSync(file, "utf8"), file));
    }
    assert.deepEqual(
        violations,
        [],
        "literals masquerading as readouts (read the real value, or leave 'checked and clean' to the real gate):\n" +
            violations
                .map((hit) => hit.file + ":" + hit.line + " " + hit.path + " = " + hit.value)
                .join("\n"),
    );
});
