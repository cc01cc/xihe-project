import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import {
    CP_URL,
    awaitOperationCompletedForRun,
    getRootBranchId,
    registerJourneyUser,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";

// PLAN-0492 T0.3 calibration lane: drive representative prompts over the real
// provider (host lane with XIHE_E2E_REAL_ROUTE=openai-compat) in three shapes:
//
//   p1 single-turn baseline — one fresh session per prompt (no history);
//   p2 multi-turn accumulation — one session, sequential prompts whose later
//      runs carry the full conversation (the context-growth tail);
//   p3 workspace tool round-trip — write_file through the real Runtime with
//      the approval gate handled over the API (tool results in context).
//
// The CP persists one `llm.usage` row per run (`source=real`); the per-run
// inputTokens/totalTokens land in the captured run log lines, and the operator
// derives the token defaults from the merged sample.
//
// Run:
//   XIHE_E2E_REAL_XIAOMI_KEY=<key> XIHE_E2E_REAL_ROUTE=openai-compat \
//     mise run test:e2e:host -- --batch=run-budget-calibration
const REAL_ROUTE = process.env.XIHE_E2E_REAL_ROUTE ?? "native";
const MODEL_ID = process.env.XIHE_E2E_REAL_OPENAI_MODEL ?? "mimo-v2.6-flash";
const TERMINAL = /^(succeeded|failed|partial|cancelled|ambiguous)$/;

// Representative single-turn shapes: short Q&A, medium explanation, code,
// translation, listing, reasoning, SQL, summary.
const SINGLE_TURN_PROMPTS: string[] = [
    "你好，用一句话介绍你自己。",
    "用大约 200 字解释什么是事件溯源，并给出一个具体例子。",
    "写一个 Python 函数，判断一个字符串是否是回文，附上 3 个测试用例。",
    "把下面这段话翻译成英文并润色：系统会在每次运行结束后记录用量数据，供后续分析使用。",
    "列出五种常见的软件架构风格，每种用一句话说明适用场景。",
    "解释一下什么是幂等性，为什么分布式系统中的重试需要它？",
    "给出一个 SQL 查询：统计每个用户最近 7 天的订单总金额，按金额降序排列。",
    "请总结：为什么在 Agent 系统中需要为单次运行设置累计预算？分三点说明。",
];

// One session, sequential prompts: later runs carry the whole conversation so
// their inputTokens show real context growth (the p95-relevant tail).
const MULTI_TURN_PROMPTS: string[] = [
    "用 150 字介绍什么是配置漂移。",
    "基于上文，再举一个配置漂移导致生产事故的完整例子，并说明声明式配置如何避免它。",
    "写一篇约 800 字的技术短文，主题是《为什么 Agent 需要可观测的预算与护栏》，包含引言、三个小节与结论。",
    "把上文短文压缩成 5 条要点。",
    "再把这 5 条要点扩写成一段约 200 字的总结。",
];

// Workspace tool round-trip prompts (exact file names keep the assertion stable).
const TOOL_PROMPTS: string[] = [
    "请在工作区根目录创建文件 calibration-a.txt，内容为一行：run budget calibration alpha。创建后读取该文件确认内容。",
    "再创建 calibration-b.txt，内容为：run budget calibration beta；随后列出根目录下所有 calibration-*.txt 文件并汇报结果。",
];

// Fresh journey users carry no grants; the template/principal writes need them
// (same fixture as session-branch / real-tool-roundtrip specs).
function seedUserGrant(userId: string, workspaceId: string) {
    const permissions = JSON.stringify([
        { actionClass: "CREATE_ACCOUNT", resource: "*" },
        { actionClass: "CREATE_TEMPLATE", resource: "*" },
        { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: workspaceId },
        { actionClass: "write", resource: "*" },
    ]).replaceAll("'", "''");
    psql(
        `INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source, read_state) ` +
            `VALUES (gen_random_uuid(), 'user', '${userId}'::uuid, 'user', '${userId}'::uuid, ` +
            `'${permissions}'::jsonb, 'direct', 'read')`,
    );
}

// Isolated PostgreSQL fixture access (same contract as seedUserGrant above).
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

// The public Chat API requires an active session SSE subscription; hold a
// long-lived stream open from the test process for the whole phase.
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

// Wait until a run either parks on the approval gate or reaches a terminal
// state — approval is manual for workspace writes but may be pre-granted by a
// saved rule, so both exits are valid.
async function awaitApprovalGateOrTerminal(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
    runId: string,
): Promise<"pending" | "terminal"> {
    let gate = "running";
    await expect
        .poll(
            async () => {
                const pending = psql(
                    `SELECT count(*) FROM approval_requests WHERE session_id='${sessionId}'::uuid AND state='pending'`,
                );
                if (pending !== "0" && pending !== "") return (gate = "pending");
                const status = await runStatus(request, headers, runId);
                if (TERMINAL.test(status)) return (gate = "terminal");
                return (gate = "running");
            },
            { timeout: 90_000, intervals: [1000, 2000] },
        )
        .toMatch(/pending|terminal/);
    return gate === "pending" ? "pending" : "terminal";
}

async function approveAllPending(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
): Promise<number> {
    const raw = psql(
        `SELECT request_id FROM approval_requests WHERE session_id='${sessionId}'::uuid AND state='pending' ORDER BY created_at`,
    );
    const ids = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    for (const id of ids) {
        const res = await request.post(`${CP_URL}/api/v1/chat/approvals/${id}/decision`, {
            headers,
            data: { decision: "once" },
        });
        expect(res.status(), `approval ${id}: ${await res.text()}`).toBe(200);
    }
    return ids.length;
}

type Auth = { authToken: string; workspaceId: string; headers: Record<string, string> };

async function createPrincipal(
    request: APIRequestContext,
    auth: Auth,
    options: { name: string; toolMode: string },
): Promise<string> {
    const roleId = randomUUID();
    const templateId = randomUUID();
    const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
        headers: auth.headers,
        data: {
            roles: JSON.stringify([
                {
                    id: roleId,
                    name: `${options.name} Role`,
                    permissions: [{ actionClass: "write", resource: "*" }],
                },
            ]),
            templates: JSON.stringify([
                {
                    id: templateId,
                    name: options.name,
                    description: "Token calibration fixture",
                    systemPrompt: "You are a helpful assistant. Answer in Chinese.",
                    toolMode: options.toolMode,
                    provider: "openai",
                    model: MODEL_ID,
                    roleId,
                },
            ]),
        },
    });
    expect(templateWrite.status(), await templateWrite.text()).toBe(200);
    const principalRes = await request.post(`${CP_URL}/api/v1/agent-principals`, {
        headers: auth.headers,
        data: { name: options.name, templateId },
    });
    expect(principalRes.status(), await principalRes.text()).toBe(201);
    const principalId = ((await principalRes.json()) as { principalId: string }).principalId;
    const bindRes = await request.put(
        `${CP_URL}/api/v1/workspaces/${auth.workspaceId}/agents/${principalId}`,
        { headers: auth.headers, data: { permissions: [{ actionClass: "write", resource: "*" }] } },
    );
    expect(bindRes.status(), await bindRes.text()).toBe(200);
    return principalId;
}

test.describe("@host PLAN-0492 T0.3 token calibration", () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(600000);

    test.skip(
        !process.env.XIHE_E2E_REAL_XIAOMI_KEY,
        "requires a real provider key (XIHE_E2E_REAL_XIAOMI_KEY)",
    );
    test.skip(REAL_ROUTE !== "openai-compat", "requires XIHE_E2E_REAL_ROUTE=openai-compat");

    test("collect real-provider usage across single-turn, multi-turn and tool runs", async ({
        request,
    }) => {
        const ctx = await registerJourneyUser(request, "run-budget-calibration");
        const wsId = ctx.workspaceId;
        const headers = { ...ctx.headers, "X-Workspace-Id": wsId };
        const auth: Auth = { authToken: ctx.authToken, workspaceId: wsId, headers };

        const meRes = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
        expect(meRes.ok(), await meRes.text()).toBeTruthy();
        const userId = ((await meRes.json()) as { id: string }).id;
        seedUserGrant(userId, wsId);

        const chatPrincipal = await createPrincipal(request, auth, {
            name: "Calibration Agent",
            toolMode: "none",
        });
        // The principal write leaves CP's cached agent readiness stale until its
        // next probe; the chat gate rejects with AGENT_UNAVAILABLE if the first
        // send wins that race (same guard as real-tool-roundtrip).
        await waitForControlPlaneAgentReady(request, headers);

        let closeSse: (() => void) | undefined;
        const sendAndAwait = async (
            sessionId: string,
            branchId: string,
            content: string,
            toolMode: "none" | "workspace",
        ): Promise<string> => {
            const res = await request.post(`${CP_URL}/api/v1/chat`, {
                headers: { ...headers, "Idempotency-Key": randomUUID() },
                data: { sessionId, branchId, content, toolMode },
            });
            expect(res.status(), `send failed: ${await res.text()}`).toBe(202);
            const runId = ((await res.json()) as { runId: string }).runId;
            await awaitOperationCompletedForRun(request, headers, runId);
            const status = await runStatus(request, headers, runId);
            expect(["succeeded", "partial"], `run status=${status}`).toContain(status);
            return runId;
        };
        const newSession = async (title: string, principalId: string) => {
            const sessionRes = await request.post(`${CP_URL}/api/v1/sessions`, {
                headers,
                data: { title, agentPrincipalId: principalId },
            });
            expect(sessionRes.status(), await sessionRes.text()).toBe(201);
            const sessionId = ((await sessionRes.json()) as { id: string }).id;
            const branchId = await getRootBranchId(request, sessionId, headers);
            return { sessionId, branchId };
        };

        try {
            // p1 — single-turn baseline: fresh session per prompt, no history.
            for (const [index, prompt] of SINGLE_TURN_PROMPTS.entries()) {
                const { sessionId, branchId } = await newSession(
                    `Calibration p1-${index + 1}`,
                    chatPrincipal,
                );
                closeSse = await openSessionSse(sessionId, ctx.authToken);
                const runId = await sendAndAwait(sessionId, branchId, prompt, "none");
                console.log(
                    `[calibration] p1 run ${index + 1}/${SINGLE_TURN_PROMPTS.length} runId=${runId}`,
                );
                closeSse();
                closeSse = undefined;
            }

            // p2 — multi-turn accumulation: one session, sequential prompts; the
            // later runs carry the whole conversation (context-growth tail).
            const multi = await newSession("Calibration p2 multi-turn", chatPrincipal);
            closeSse = await openSessionSse(multi.sessionId, ctx.authToken);
            for (const [index, prompt] of MULTI_TURN_PROMPTS.entries()) {
                const runId = await sendAndAwait(multi.sessionId, multi.branchId, prompt, "none");
                console.log(
                    `[calibration] p2 run ${index + 1}/${MULTI_TURN_PROMPTS.length} runId=${runId}`,
                );
            }
            closeSse();
            closeSse = undefined;

            // p3 — workspace tool round-trip with the real approval gate: the
            // Agent binds the MCP workspace context on its first workspace run
            // (fresh stack, single-workspace constraint satisfied by using our
            // workspace first).
            const toolPrincipal = await createPrincipal(request, auth, {
                name: "Calibration Tool Agent",
                toolMode: "workspace",
            });
            const tool = await newSession("Calibration p3 tools", toolPrincipal);
            closeSse = await openSessionSse(tool.sessionId, ctx.authToken);
            for (const [index, prompt] of TOOL_PROMPTS.entries()) {
                const sendRes = await request.post(`${CP_URL}/api/v1/chat`, {
                    headers: { ...headers, "Idempotency-Key": randomUUID() },
                    data: {
                        sessionId: tool.sessionId,
                        branchId: tool.branchId,
                        content: prompt,
                        toolMode: "workspace",
                    },
                });
                expect(sendRes.status(), await sendRes.text()).toBe(202);
                const runId = ((await sendRes.json()) as { runId: string }).runId;
                const gate = await awaitApprovalGateOrTerminal(
                    request,
                    headers,
                    tool.sessionId,
                    runId,
                );
                if (gate === "pending") {
                    const approved = await approveAllPending(request, headers, tool.sessionId);
                    console.log(`[calibration] p3 run ${index + 1} approved=${approved}`);
                }
                await awaitOperationCompletedForRun(request, headers, runId);
                const status = await runStatus(request, headers, runId);
                expect(["succeeded", "partial"], `tool run status=${status}`).toContain(status);
                console.log(
                    `[calibration] p3 run ${index + 1}/${TOOL_PROMPTS.length} runId=${runId}`,
                );
            }
            closeSse();
            closeSse = undefined;

            // The tool writes must be real (tool results fed the LLM context).
            const hostRoot =
                process.env.XIHE_WORKSPACE_HOST_ROOT ??
                (process.env.XIHE_E2E_RUN_ID
                    ? path.resolve(
                          process.cwd(),
                          "../../.tmp/e2e-host",
                          process.env.XIHE_E2E_RUN_ID,
                      )
                    : null);
            if (hostRoot) {
                const candidates = [
                    path.join(hostRoot, wsId),
                    path.join(hostRoot, wsId, "workspace"),
                ];
                const written = candidates.some(
                    (dir) =>
                        existsSync(dir) &&
                        readdirSync(dir).some((name) => /^calibration-.*\.txt$/.test(name)),
                );
                expect(written, `calibration-*.txt not found under ${candidates.join(" | ")}`).toBe(
                    true,
                );
            } else {
                console.warn("[calibration] host root unknown; tool-write assertion skipped");
            }
        } finally {
            closeSse?.();
        }
    });
});
