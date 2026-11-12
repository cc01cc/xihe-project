#!/usr/bin/env node
/** PLAN-0735 / BL-164: mock baseline fixtures (report + baseline JSON, no Playwright). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareWithBaseline, summarizeReport } from "./check-mock-baseline.mjs";

const SCRIPT = fileURLToPath(new URL("./check-mock-baseline.mjs", import.meta.url));

const REPORT = {
    suites: [
        {
            specs: [
                {
                    title: "registered skip A",
                    tests: [
                        {
                            status: "skipped",
                            expectedStatus: "skipped",
                            results: [{ status: "skipped" }],
                        },
                    ],
                },
            ],
            suites: [
                {
                    specs: [
                        {
                            title: "registered skip B",
                            tests: [{ results: [{ status: "passed" }] }],
                        },
                    ],
                },
            ],
        },
    ],
    stats: { expected: 283, skipped: 2, unexpected: 0, flaky: 0 },
};
const BASELINE = {
    counts: { expected: 283, skipped: 2, failed: 0, flaky: 0 },
    skipNames: ["registered skip A"],
};

function writeFixtures(dir, report, baseline) {
    const reportFile = path.join(dir, "report.json");
    const baselineFile = path.join(dir, "baseline.json");
    fs.writeFileSync(reportFile, JSON.stringify(report));
    fs.writeFileSync(baselineFile, JSON.stringify(baseline));
    return { reportFile, baselineFile };
}

function runCli(dir, extra = []) {
    const { reportFile, baselineFile } = writeFixtures(dir, REPORT, BASELINE);
    return spawnSync(
        process.execPath,
        [SCRIPT, "--report", reportFile, "--baseline", baselineFile, ...extra],
        { encoding: "utf8" },
    );
}

test("summarizeReport extracts counts and skip titles", () => {
    const summary = summarizeReport(REPORT);
    assert.equal(summary.expected, 283);
    assert.equal(summary.skipped, 2);
    assert.equal(summary.failed, 0);
    assert.equal(summary.flaky, 0);
    assert.deepEqual(summary.skipNames, ["registered skip A"]);
});

test("PLAN-0735 zero-flaky design: flaky=0 ⇒ exit 0", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-baseline-"));
    try {
        const green = {
            ...REPORT,
            stats: { ...REPORT.stats, unexpected: 0, flaky: 0 },
        };
        const { reportFile, baselineFile } = writeFixtures(dir, green, {
            counts: { expected: 283, skipped: 2, failed: 0, flaky: 0 },
            skipNames: ["registered skip A"],
        });
        const result = spawnSync(
            process.execPath,
            [SCRIPT, "--report", reportFile, "--baseline", baselineFile],
            { encoding: "utf8" },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /OK/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("PLAN-0735 zero-flaky design: flaky=1 ⇒ exit 1 unless --allow-drift", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-baseline-"));
    try {
        const flaky = {
            ...REPORT,
            stats: { ...REPORT.stats, unexpected: 0, flaky: 1 },
        };
        const baselineFile = path.join(dir, "baseline.json");
        fs.writeFileSync(
            baselineFile,
            JSON.stringify({
                counts: { expected: 283, skipped: 2, failed: 0, flaky: 0 },
                skipNames: ["registered skip A"],
            }),
        );
        const reportFile = path.join(dir, "report.json");
        fs.writeFileSync(reportFile, JSON.stringify(flaky));
        const rejected = spawnSync(
            process.execPath,
            [SCRIPT, "--report", reportFile, "--baseline", baselineFile],
            { encoding: "utf8" },
        );
        assert.equal(rejected.status, 1);
        assert.match(rejected.stderr, /E_MOCK_BASELINE_DRIFT/);
        assert.match(rejected.stderr, /flaky: baseline=0 actual=1/);
        const accepted = spawnSync(
            process.execPath,
            [SCRIPT, "--report", reportFile, "--baseline", baselineFile, "--allow-drift"],
            { encoding: "utf8" },
        );
        assert.equal(accepted.status, 0);
        assert.match(accepted.stdout, /drift accepted/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
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
            suites: [
                {
                    specs: [
                        {
                            title: "registered skip A",
                            tests: [
                                {
                                    status: "skipped",
                                    expectedStatus: "skipped",
                                    results: [{ status: "skipped" }],
                                },
                            ],
                        },
                        {
                            title: "unregistered skip",
                            tests: [
                                {
                                    status: "skipped",
                                    expectedStatus: "skipped",
                                    results: [{ status: "skipped" }],
                                },
                            ],
                        },
                    ],
                    suites: [],
                },
            ],
            stats: { ...REPORT.stats, skipped: 2 },
        };
        const { reportFile, baselineFile } = writeFixtures(dir, drifted, BASELINE);
        const result = spawnSync(
            process.execPath,
            [SCRIPT, "--report", reportFile, "--baseline", baselineFile],
            { encoding: "utf8" },
        );
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
        const result = spawnSync(
            process.execPath,
            [SCRIPT, "--report", reportFile, "--baseline", baselineFile],
            { encoding: "utf8" },
        );
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
        const result = spawnSync(
            process.execPath,
            [SCRIPT, "--report", reportFile, "--baseline", baselineFile, "--allow-drift"],
            { encoding: "utf8" },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /drift accepted/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("compareWithBaseline flags retired skip titles", () => {
    const summary = {
        expected: 283,
        failed: 0,
        flaky: 0,
        skipped: 1,
        skipNames: ["registered skip A"],
    };
    const { problems, retired } = compareWithBaseline(summary, {
        counts: { expected: 283, skipped: 2, failed: 0, flaky: 0 },
        skipNames: ["registered skip A", "registered skip B"],
    });
    assert.equal(problems.length, 2);
    assert.deepEqual(retired, ["registered skip B"]);
});

test("task-48: subset report filename ⇒ exit 2 E_MOCK_REPORT_SCOPE", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-baseline-"));
    try {
        const reportFile = path.join(dir, "report.subset.json");
        const baselineFile = path.join(dir, "baseline.json");
        fs.writeFileSync(reportFile, JSON.stringify(REPORT));
        fs.writeFileSync(baselineFile, JSON.stringify(BASELINE));
        const result = spawnSync(
            process.execPath,
            [SCRIPT, "--report", reportFile, "--baseline", baselineFile],
            { encoding: "utf8" },
        );
        assert.equal(result.status, 2, result.stdout + result.stderr);
        assert.match(result.stderr, /E_MOCK_REPORT_SCOPE/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("task-48: report covering <50% of baseline ⇒ exit 2 E_MOCK_REPORT_SCOPE", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-baseline-"));
    try {
        // 全量 317 条 vs 单文件/5 文件子集 60 量级：拿子集比全量基线既不是回归也不是修好。
        const subset = {
            ...REPORT,
            suites: [],
            stats: { expected: 3, skipped: 0, unexpected: 0, flaky: 0 },
        };
        const { reportFile, baselineFile } = writeFixtures(dir, subset, BASELINE);
        const result = spawnSync(
            process.execPath,
            [SCRIPT, "--report", reportFile, "--baseline", baselineFile],
            { encoding: "utf8" },
        );
        assert.equal(result.status, 2, result.stdout + result.stderr);
        assert.match(result.stderr, /E_MOCK_REPORT_SCOPE/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("task-48: full-size report still judged normally (guard does not block)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-baseline-"));
    try {
        const result = runCli(dir);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.doesNotMatch(result.stderr, /E_MOCK_REPORT_SCOPE/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// D-1039 ②（2026-11-12）：E_STALE_REPORT（两级判据）。夹具是一间真 git 仓库（cwd=仓库根，
// 这样脚本的 `resolveRepoRoot()` 解析到的就是夹具而不是本仓），报告/基线都落在
// `packages/ui/e2e/` 下，与生产布局一致。
// ---------------------------------------------------------------------------
const OLD_COMMIT = "2026-01-01T00:00:00Z";

function makeRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mock-stale-"));
    fs.mkdirSync(path.join(root, "packages/ui/e2e/mock"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "selftest@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "selftest"], { cwd: root });
    return root;
}

function commitSpec(root, relativePath, content) {
    const abs = path.join(root, relativePath);
    fs.writeFileSync(abs, content);
    execFileSync("git", ["add", relativePath], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "spec"], {
        cwd: root,
        env: { ...process.env, GIT_AUTHOR_DATE: OLD_COMMIT, GIT_COMMITTER_DATE: OLD_COMMIT },
    });
    return abs;
}

/** 写报告+基线（计数一致 ⇒ 不出 drift，唯一变量只剩「陈旧」）；可把报告 mtime 钉到过去。 */
function writeLane(root, reportMtimeIso) {
    const e2e = path.join(root, "packages/ui/e2e");
    const reportFile = path.join(e2e, ".mock-report.json");
    const baselineFile = path.join(e2e, "mock-baseline.json");
    fs.writeFileSync(
        reportFile,
        JSON.stringify({
            suites: [],
            stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
        }),
    );
    fs.writeFileSync(
        baselineFile,
        JSON.stringify({
            counts: { expected: 1, skipped: 0, failed: 0, flaky: 0 },
            skipNames: [],
        }),
    );
    if (reportMtimeIso) {
        const past = new Date(reportMtimeIso);
        fs.utimesSync(reportFile, past, past);
    }
    return { reportFile, baselineFile };
}

function runInRepo(root, files, extra = []) {
    return spawnSync(
        process.execPath,
        [SCRIPT, "--report", files.reportFile, "--baseline", files.baselineFile, ...extra],
        { encoding: "utf8", cwd: root },
    );
}

test("task-244: 未提交的 spec 比报告新 ⇒ E_STALE_REPORT / exit 2", () => {
    const root = makeRepo();
    try {
        commitSpec(root, "packages/ui/e2e/mock/old.spec.ts", "test('a', () => {});\n");
        const files = writeLane(root, "2026-01-02T00:00:00Z");
        fs.writeFileSync(
            path.join(root, "packages/ui/e2e/mock/new.spec.ts"),
            "test('b', () => {});\n",
        );
        const result = runInRepo(root, files);
        assert.equal(result.status, 2, result.stdout + result.stderr);
        assert.match(result.stderr, /E_STALE_REPORT/);
        assert.match(result.stderr, /new\.spec\.ts/);
        assert.match(result.stderr, /未提交/);
        assert.doesNotMatch(result.stderr, /E_MOCK_BASELINE_DRIFT/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("task-244: --allow-stale-report 接受陈旧报告（仍判 drift）", () => {
    const root = makeRepo();
    try {
        commitSpec(root, "packages/ui/e2e/mock/old.spec.ts", "test('a', () => {});\n");
        const files = writeLane(root, "2026-01-02T00:00:00Z");
        fs.writeFileSync(
            path.join(root, "packages/ui/e2e/mock/new.spec.ts"),
            "test('b', () => {});\n",
        );
        const result = runInRepo(root, files, ["--allow-stale-report"]);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /stale report accepted \(--allow-stale-report\): 1 item/);
        assert.match(result.stdout, /new\.spec\.ts/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("task-244: 纯 mtime 伪影（clean 且提交早于报告）不判红", () => {
    const root = makeRepo();
    try {
        const spec = commitSpec(root, "packages/ui/e2e/mock/artifact.spec.ts", "test('a', () => {});\n");
        const files = writeLane(root, "2026-01-05T00:00:00Z");
        // checkout / 编辑只改 mtime，不改内容：这条在 naive 判据下会被假红（实测本仓 8 条同类）。
        const now = new Date();
        fs.utimesSync(spec, now, now);
        const result = runInRepo(root, files);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.doesNotMatch(result.stderr, /E_STALE_REPORT/);
        assert.match(result.stdout, /checkout mtime artifacts \(not red\)/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("task-244: 已跟踪但改过的 spec（dirty）比报告新 ⇒ exit 2", () => {
    const root = makeRepo();
    try {
        const spec = commitSpec(root, "packages/ui/e2e/mock/edited.spec.ts", "test('a', () => {});\n");
        const files = writeLane(root, "2026-01-02T00:00:00Z");
        fs.writeFileSync(spec, "test('a', () => { /* edited */ });\n");
        const result = runInRepo(root, files);
        assert.equal(result.status, 2, result.stdout + result.stderr);
        assert.match(result.stderr, /E_STALE_REPORT/);
        assert.match(result.stderr, /edited\.spec\.ts/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
