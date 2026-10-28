import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import {
    CP_URL,
    awaitOperationCompletedForRun,
    getRootBranchId,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import { seedUserGrant } from "./helpers/user-grants";

// PLAN-0493 T0.2 loop/no-progress observation lane: drive repeat-prone prompts
// over the real provider and record the RAW tool-call sequences the model
// produces (detection is not wired yet — this observes nature, not the guard).
//
// Scenarios (one session, sequential):
//   s1 baseline write + read          — ordinary tool round-trip;
//   s2 explicit same-args re-read ×4  — direct repeat pressure (calibrates
//                                        repeat_warn/refuse/escalate 2/3/5);
//   s3 background sleep + status poll — legitimate polling (validates the
//                                        exempt list: get_background_process);
//   s4 read a missing file            — error/retry pressure (calibrates
//                                        error ladder 3/5);
//   s5 hunt an absent file            — no-progress search pressure (does the
//                                        model vary args or repeat verbatim?).
//
// Evidence: per-scenario tool sequences + name/args streak statistics are
// printed as `[loop-obs]` lines into the captured run log; the operator folds
// them into plans/PLAN-0493-.../evidence/m0-observed-repeats.md.
//
// Run:
//   XIHE_E2E_REAL_XIAOMI_KEY=<from .env.local> XIHE_E2E_REAL_ROUTE=openai-compat \
//     mise run test:e2e:host -- --batch=loop-observation
const REAL_ROUTE = process.env.XIHE_E2E_REAL_ROUTE ?? "native";
const MODEL_ID = process.env.XIHE_E2E_REAL_OPENAI_MODEL ?? "mimo-v2.6-flash";
const TERMINAL = /^(succeeded|failed|partial|cancelled|ambiguous)$/;

const SCENARIOS: Array<{ id: string; prompt: string }> = [
    {
        id: "s1-baseline",
        prompt: "请在工作区根目录创建文件 loop-obs-1.txt，内容为一行：loop observation baseline。创建完成后读取该文件确认内容。",
    },
    {
        id: "s2-explicit-repeat",
        prompt: "请连续读取 loop-obs-1.txt 共 4 次（每次单独调用读取工具，参数完全相同），不要做其他事情，最后告诉我 4 次结果是否一致。",
    },
    {
        id: "s3-background-poll",
        prompt: "请启动一个后台进程运行 sleep 15，然后持续查询它的状态直到它结束，结束后告诉我最终状态。",
    },
    {
        id: "s4-missing-read",
        prompt: "请读取工作区根目录下 loop-obs-missing.txt 的内容并告诉我。",
    },
    {
        id: "s5-absent-hunt",
        prompt: "请在工作区中查找名为 loop-obs-absent.txt 的文件；如果没找到，请换用不同的搜索方式多试几次，直到找到为止。",
    },
];

// The Agent owns ONE MCP workspace binding per process (xh-host-e2e-pitfalls):
// a fresh registration on Playwright retry creates a second workspace and
// trips "MCP workspace context cannot be reused across workspaces" — reuse one
// account/workspace across attempts (run-budget-exhaustion pattern).
const STABLE_EMAIL = "loop-observation@test.com";
const STABLE_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? "LoopObservationE2e!2026";

async function registerOrLoginStable(
    request: APIRequestContext,
    name: string,
): Promise<{ authToken: string; workspaceId: string; headers: Record<string, string> }> {
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
        data: { email: STABLE_EMAIL, password: STABLE_PASSWORD, name },
    });
    let token: string;
    let workspaceId: string;
    if (reg.ok()) {
        const body = (await reg.json()) as { accessToken: string; workspaceId: string };
        token = body.accessToken;
        workspaceId = body.workspaceId;
    } else {
        const login = await request.post(`${CP_URL}/api/v1/auth/login`, {
            data: { identifier: STABLE_EMAIL, password: STABLE_PASSWORD },
        });
        expect(login.ok(), `login ${login.status()}: ${await login.text()}`).toBeTruthy();
        const body = (await login.json()) as { accessToken: string; workspaceId: string };
        token = body.accessToken;
        workspaceId = body.workspaceId;
    }
    return {
        authToken: token,
        workspaceId,
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
    };
}

// PLAN-0439: chat admission requires an explicit Session binding (READY chat
// connection at the pinned revision + template triple). API-driven specs
// predate the browser-only `ensureChatBinding`, so bind here: create/verify a
// manual openai-compatible connection carrying the real key (the runner keeps
// the key env-only for config layers; a bound session dispatches through the
// connection lease, so the connection itself must hold the key — per-run
// isolated PG, never logged or committed), then PATCH the session.
const REAL_BASE = process.env.XIHE_E2E_REAL_OPENAI_BASE ?? "https://api.xiaomimimo.com/v1";

async function ensureApiChatBinding(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
    modelName: string,
): Promise<void> {
    const sessionRes = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}`, { headers });
    expect(sessionRes.ok(), await sessionRes.text()).toBeTruthy();
    const session = (await sessionRes.json()) as { providerConnectionId?: string };
    if (session.providerConnectionId) return;

    const list = await request.get(`${CP_URL}/api/v1/provider-connections`, { headers });
    expect(list.ok(), await list.text()).toBeTruthy();
    type ConnectionView = {
        id: string;
        providerId: string;
        revision: number;
        enabled: boolean;
        status: string;
        operation?: string;
        manualModels?: string[];
    };
    const body = (await list.json()) as { connections?: ConnectionView[] };
    let connection = (body.connections ?? []).find(
        (item) =>
            item.enabled &&
            item.status === "READY" &&
            item.operation === "chat" &&
            item.providerId === "openai",
    );
    if (!connection) {
        const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers,
            data: {
                providerId: "openai",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: process.env.XIHE_E2E_REAL_XIAOMI_KEY,
                connectionKey: "e2e-loop-obs",
                label: "E2E loop observation",
                scope: "USER",
                modelDiscovery: "manual",
                manualModels: [modelName],
                baseUrl: REAL_BASE,
            },
        });
        expect(
            created.ok(),
            `connection create ${created.status()}: ${await created.text()}`,
        ).toBeTruthy();
        connection = (await created.json()) as ConnectionView;
        const verified = await request.post(
            `${CP_URL}/api/v1/provider-connections/${connection.id}/verify`,
            { headers },
        );
        expect(verified.ok(), `verify ${verified.status()}: ${await verified.text()}`).toBeTruthy();
        connection = ((await verified.json()) as { connection: ConnectionView }).connection;
    }
    if (!(connection.manualModels ?? []).includes(modelName)) {
        const patched = await request.patch(
            `${CP_URL}/api/v1/provider-connections/${connection.id}`,
            {
                headers,
                data: {
                    manualModels: [...(connection.manualModels ?? []), modelName],
                    expectedRevision: connection.revision,
                },
            },
        );
        expect(patched.ok(), await patched.text()).toBeTruthy();
        connection = (await patched.json()) as ConnectionView;
    }
    const bound = await request.patch(`${CP_URL}/api/v1/sessions/${sessionId}`, {
        headers,
        data: {
            providerConnectionId: connection.id,
            modelProvider: connection.providerId,
            modelName,
            connectionRevision: connection.revision,
        },
    });
    expect(bound.ok(), `session bind ${bound.status()}: ${await bound.text()}`).toBeTruthy();
}

function psql(sql: string): string {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE;
    const dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error(
            "isolated PostgreSQL fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    return execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", dbUser, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
    ).trim();
}

async function openSessionSse(sessionId: string, token: string): Promise<() => void> {
    const controller = new AbortController();
    const response = await fetch(
        `${CP_URL}/api/v1/events?sessionId=${encodeURIComponent(sessionId)}`,
        {
            headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
            signal: controller.signal,
        },
    );
    expect(response.status, `SSE open failed: ${response.status}`).toBe(200);
    const reader = response.body?.getReader();
    void (async () => {
        try {
            for (;;) {
                const chunk = await reader?.read();
                if (chunk?.done !== false) break;
            }
        } catch {
            // aborted at test end
        }
    })();
    return () => controller.abort();
}

async function runStatus(
    request: APIRequestContext,
    headers: Record<string, string>,
    runId: string,
): Promise<string> {
    const res = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, { headers });
    if (!res.ok()) return "unavailable";
    return ((await res.json()) as { status?: string }).status ?? "unknown";
}

// Drive one run to a terminal state, approving every pending gate as it
// appears (workspace writes are manual by default).
async function driveRun(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
    runId: string,
): Promise<{ status: string; approvals: number }> {
    let approvals = 0;
    await expect
        .poll(
            async () => {
                const pending = psql(
                    `SELECT request_id FROM approval_requests WHERE session_id='${sessionId}'::uuid AND state='pending' ORDER BY created_at`,
                )
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean);
                for (const id of pending) {
                    const res = await request.post(
                        `${CP_URL}/api/v1/chat/approvals/${id}/decision`,
                        { headers, data: { decision: "once" } },
                    );
                    expect(res.status(), `approval ${id}: ${await res.text()}`).toBe(200);
                    approvals += 1;
                }
                const status = await runStatus(request, headers, runId);
                return TERMINAL.test(status) ? status : "running";
            },
            { timeout: 180_000, intervals: [1000, 2000] },
        )
        .not.toBe("running");
    const status = await runStatus(request, headers, runId);
    return { status, approvals };
}

// Tool calls are SSE-only in the wire contract (persisted messages carry no
// toolCalls), so read the durable `mcp_invocations` rows directly: one row per
// agent tool call with run_id, tool_name and a bounded arguments preview.
type InvocationRow = {
    tool_name: string;
    arguments_preview?: string | null;
    status?: string;
    error_code?: string | null;
};

function loadInvocations(runId: string): InvocationRow[] {
    if (!/^[0-9a-fA-F-]{36}$/.test(runId)) throw new Error(`bad runId: ${runId}`);
    const raw = psql(
        `SELECT row_to_json(m)::text FROM mcp_invocations m ` +
            `WHERE m.source='agent' AND m.run_id='${runId}'::uuid ` +
            `ORDER BY m.started_at, m.tool_call_id`,
    );
    return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as InvocationRow);
}

// Streak statistics over a run's invocation sequence: consecutive same tool
// name, and consecutive same (name + arguments preview) pair — the signature
// proxy (identical args ⇒ identical name; preview is a 4 KiB bounded prefix).
function analyze(label: string, rows: InvocationRow[]) {
    let nameStreak = 1;
    let maxNameStreak = 0;
    let argsStreak = 1;
    let maxArgsStreak = 0;
    let prevName = "";
    let prevKey = "";
    for (const row of rows) {
        const name = row.tool_name ?? "";
        const key = `${name} ${row.arguments_preview ?? ""}`;
        nameStreak = name === prevName ? nameStreak + 1 : 1;
        argsStreak = key === prevKey ? argsStreak + 1 : 1;
        maxNameStreak = Math.max(maxNameStreak, nameStreak);
        maxArgsStreak = Math.max(maxArgsStreak, argsStreak);
        prevName = name;
        prevKey = key;
        const preview = (row.arguments_preview ?? "").replaceAll("\n", "\\n").slice(0, 160);
        console.log(
            `[loop-obs] ${label} call name=${name} status=${row.status ?? "?"} args=${preview}`,
        );
    }
    const failures = rows
        .filter((row) => row.status !== "completed")
        .map((row) => `${row.tool_name}:${row.error_code || row.status || "?"}`);
    console.log(
        `[loop-obs] ${label} summary total=${rows.length} maxNameStreak=${maxNameStreak} ` +
            `maxArgsStreak=${maxArgsStreak} failures=${JSON.stringify(failures)}`,
    );
    return { total: rows.length, maxNameStreak, maxArgsStreak, failures };
}

test.describe("@host PLAN-0493 T0.2 loop observation", () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(900_000);

    test.skip(
        !process.env.XIHE_E2E_REAL_XIAOMI_KEY,
        "requires a real provider key (XIHE_E2E_REAL_XIAOMI_KEY)",
    );
    test.skip(REAL_ROUTE !== "openai-compat", "requires XIHE_E2E_REAL_ROUTE=openai-compat");

    test("observe raw tool-call sequences under repeat pressure", async ({ request }) => {
        const ctx = await registerOrLoginStable(request, "loop-observation");
        const wsId = ctx.workspaceId;
        const headers = { ...ctx.headers, "X-Workspace-Id": wsId };

        const meRes = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
        expect(meRes.ok(), await meRes.text()).toBeTruthy();
        const userId = ((await meRes.json()) as { id: string }).id;
        seedUserGrant(userId, wsId, [
            // Tool-face action classes are read/write/exec/network (ToolFaceRegistry);
            // grant must cover every face the scenarios exercise or allowsByGrant 403s.
            { actionClass: "read", resource: "*" },
            { actionClass: "write", resource: "*" },
            { actionClass: "exec", resource: "*" },
            { actionClass: "network", resource: "*" },
        ]);

        // One workspace principal for the whole session (Agent binds the MCP
        // workspace context on the first workspace run).
        const roleId = randomUUID();
        const templateId = randomUUID();
        const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
            headers,
            data: {
                roles: JSON.stringify([
                    {
                        id: roleId,
                        name: "Loop Obs Role",
                        permissions: [
                            { actionClass: "read", resource: "*" },
                            { actionClass: "write", resource: "*" },
                            { actionClass: "exec", resource: "*" },
                            { actionClass: "network", resource: "*" },
                        ],
                    },
                ]),
                templates: JSON.stringify([
                    {
                        id: templateId,
                        name: "Loop Observation Agent",
                        description: "PLAN-0493 T0.2 observation fixture",
                        systemPrompt:
                            "You are a helpful assistant. Answer in Chinese. Use workspace tools when asked.",
                        toolMode: "workspace",
                        provider: "openai",
                        model: MODEL_ID,
                        roleId,
                    },
                ]),
            },
        });
        expect(templateWrite.status(), await templateWrite.text()).toBe(200);
        const principalRes = await request.post(`${CP_URL}/api/v1/agent-principals`, {
            headers,
            data: { name: "Loop Observation Agent", templateId },
        });
        expect(principalRes.status(), await principalRes.text()).toBe(201);
        const principalId = ((await principalRes.json()) as { principalId: string }).principalId;
        const bindRes = await request.put(
            `${CP_URL}/api/v1/workspaces/${wsId}/agents/${principalId}`,
            {
                headers,
                data: {
                    permissions: [
                        { actionClass: "read", resource: "*" },
                        { actionClass: "write", resource: "*" },
                        { actionClass: "exec", resource: "*" },
                        { actionClass: "network", resource: "*" },
                    ],
                },
            },
        );
        expect(bindRes.status(), await bindRes.text()).toBe(200);
        await waitForControlPlaneAgentReady(request, headers);

        const sessionRes = await request.post(`${CP_URL}/api/v1/sessions`, {
            headers,
            data: { title: "Loop observation", agentPrincipalId: principalId },
        });
        expect(sessionRes.status(), await sessionRes.text()).toBe(201);
        const sessionId = ((await sessionRes.json()) as { id: string }).id;
        // PLAN-0439 admission: bind before the first send.
        await ensureApiChatBinding(request, headers, sessionId, MODEL_ID);
        const branchId = await getRootBranchId(request, sessionId, headers);

        let closeSse: (() => void) | undefined;
        try {
            closeSse = await openSessionSse(sessionId, ctx.authToken);
            const stats: Array<{
                id: string;
                total: number;
                maxNameStreak: number;
                maxArgsStreak: number;
                failures: string[];
            }> = [];

            for (const scenario of SCENARIOS) {
                const sendRes = await request.post(`${CP_URL}/api/v1/chat`, {
                    headers: { ...headers, "Idempotency-Key": randomUUID() },
                    data: {
                        sessionId,
                        branchId,
                        content: scenario.prompt,
                        toolMode: "workspace",
                    },
                });
                expect(sendRes.status(), await sendRes.text()).toBe(202);
                const runId = ((await sendRes.json()) as { runId: string }).runId;
                const driven = await driveRun(request, headers, sessionId, runId);
                expect(
                    ["succeeded", "partial"],
                    `${scenario.id} run status=${driven.status}`,
                ).toContain(driven.status);
                await awaitOperationCompletedForRun(request, headers, runId);

                console.log(
                    `[loop-obs] ${scenario.id} runId=${runId} approvals=${driven.approvals}`,
                );
                const summary = analyze(scenario.id, loadInvocations(runId));
                stats.push({ id: scenario.id, ...summary });
            }

            const totals = stats.map((s) => s.total).reduce((a, b) => a + b, 0);
            console.log(`[loop-obs] final ${JSON.stringify(stats)} grandTotal=${totals}`);
            // The real model must have touched tools at all (s1 writes a file);
            // scenario-level behavior is observation data, not an assertion.
            expect(totals, "expected at least one real tool call").toBeGreaterThan(0);
        } finally {
            closeSse?.();
        }
    });
});
