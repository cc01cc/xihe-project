#!/usr/bin/env node
/**
 * PLAN-0670 M4 / T4.1+T4.3+T4.4 — one-command perf gate.
 *
 *   mise run perf:chat                 # full: boot isolated stack → seed → measure 1k/5k/20k
 *                                      #       → evaluate thresholds → teardown → PASS/FAIL
 *   mise run perf:chat -- --dry-run    # no stack: evaluate the recorded fixture + print the plan
 *   mise run perf:chat -- --self-check # no stack: prove the gate can go red (impossible thresholds)
 *   mise run perf:chat -- --metrics <file>            # evaluate an existing metrics file
 *   mise run perf:chat -- --with-ui [--ui-metrics f]  # also run the WebUI stage (Playwright)
 *   mise run perf:chat -- --write-thresholds          # backfill thresholds = measured × 1.5
 *
 * Exit code: 0 PASS, 1 FAIL, 2 usage/setup error. Full mode **always** tears the isolated stack down
 * (even on failure) and re-checks ports/containers. Never touches stack-1/stack-2.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const A03 = resolve(HERE, "..", "..");
const ONE = resolve(A03, "..");
const STATE_FILE = join(A03, ".tmp", "e2e-host", "persistent-stack.json");
const FIXTURE = join(HERE, "fixtures", "perf-metrics-sample.json");
const GATE = join(HERE, "gate.mjs");
const RUN_BASELINE = join(HERE, "run-baseline.mjs");
const WEBUI = join(ONE, "plans", "PLAN-0670-xh-long-session-capacity", "scripts", "webui-memory-measure.mjs");
const E2E_HOST = join(A03, "scripts", "e2e-host.mjs");

function arg(name, fallback = null) {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);
const node = process.execPath;
const TIERS = (arg("tiers", "1k,5k,20k")).split(",").map((tier) => tier.trim()).filter(Boolean);

function run(command, args, { quiet = false } = {}) {
    const result = spawnSync(command, args, { encoding: "utf8", cwd: A03 });
    if (!quiet && result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result;
}

function lastJsonLine(stdout) {
    const lines = (stdout ?? "").split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
    for (let i = lines.length - 1; i >= 0; i--) {
        try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
    }
    return null;
}

async function waitForState(timeoutMs = 300_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(STATE_FILE)) {
            try {
                const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
                if (state.ports?.cp && state.adminPassword) return state;
            } catch { /* still being written */ }
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new Error(`e2e-host did not become ready within ${timeoutMs}ms (state=${STATE_FILE})`);
}

async function login(state) {
    const response = await fetch(`http://127.0.0.1:${state.ports.cp}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "admin@xihe.local", password: state.adminPassword }),
    });
    if (!response.ok) throw new Error(`admin login failed: HTTP ${response.status}`);
    const body = await response.json();
    return body.accessToken;
}

function verifyResidue(state) {
    const checks = [];
    const ports = Object.values(state.ports ?? {}).map(Number);
    const listeners = execFileSync("powershell", ["-NoProfile", "-Command",
        `(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { ${ports.map((p) => `$_.LocalPort -eq ${p}`).join(" -or ")} } | Measure-Object).Count`,
    ], { encoding: "utf8" }).trim();
    checks.push({ check: "reserved ports free", value: listeners, ok: Number(listeners) === 0 });
    const containers = execFileSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" })
        .split(/\r?\n/).filter((name) => name.includes("xihe-e2e")).length;
    checks.push({ check: "no xihe-e2e containers", value: containers, ok: containers === 0 });
    checks.push({ check: "persistent state removed", value: existsSync(STATE_FILE), ok: !existsSync(STATE_FILE) });
    for (const check of checks) console.log(`  ${check.ok ? "PASS" : "FAIL"}  teardown: ${check.check} (${check.value})`);
    return checks.every((check) => check.ok);
}

function gateArgs(metricsPath, { withUi, uiMetrics, writeThresholds }) {
    const args = [GATE, "--metrics", metricsPath];
    if (withUi) args.push("--with-ui", "--ui-metrics", uiMetrics);
    if (writeThresholds) args.push("--write-thresholds");
    return args;
}

function evaluate(metricsPath, { withUi, uiMetrics, writeThresholds }) {
    const result = run(node, gateArgs(metricsPath, { withUi, uiMetrics, writeThresholds }));
    return result.status ?? 1;
}

function dryRun() {
    console.log("[dry-run] PLAN-0670 perf gate — no stack is booted.");
    console.log("[dry-run] full mode would: e2e-host --persistent → seed-fixtures → seed 1k/5k/20k");
    console.log("[dry-run]                 → run 200 samples/tier (+20 warm-up) → dispatch 20k");
    console.log("[dry-run]                 → gate.mjs (p95/responseBytes/heapPeak/rssGrowth) → teardown");
    if (flag("with-ui")) {
        console.log(`[dry-run]                 → WebUI stage: ${WEBUI} (Playwright, needs the same stack)`);
    }
    console.log(`[dry-run] evaluating recorded fixture: ${FIXTURE}\n`);
    const uiMetrics = arg("ui-metrics", join(ONE, "plans", "PLAN-0670-xh-long-session-capacity",
        "evidence", "m2d-webui-memory.json"));
    return evaluate(FIXTURE, { withUi: flag("with-ui"), uiMetrics, writeThresholds: false });
}

function selfCheck() {
    console.log("[self-check] evaluating the fixture with impossible thresholds (p95=0.001ms, 1 byte, 1 MB)…\n");
    const result = run(node, [GATE, "--metrics", FIXTURE, "--self-check"]);
    return result.status ?? 1;
}

async function full() {
    const logPath = arg("log", "H:/zeotmp/plan0670/perf-gate-e2e-host.log");
    const metricsOut = arg("metrics-out", "H:/zeotmp/plan0670/perf-metrics.json");
    mkdirSync(dirname(metricsOut), { recursive: true });

    console.log("[full] booting isolated e2e-host stack (--persistent)…");
    const boot = run(node, [RUN_BASELINE, "boot", "--log", logPath], { quiet: true });
    if ((boot.status ?? 1) !== 0) {
        console.error("boot phase failed; see", logPath);
        return 2;
    }
    console.log("[full] boot spawned:", lastJsonLine(boot.stdout)?.bootPid ?? "?");

    let state = null;
    let gateStatus = 1;
    try {
        state = await waitForState();
        console.log(`[full] stack ready: cp=${state.ports.cp} pg=${state.ports.pg} ui=${state.ports.ui} run=${state.runId}`);
        const container = `${state.pgProjectName}-postgres-1`;
        const db = `xihe_e2e_host_${state.runId.replace(/^host-/, "").replace(/-/g, "_")}`;
        const base = `http://127.0.0.1:${state.ports.cp}`;
        const cpPid = String(state.pids?.["control-plane"] ?? "");
        const token = await login(state);
        const metrics = [];
        const sessions = {};

        for (const tier of TIERS) {
            const workspace = crypto.randomUUID();
            const principal = crypto.randomUUID();
            const session = crypto.randomUUID();
            const branch = crypto.randomUUID();
            const fixtures = run(node, [RUN_BASELINE, "seed-fixtures", "--apply",
                "--container", container, "--db", db,
                "--workspace", workspace, "--principal", principal,
                "--session", session, "--branch", branch], { quiet: true });
            if ((fixtures.status ?? 1) !== 0) throw new Error(`seed-fixtures ${tier} failed`);
            const seeded = run(node, [RUN_BASELINE, "seed", "--apply", "--tier", tier,
                "--container", container, "--db", db, "--session", session], { quiet: true });
            if ((seeded.status ?? 1) !== 0) throw new Error(`seed ${tier} failed`);
            const measured = run(node, [RUN_BASELINE, "run", "--tier", tier,
                "--base", base, "--token", token, "--session", session, "--branch", branch,
                "--cp-pid", cpPid, "--n", arg("n", "200"), "--warmup", arg("warmup", "20")], { quiet: true });
            const row = lastJsonLine(measured.stdout);
            if (!row) throw new Error(`run ${tier} produced no JSON: ${measured.stderr?.slice(0, 400)}`);
            metrics.push(row);
            sessions[tier] = { session, branch };
            console.log(`[full] ${tier}: p95=${row.latencyMs?.p95}ms responseMean=${row.responseBytes?.mean}B `
                + `heapPeak=${row.memory?.heapPeakMb}MB rssGrowth=${row.memory?.rssGrowthMb}MB`);
        }

        if (sessions["20k"]) {
            const dispatch = run(node, [RUN_BASELINE, "dispatch", "--tier", "20k",
                "--base", base, "--token", token,
                "--session", sessions["20k"].session, "--branch", sessions["20k"].branch,
                "--cp-pid", cpPid], { quiet: true });
            const row = lastJsonLine(dispatch.stdout);
            if (row) metrics.push(row);
        }

        writeFileSync(metricsOut, `${JSON.stringify({ schema: 1, stack: state.runId, tiers: metrics }, null, 2)}\n`, "utf8");
        console.log(`[full] metrics written: ${metricsOut}`);

        let uiMetrics = arg("ui-metrics");
        if (flag("with-ui")) {
            console.log("[full] WebUI stage (Playwright)…");
            const ui = run(node, [WEBUI]);
            if ((ui.status ?? 1) !== 0) console.warn("[full] WebUI stage exited non-zero; gate will judge its metrics");
            uiMetrics = arg("ui-metrics", join(ONE, "plans", "PLAN-0670-xh-long-session-capacity",
                "evidence", "m2d-webui-memory.json"));
        }
        gateStatus = evaluate(metricsOut, {
            withUi: flag("with-ui"), uiMetrics, writeThresholds: flag("write-thresholds"),
        });
    } catch (error) {
        console.error(`[full] failed: ${error.message}`);
        gateStatus = 1;
    } finally {
        console.log("[full] teardown…");
        const teardown = run(node, [RUN_BASELINE, "teardown"], { quiet: true });
        if (state) verifyResidue(state);
        if ((teardown.status ?? 1) !== 0) console.error("[full] teardown phase exited non-zero");
    }
    return gateStatus;
}

// ---------------------------------------------------------------------------------------------
if (flag("metrics")) {
    const uiMetrics = arg("ui-metrics");
    process.exit(evaluate(arg("metrics"), {
        withUi: flag("with-ui"), uiMetrics, writeThresholds: flag("write-thresholds"),
    }));
} else if (flag("self-check")) {
    process.exit(selfCheck());
} else if (flag("dry-run")) {
    process.exit(dryRun());
} else if (flag("full") || process.argv.length <= 2) {
    process.exit(await full());
} else {
    console.error("usage: chat-gate.mjs [--full] [--dry-run] [--self-check] [--metrics <file>] "
        + "[--with-ui] [--ui-metrics <file>] [--write-thresholds] [--tiers 1k,5k,20k] [--n 200]");
    process.exit(2);
}
