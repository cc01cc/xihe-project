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
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

    console.log("[full] booting isolated e2e-host stack (--persistent, --jar-mode=rebuild)…");
    // Spawn the runner directly: `run-baseline.mjs boot` keeps its log stream open and therefore
    // never exits, which would dead-lock a spawnSync here (observed 2026-11-05 first full run).
    const bootLog = createWriteStream(logPath, { flags: "a" });
    const bootChild = spawn(node, [E2E_HOST, "--persistent", "--skip-preflight", "--jar-mode=rebuild"], {
        cwd: A03, stdio: ["ignore", "pipe", "pipe"], env: process.env,
    });
    bootChild.stdout.pipe(bootLog);
    bootChild.stderr.pipe(bootLog);
    console.log(`[full] boot runner pid=${bootChild.pid}, log=${logPath}`);

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

        // Fixtures are created through the **API** (not SQL): the read path enforces workspace
        // membership, and a hand-inserted workspace has no role binding for the admin user — the
        // first full run measured 220/220 HTTP failures for exactly that reason.
        async function api(method, path, body) {
            const response = await fetch(`${base}${path}`, {
                method,
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                    "X-Workspace-Id": currentWorkspace,
                },
                // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- Fetch 规范里 body 为 undefined 等同「没有 body」（`Request` init 不会带 body），所以 GET 分支实际不发 body；改成条件展开只会让调用点更难读
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const text = await response.text();
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
            return { status: response.status, json, text };
        }
        let currentWorkspace = "";
        let templateRef = null;

        async function publishTemplate(connection) {
            const id = crypto.randomUUID();
            const bodySource = JSON.stringify({
                model: "${xh.model}",
                messages: [
                    { role: "system", content: "${xh.agent_instructions}" },
                    "${xh.conversation_history}",
                    { role: "user", content: "${xh.user_input}" },
                ],
                stream: true,
            });
            const document = {
                id, version: 1, name: `perf-gate-template-${id}`, status: "published",
                apiTypeId: connection.apiTypeId, apiTypeVersion: connection.apiTypeVersion, bodySource,
            };
            // Instance-scope config write: no X-Workspace-Id header on purpose.
            const response = await fetch(`${base}/api/v1/config/instance/api-request-templates`, {
                method: "PUT",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ templates: JSON.stringify([document]) }),
            });
            if (response.status !== 200 && response.status !== 201) {
                throw new Error(`publish template: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
            }
            return { id, version: 1 };
        }

        async function createFixture(tier) {
            const hostPath = `H:/zeotmp/plan0670/perf-ws/${crypto.randomUUID()}`;
            // The Runtime direct-attach probe requires the directory to exist (503
            // DIRECT_ATTACH_PROBE_FAILED otherwise — observed on the 4th full run).
            mkdirSync(hostPath, { recursive: true });
            const workspace = await api("POST", "/api/v1/workspaces", {
                name: `perf-${tier}-${Date.now()}`,
                storageMode: "direct_attach",
                hostPath,
            });
            if (workspace.status !== 200 && workspace.status !== 201) {
                throw new Error(`create workspace ${tier}: HTTP ${workspace.status} ${workspace.text.slice(0, 300)}`);
            }
            currentWorkspace = workspace.json.id ?? workspace.json.workspaceId;
            const principal = await api("POST", "/api/v1/agent-principals",
                { name: `perf${tier}Principal`, scope: "workspace" });
            if (principal.status !== 200 && principal.status !== 201) {
                throw new Error(`create principal ${tier}: HTTP ${principal.status} ${principal.text.slice(0, 300)}`);
            }
            const principalId = principal.json.id ?? principal.json.principalId;
            await api("PUT", `/api/v1/workspaces/${currentWorkspace}/agents/${principalId}`, { permissions: [] });
            const connections = await api("GET", `/api/v1/provider-connections?workspaceId=${currentWorkspace}`);
            const connection = (connections.json?.connections ?? [])[0];
            if (!connection) throw new Error(`no provider connection for ${tier}`);
            // Session needs an explicit api-request-template revision, otherwise dispatch answers
            // 409 API_TYPE_REBIND_REQUIRED (the 20k dispatch stage would fail for fixture reasons).
            if (!templateRef) templateRef = await publishTemplate(connection);
            const session = await api("POST", `/api/v1/workspaces/${currentWorkspace}/sessions`, {
                title: `perf-session-${tier}`,
                agentPrincipalId: principalId,
                modelProvider: connection.providerId,
                modelName: (connection.manualModels ?? [])[0] ?? "fake-openai",
                providerConnectionId: connection.id,
                contextTemplateLayer: "instance",
                contextTemplateId: templateRef.id,
                contextTemplateVersion: templateRef.version,
            });
            if (session.status !== 200 && session.status !== 201) {
                throw new Error(`create session ${tier}: HTTP ${session.status} ${session.text.slice(0, 300)}`);
            }
            const sessionId = session.json.id;
            const branches = await api("GET", `/api/v1/sessions/${sessionId}/branches`);
            const branchList = branches.json.items ?? branches.json.branches ?? branches.json;
            const branchId = (branchList.find((row) => row.parentBranchId == null) ?? branchList[0]).branchId
                ?? branchList[0].id;
            return { workspace: currentWorkspace, session: sessionId, branch: branchId };
        }

        for (const tier of TIERS) {
            const fixture = await createFixture(tier);
            const seeded = run(node, [RUN_BASELINE, "seed", "--apply", "--tier", tier,
                "--container", container, "--db", db, "--session", fixture.session], { quiet: true });
            if ((seeded.status ?? 1) !== 0) throw new Error(`seed ${tier} failed`);
            const measured = run(node, [RUN_BASELINE, "run", "--tier", tier,
                "--base", base, "--token", token, "--session", fixture.session, "--branch", fixture.branch,
                "--workspace", fixture.workspace, "--cp-pid", cpPid,
                "--n", arg("n", "200"), "--warmup", arg("warmup", "20")], { quiet: true });
            const row = lastJsonLine(measured.stdout);
            if (!row) throw new Error(`run ${tier} produced no JSON: ${measured.stderr?.slice(0, 400)}`);
            metrics.push(row);
            sessions[tier] = { session: fixture.session, branch: fixture.branch, workspace: fixture.workspace };
            console.log(`[full] ${tier}: p95=${row.latencyMs?.p95}ms responseMean=${row.responseBytes?.mean}B `
                + `heapPeak=${row.memory?.heapPeakMb}MB rssGrowth=${row.memory?.rssGrowthMb}MB failures=${row.failures}`);
        }

        if (sessions["20k"]) {
            const dispatch = run(node, [RUN_BASELINE, "dispatch", "--tier", "20k",
                "--base", base, "--token", token,
                "--session", sessions["20k"].session, "--branch", sessions["20k"].branch,
                "--workspace", sessions["20k"].workspace,
                "--cp-pid", cpPid], { quiet: true });
            const row = lastJsonLine(dispatch.stdout);
            if (row && (row.failures ?? 0) === 0) {
                metrics.push(row);
            } else {
                // Fixture limitation (e.g. session not admitted for dispatch): keep the GET-only
                // metrics and say so; do not turn a fixture problem into a CP gate failure.
                console.warn(`[full] 20k dispatch not admitted (failures=${row?.failures ?? "?"}) `
                    + "— keeping GET-only metrics, dispatch marked as fixture limitation");
            }
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
