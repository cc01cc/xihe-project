#!/usr/bin/env node
/**
 * task-180: unit tests for the path-layered `dev:host:wait-for-cp` budget.
 *
 * Every case here is a **decision**, not I/O: which build path the pre-start verdict selects,
 * which override wins, and what happens to typos (the old code turned them into NaN and reported
 * CP not-ready after one poll tick).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
    DEFAULT_REBUILD_BUDGET_SECONDS,
    REBUILD_TIMEOUT_ENV,
    REUSE_BUDGET_SECONDS,
    WAIT_TIMEOUT_ENV,
    classifyBuildPath,
    describeBudget,
    selectWaitBudget,
} from "./wait-for-cp-budget.mjs";

const verdict = (status, reason = "test verdict") => ({ status, reason, fresh: status === "fresh" });

test("fresh classes select the reuse path; a not-from-HEAD stamp selects rebuild", () => {
    assert.equal(classifyBuildPath(verdict("fresh")), "reuse");
    for (const status of ["stale", "missing", "dirty"]) {
        assert.equal(classifyBuildPath(verdict(status)), "rebuild", status);
    }
});

test("an unprovable verdict falls back to the safe side", () => {
    // stack-run boots as-is (with a WARN) when git cannot prove freshness → no clean compile.
    assert.equal(classifyBuildPath(verdict("unverified")), "reuse");
    // A failed probe is different: it proves nothing, so assume the rebuild (a too-long wait
    // is recoverable, a too-short one aborts dev:host like task-178).
    assert.equal(classifyBuildPath(null), "rebuild");
    assert.equal(classifyBuildPath({}), "rebuild");
});

test("defaults: 60 s on reuse, the rebuild default on rebuild", () => {
    const reuse = selectWaitBudget({ env: {}, freshness: verdict("fresh") });
    assert.equal(reuse.path, "reuse");
    assert.equal(reuse.seconds, REUSE_BUDGET_SECONDS);
    assert.equal(reuse.timeoutMs, REUSE_BUDGET_SECONDS * 1000);

    const rebuild = selectWaitBudget({ env: {}, freshness: verdict("stale") });
    assert.equal(rebuild.path, "rebuild");
    assert.equal(rebuild.seconds, DEFAULT_REBUILD_BUDGET_SECONDS);
    assert.equal(rebuild.timeoutMs, DEFAULT_REBUILD_BUDGET_SECONDS * 1000);

    assert.ok(
        DEFAULT_REBUILD_BUDGET_SECONDS > REUSE_BUDGET_SECONDS * 2,
        "the rebuild budget must leave room for clean compile + boot, not a warm restart",
    );
});

test("XIHE_WAIT_FOR_CP_TIMEOUT overrides BOTH paths (existing semantics unchanged)", () => {
    const reuse = selectWaitBudget({ env: { [WAIT_TIMEOUT_ENV]: "90" }, freshness: verdict("fresh") });
    assert.equal(reuse.seconds, 90);
    assert.equal(reuse.path, "reuse");
    const rebuild = selectWaitBudget({ env: { [WAIT_TIMEOUT_ENV]: "300" }, freshness: verdict("stale") });
    assert.equal(rebuild.seconds, 300);
    assert.equal(rebuild.path, "rebuild");
    // ... and beats the rebuild-only override when both are present.
    const both = selectWaitBudget({
        env: { [WAIT_TIMEOUT_ENV]: "300", [REBUILD_TIMEOUT_ENV]: "999" },
        freshness: verdict("stale"),
    });
    assert.equal(both.seconds, 300);
    assert.match(both.source, new RegExp(WAIT_TIMEOUT_ENV));
});

test("XIHE_WAIT_FOR_CP_REBUILD_TIMEOUT only widens the rebuild path", () => {
    const rebuild = selectWaitBudget({
        env: { [REBUILD_TIMEOUT_ENV]: "480" },
        freshness: verdict("missing"),
    });
    assert.equal(rebuild.seconds, 480);
    assert.equal(rebuild.path, "rebuild");
    assert.equal(rebuild.source, REBUILD_TIMEOUT_ENV);

    const reuse = selectWaitBudget({
        env: { [REBUILD_TIMEOUT_ENV]: "480" },
        freshness: verdict("fresh"),
    });
    assert.equal(reuse.seconds, REUSE_BUDGET_SECONDS, "the rebuild override must not slow a warm restart");
});

test("invalid or empty override values are explicit errors / treated as unset", () => {
    for (const bad of ["abc", "0", "-5", "Infinity", "1e3", "60s"]) {
        assert.throws(
            () => selectWaitBudget({ env: { [WAIT_TIMEOUT_ENV]: bad }, freshness: verdict("fresh") }),
            new RegExp(WAIT_TIMEOUT_ENV),
            `${WAIT_TIMEOUT_ENV}=${bad} must be rejected`,
        );
    }
    assert.throws(
        () => selectWaitBudget({ env: { [REBUILD_TIMEOUT_ENV]: "abc" }, freshness: verdict("stale") }),
        new RegExp(REBUILD_TIMEOUT_ENV),
    );
    // Empty / whitespace means "unset" (mise often forwards an empty var).
    const empty = selectWaitBudget({ env: { [WAIT_TIMEOUT_ENV]: "   ", [REBUILD_TIMEOUT_ENV]: "" }, freshness: verdict("stale") });
    assert.equal(empty.seconds, DEFAULT_REBUILD_BUDGET_SECONDS);
});

test("decimal seconds are accepted (sub-minute diagnostic windows)", () => {
    const budget = selectWaitBudget({ env: { [WAIT_TIMEOUT_ENV]: "12.5" }, freshness: verdict("fresh") });
    assert.equal(budget.seconds, 12.5);
    assert.equal(budget.timeoutMs, 12500);
});

test("describeBudget names the path, the budget and the freshness reason", () => {
    const budget = selectWaitBudget({ env: {}, freshness: verdict("stale", "stamped commit != HEAD") });
    const line = describeBudget(budget, verdict("stale", "stamped commit != HEAD"));
    assert.match(line, /rebuild/);
    assert.match(line, /240\.0s/);
    assert.match(line, /stamped commit != HEAD/);
});
