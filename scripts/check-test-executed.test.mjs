#!/usr/bin/env node
/** BL-461 / PLAN-0727: zero-execution guard fixtures (no Maven needed). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const SCRIPT = path.join(import.meta.dirname, "check-test-executed.mjs");

function fixture(files) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "surefire-guard-"));
    const reports = path.join(dir, "surefire-reports");
    if (files !== null) {
        mkdirSync(reports, { recursive: true });
        for (const [name, body] of Object.entries(files)) writeFileSync(path.join(reports, name), body, "utf8");
    }
    return { dir, reports, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(reports, extra = []) {
    return spawnSync(process.execPath, [SCRIPT, "--reports", reports, ...extra], { encoding: "utf8" });
}

test("no surefire dir ⇒ zero-execution red (exit 1)", () => {
    const fx = fixture(null);
    try {
        const result = run(fx.reports);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /零执行假绿/);
    } finally {
        fx.cleanup();
    }
});

test("zero tests ⇒ red (exit 1)", () => {
    const fx = fixture({ "TEST-a.xml": '<testsuite tests="0" failures="0" errors="0" skipped="0"/>' });
    try {
        const result = run(fx.reports);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /零执行假绿/);
    } finally {
        fx.cleanup();
    }
});

test("one test ⇒ green (exit 0)", () => {
    const fx = fixture({ "TEST-a.xml": '<testsuite tests="1" failures="0" errors="0" skipped="0"/>' });
    try {
        const result = run(fx.reports);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /tests=1/);
    } finally {
        fx.cleanup();
    }
});

test("stale reports before --since ⇒ red (old reports must not mask zero execution)", () => {
    const fx = fixture({ "TEST-old.xml": '<testsuite tests="9" failures="0" errors="0" skipped="0"/>' });
    try {
        const result = run(fx.reports, ["--since", String(Date.now() + 60_000)]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /零执行假绿/);
    } finally {
        fx.cleanup();
    }
});

test("multiple reports ⇒ green (exit 0) and sums tests", () => {
    const fx = fixture({
        "TEST-a.xml": '<testsuite tests="2" failures="1" errors="0" skipped="0"/>',
        "TEST-b.xml": '<testsuite tests="3" failures="0" errors="1" skipped="1"/>',
    });
    try {
        const result = run(fx.reports);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /reports=2 tests=5 failures=1 errors=1 skipped=1/);
    } finally {
        fx.cleanup();
    }
});
