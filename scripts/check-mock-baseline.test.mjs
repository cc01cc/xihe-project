#!/usr/bin/env node
/** PLAN-0735 / BL-164: mock baseline fixtures (report + baseline JSON, no Playwright). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareWithBaseline, summarizeReport } from "./check-mock-baseline.mjs";

const SCRIPT = fileURLToPath(new URL("./check-mock-baseline.mjs", import.meta.url));

const REPORT = {
    suites: [
        {
            specs: [{ title: "registered skip A", tests: [] }],
            suites: [
                {
                    specs: [{ title: "registered skip B", tests: [{ results: [{ status: "passed" }] }] }],
                },
            ],
        },
    ],
    stats: { expected: 283, skipped: 2, unexpected: 0, flaky: 0 },
};
const BASELINE = { counts: { expected: 283, skipped: 2, failed: 0, flaky: 0 }, skipNames: ["registered skip A"] };

function writeFixtures(dir, report, baseline) {
    const reportFile = path.join(dir, "report.json");
    const baselineFile = path.join(dir, "baseline.json");
    fs.writeFileSync(reportFile, JSON.stringify(report));
    fs.writeFileSync(baselineFile, JSON.stringify(baseline));
    return { reportFile, baselineFile };
}

function runCli(dir, extra = []) {
    const { reportFile, baselineFile } = writeFixtures(dir, REPORT, BASELINE);
    return spawnSync(process.execPath, [
        SCRIPT,
        "--report", reportFile,
        "--baseline", baselineFile,
        ...extra,
    ], { encoding: "utf8" });
}

test("summarizeReport extracts counts and skip titles", () => {
    const summary = summarizeReport(REPORT);
    assert.equal(summary.expected, 283);
    assert.equal(summary.skipped, 2);
    assert.equal(summary.failed, 0);
    assert.equal(summary.flaky, 0);
    assert.deepEqual(summary.skipNames, ["registered skip A"]);
});

test("matching counts + registered skip ⇒ exit 0", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-baseline-"));
    try {
        const result = runCli(dir);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /OK/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("skip count drift ⇒ exit 1 with E_MOCK_BASELINE_DRIFT", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-baseline-"));
    try {
        const drifted = {
            ...REPORT,
            suites: [{ specs: [{ title: "registered skip A", tests: [] }, { title: "unregistered skip", tests: [] }], suites: [] }],
            stats: { ...REPORT.stats, skipped: 2 },
        };
        const { reportFile, baselineFile } = writeFixtures(dir, drifted, BASELINE);
        const result = spawnSync(process.execPath, [
            SCRIPT, "--report", reportFile, "--baseline", baselineFile,
        ], { encoding: "utf8" });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /E_MOCK_BASELINE_DRIFT/);
        assert.match(result.stderr, /skip unregistered: unregistered skip/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("failed count != 0 ⇒ exit 1", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-baseline-"));
    try {
        const drifted = { ...REPORT, stats: { ...REPORT.stats, unexpected: 1 } };
        const { reportFile, baselineFile } = writeFixtures(dir, drifted, BASELINE);
        const result = spawnSync(process.execPath, [
            SCRIPT, "--report", reportFile, "--baseline", baselineFile,
        ], { encoding: "utf8" });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /failed: baseline=0 actual=1/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("--allow-drift accepts deliberately", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-baseline-"));
    try {
        const drifted = { ...REPORT, stats: { ...REPORT.stats, unexpected: 1 } };
        const { reportFile, baselineFile } = writeFixtures(dir, drifted, BASELINE);
        const result = spawnSync(process.execPath, [
            SCRIPT, "--report", reportFile, "--baseline", baselineFile, "--allow-drift",
        ], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /drift accepted/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("compareWithBaseline flags retired skip titles", () => {
    const summary = { expected: 283, failed: 0, flaky: 0, skipped: 1, skipNames: ["registered skip A"] };
    const { problems, retired } = compareWithBaseline(summary, {
        counts: { expected: 283, skipped: 2, failed: 0, flaky: 0 },
        skipNames: ["registered skip A", "registered skip B"],
    });
    assert.equal(problems.length, 2);
    assert.deepEqual(retired, ["registered skip B"]);
});
