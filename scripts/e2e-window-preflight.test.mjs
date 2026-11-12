#!/usr/bin/env node
/**
 * task-246：`scripts/e2e-window-preflight.mjs` 自测。
 *
 * 判据层用**纯函数 + 夹具 facts**（不碰 git/docker/HTTP/端口）；CLI 层只测"用法错误 ⇒ exit 2"
 * （合法 pin 会去读真实栈，属集成行为，不在单测里跑）。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { evaluatePreflight } from "./e2e-window-preflight.mjs";

const SCRIPT = fileURLToPath(new URL("./e2e-window-preflight.mjs", import.meta.url));

function makeFacts(overrides = {}) {
    const base = {
        head12: "57136f8f2fa7",
        headFull: "57136f8f2fa7548f554b3d98f91b7a6d6cfdfa20",
        cpDirty: 0,
        uiDirty: 0,
        cpBuild: {
            verdict: "fresh",
            behind: 0,
            dirty: false,
            runningCommit: "57136f8f2fa7548f554b3d98f91b7a6d6cfdfa20",
            headCommit: "57136f8f2fa7548f554b3d98f91b7a6d6cfdfa20",
        },
        stack: { verdict: "healthy", leaseState: "live", services: [] },
        ports: { derived: { ui: 12630, cp: 12631, agent: 12632, runtime: 12633 }, codes: { ui: 200, cp: 200, agent: 200, runtime: 200 } },
        db: { fileMax: 157, dbMax: 157, container: "a03-xihe-postgres-1", error: "" },
        planner: { batch: "real-full", only: "", sha: "57136f8f2fa7", ready: true, exit: 0, tail: "" },
        annotations: {
            e2eProcesses: { ok: true, value: "0", raw: "" },
            e2ePorts: { ok: true, value: "0", raw: "" },
            containers: { ok: true, up: [], all: [] },
            preflight: { exit: 0, failLine: "", identicalLine: "" },
            gc: { nothing: true, exit: 0, head: "" },
        },
    };
    const merged = { ...base, ...overrides };
    for (const key of ["cpBuild", "stack", "ports", "db", "planner", "annotations"]) {
        if (overrides[key]) merged[key] = { ...base[key], ...overrides[key] };
    }
    return merged;
}

const PIN = "57136f8f";

test("task-246: 全部满足 ⇒ PASS 开窗（exit 0）", () => {
    const result = evaluatePreflight({ pin: PIN, facts: makeFacts() });
    assert.equal(result.failures.length, 0, JSON.stringify(result.rows.filter((row) => row.gate && !row.ok)));
    assert.equal(result.conclusion, "PASS 开窗");
    const ids = result.rows.map((row) => row.id);
    for (const id of ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "A1", "A2", "A3", "A4", "A5"]) {
        assert.ok(ids.includes(id), `${id} 必须在表里出现（附注也要出现，避免误读）`);
    }
});

test("task-246: behind!=0 ⇒ FAIL 且原因点名 behind（门要诚实）", () => {
    const facts = makeFacts({ cpBuild: { verdict: "stale", behind: 2, dirty: false } });
    const result = evaluatePreflight({ pin: PIN, facts });
    assert.ok(result.failures.some((row) => row.id === "G5"), "G5 必须 FAIL");
    assert.ok(result.failures.some((row) => row.id === "G4"), "verdict=stale 时 G4 也必须 FAIL");
    assert.match(result.conclusion, /^FAIL /);
    assert.match(result.conclusion, /G5\(cpBuild\.behind\)=2/);
});

test("task-246: HEAD!=钉靶 ⇒ FAIL 且原因点名 HEAD（钉靶失效即结论作废）", () => {
    const facts = makeFacts({ head12: "44c898b6e828" });
    const result = evaluatePreflight({ pin: PIN, facts });
    assert.ok(result.failures.some((row) => row.id === "G1"), "G1 必须 FAIL");
    assert.match(result.conclusion, /G1\(HEAD==钉靶\)/);
    assert.equal(result.rows.find((row) => row.id === "G1").ok, false);
});

test("task-246: packages/ui/** 有脏 ⇒ G3 FAIL（D-1037 的窄口径）", () => {
    const facts = makeFacts({ uiDirty: 4 });
    const result = evaluatePreflight({ pin: PIN, facts });
    assert.ok(result.failures.some((row) => row.id === "G3"));
    assert.match(result.conclusion, /G3\(packages\/ui\/\*\* 0 条\)=4 条/);
});

test("task-246: 附注 A1–A5 非 0 时不进 FAIL（不误杀别人的窗口）", () => {
    const facts = makeFacts({
        annotations: {
            e2eProcesses: { ok: true, value: "1", raw: "" },
            e2ePorts: { ok: true, value: "1", raw: "" },
            containers: { ok: true, up: ["xihe-e2e-host-abc-1 Up 3 minutes"], all: ["xihe-e2e-host-abc-1 Up 3 minutes"] },
            preflight: { exit: 1, failLine: "FAIL  CP jar ... was built from an older CP tree than HEAD", identicalLine: "" },
            gc: { nothing: true, exit: 0, head: "" },
        },
    });
    const result = evaluatePreflight({ pin: PIN, facts });
    assert.equal(result.failures.length, 0, "附注不参与判定");
    assert.equal(result.conclusion, "PASS 开窗");
    for (const id of ["A1", "A2", "A3", "A4"]) {
        assert.equal(result.rows.find((row) => row.id === id).ok, false, `${id} 读数非 0 时状态应是 FAIL（但只记录）`);
    }
});

test("task-246: 内容模式 G5' 是附注 —— 成立也 PASS、不成立也不进 FAIL", () => {
    const good = { cpScoped: 0, treeRunning: "97ba4a3b550b", treeHead: "97ba4a3b550b", treeEqual: true, error: "" };
    const pass = evaluatePreflight({ pin: PIN, facts: makeFacts({ content: good, cpBuild: { verdict: "stale", behind: 2 } }) });
    const g5p = pass.rows.find((row) => row.id === "G5'");
    assert.equal(g5p.ok, true);
    assert.equal(g5p.gate, false);
    assert.ok(pass.failures.every((row) => row.id !== "G5'"), "G5' 绝不进窗口门");
    assert.ok(pass.failures.some((row) => row.id === "G5"), "严格门仍按 behind 判 FAIL");

    const bad = { cpScoped: 1, treeRunning: "97ba4a3b550b", treeHead: "68fdeea801dc", treeEqual: false, error: "" };
    const fail = evaluatePreflight({ pin: PIN, facts: makeFacts({ content: bad }) });
    assert.equal(fail.rows.find((row) => row.id === "G5'").ok, false);
    assert.ok(fail.failures.every((row) => row.id !== "G5'"));
});

test("task-246 CLI: 缺 --pin ⇒ exit 2（用法错误，不猜钉靶）", () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", cwd: path.dirname(SCRIPT) });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /缺少 --pin/);
});

test("task-246 CLI: --pin 非法 ⇒ exit 2", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--pin", "not-a-sha"], { encoding: "utf8", cwd: path.dirname(SCRIPT) });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /--pin 非法/);
});

test("task-246 CLI: 未登记栈号 ⇒ exit 2", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--pin", PIN, "--stack", "stack-9"], { encoding: "utf8", cwd: path.dirname(SCRIPT) });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /invalid XIHE_STACK_ID/);
});
