/**
 * task-732: proof that the CP-owned conditional faces reach the provider request.
 *
 * The acceptance criterion is not "the number is big": it is the three-way
 * identity
 *
 *   chat_run_provider_requests.tool_count
 *     == agent `event=run_tool_table count`
 *     == `event=conditional_faces total` (the assembled `all_tools` length).
 *
 * `native_tools()` maps every tool one-to-one, so `tool_count` is the rendered
 * length of `all_tools`. Three runs in two lanes:
 *
 *   R1 workspace, wired    -> every face present (expect 38 today);
 *   R2 toolMode=none wired -> exactly the six conditional faces (expect 6),
 *                             which isolates the injected face group;
 *   R3 workspace, unwired  -> `XIHE_CP_URL` empty so both builders take their
 *                             documented gray seam; the handoff names vanish and
 *                             `tool_count` drops by exactly two (expect 36).
 *
 * R1/R2 share one boot. R3 needs the harness switch
 * `XIHE_E2E_AGENT_UNWIRE_FACES=1` (scripts/e2e-host.mjs), because the gate is an
 * agent-process env value, not a per-request one.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type APIRequestContext } from "@playwright/test";
import {
    CP_URL,
    awaitOperationCompletedForRun,
    ensureUserDefaultConnection,
    getRootBranchId,
    registerJourneyUser,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import { seedUserGrant } from "./helpers/user-grants";
import { LONG_TIMEOUT_CAP_MS, LONG_TIMEOUT_MS } from "../timeouts";

const MODEL_ID = process.env.XIHE_E2E_FAKE_MODEL ?? "fake-openai";
const UNWIRED = process.env.XIHE_E2E_AGENT_UNWIRE_FACES === "1";
const HOST_ROOT =
    process.env.XIHE_WORKSPACE_HOST_ROOT ??
    (process.env.XIHE_E2E_RUN_ID
        ? path.resolve(process.cwd(), "../../.tmp/e2e-host", process.env.XIHE_E2E_RUN_ID)
        : path.resolve(process.cwd(), "../../.xihe-workspaces"));
const AGENT_LOG = path.join(HOST_ROOT, "logs", "agent.log");

const TEAM_TASK_FACES = ["team_task_create", "team_task_list", "team_task_get", "team_task_update"];
const HANDOFF_FACES = ["list_session_participants", "dispatch_agent_task"];
const CONDITIONAL_FACES = [...TEAM_TASK_FACES, ...HANDOFF_FACES];

type Auth = {
    authToken: string;
    workspaceId: string;
    headers: Record<string, string>;
};

type DurableReading = {
    toolCount: number;
    messageCount: number;
    toolSurfaceCount: number | null;
    tier: string;
    providerStep: number;
};

type AgentReading = {
    tableCount: number;
    tableNames: string[];
    allToolsTotal: number;
    granted: string;
    added: number;
};

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
        { encoding: "utf8", timeout: LONG_TIMEOUT_MS, windowsHide: true },
    ).trim();
}

function sqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
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

async function createWorkspacePrincipal(request: APIRequestContext, auth: Auth): Promise<string> {
    const roleId = randomUUID();
    const templateId = randomUUID();
    const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
        headers: auth.headers,
        data: {
            roles: JSON.stringify([
                {
                    id: roleId,
                    name: "ToolFaceProbe Role",
                    permissions: [{ actionClass: "write", resource: "*" }],
                },
            ]),
            templates: JSON.stringify([
                {
                    id: templateId,
                    name: "ToolFaceProbe",
                    description: "task-732 conditional-face reachability probe",
                    systemPrompt: "Reply with a short acknowledgement only.",
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
        headers: auth.headers,
        data: { name: "ToolFaceProbe", templateId },
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

async function newSession(
    request: APIRequestContext,
    headers: Record<string, string>,
    principalId: string,
    title: string,
): Promise<{ sessionId: string; branchId: string }> {
    const sessionRes = await request.post(`${CP_URL}/api/v1/sessions`, {
        headers,
        data: { title, agentPrincipalId: principalId },
    });
    expect(sessionRes.status(), await sessionRes.text()).toBe(201);
    const sessionId = ((await sessionRes.json()) as { id: string }).id;
    const branchId = await getRootBranchId(request, sessionId, headers);
    return { sessionId, branchId };
}

async function sendRun(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
    branchId: string,
    content: string,
    toolMode: "workspace" | "none",
): Promise<string> {
    const res = await request.post(`${CP_URL}/api/v1/chat`, {
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        data: { sessionId, branchId, content, toolMode },
    });
    expect(res.status(), `send failed: ${await res.text()}`).toBe(202);
    const runId = ((await res.json()) as { runId: string }).runId;
    await awaitOperationCompletedForRun(request, headers, runId);
    const status = await runStatus(request, headers, runId);
    expect(["succeeded", "partial"], `run ${runId} status=${status}`).toContain(status);
    return runId;
}

async function readDurable(runId: string): Promise<DurableReading> {
    const where = `WHERE run_id = ${sqlLiteral(runId)}::uuid`;
    await expect
        .poll(() => psql(`SELECT count(*) FROM chat_run_provider_requests ${where};`), {
            timeout: LONG_TIMEOUT_MS,
            intervals: [250, 500, 1000],
            message: `provider request row for ${runId} never landed`,
        })
        .not.toBe("0");
    const raw = psql(
        `SELECT tool_count, message_count, coalesce(tool_surface->>'count', ''), tier, provider_step ` +
            `FROM chat_run_provider_requests ${where} ORDER BY provider_step LIMIT 1;`,
    );
    const [toolCount, messageCount, surfaceCount, tier, step] = raw.split("|");
    return {
        toolCount: Number(toolCount),
        messageCount: Number(messageCount),
        toolSurfaceCount: surfaceCount === "" ? null : Number(surfaceCount),
        tier,
        providerStep: Number(step),
    };
}

function parseAgentLog(runId: string): AgentReading | null {
    if (!existsSync(AGENT_LOG)) return null;
    const lines = readFileSync(AGENT_LOG, "utf8").split(/\r?\n/);
    let tableCount: number | null = null;
    let tableNames: string[] = [];
    let allToolsTotal: number | null = null;
    let granted = "";
    let added = 0;
    for (const line of lines) {
        if (!line.includes(runId)) continue;
        let message = line;
        try {
            message = (JSON.parse(line) as { record?: { message?: string } }).record?.message ?? "";
        } catch {
            // not JSON (stderr echo); fall through with the raw line
        }
        if (message.includes("event=run_tool_table")) {
            const count = / count=(\d+)/.exec(message);
            const names = / names=([^\s]+)/.exec(message);
            if (count) tableCount = Number(count[1]);
            if (names) tableNames = names[1].split(",").filter(Boolean);
        } else if (message.includes("event=conditional_faces")) {
            const total = / total=(\d+)/.exec(message);
            const grantedMatch = / granted=([^\s]+)/.exec(message);
            const addedMatch = / added=(\d+)/.exec(message);
            if (total) allToolsTotal = Number(total[1]);
            if (grantedMatch) granted = grantedMatch[1];
            if (addedMatch) added = Number(addedMatch[1]);
        }
    }
    if (tableCount === null || allToolsTotal === null) return null;
    return { tableCount, tableNames, allToolsTotal, granted, added };
}

async function readAgent(runId: string): Promise<AgentReading> {
    let reading: AgentReading | null = null;
    await expect
        .poll(() => (reading = parseAgentLog(runId)), {
            timeout: LONG_TIMEOUT_MS,
            intervals: [250, 500, 1000],
            message: `agent log lines for ${runId} never appeared at ${AGENT_LOG}`,
        })
        .not.toBeNull();
    if (!reading) throw new Error(`agent reading missing for ${runId}`);
    return reading;
}

function record(label: string, runId: string, durable: DurableReading, agent: AgentReading) {
    const line = {
        label,
        runId,
        durableToolCount: durable.toolCount,
        messageCount: durable.messageCount,
        toolSurfaceCount: durable.toolSurfaceCount,
        tier: durable.tier,
        providerStep: durable.providerStep,
        runToolTableCount: agent.tableCount,
        allToolsTotal: agent.allToolsTotal,
        granted: agent.granted,
        added: agent.added,
        names: agent.tableNames,
    };
    console.log(`[tool-face] ${JSON.stringify(line)}`);
    return line;
}

function assertThreeWay(label: string, durable: DurableReading, agent: AgentReading) {
    expect(durable.toolCount, `${label}: durable tool_count`).toBe(agent.tableCount);
    expect(agent.tableCount, `${label}: run_tool_table vs all_tools`).toBe(agent.allToolsTotal);
    if (durable.toolSurfaceCount !== null) {
        expect(durable.toolSurfaceCount, `${label}: tool_surface count`).toBe(durable.toolCount);
    }
}

test.describe.configure({ mode: "serial" });

test.describe("@host task-732 conditional-face reachability", () => {
    test.skip(
        process.env.XIHE_E2E_TOOL_FACE_PROBE !== "1",
        "opt-in probe: set XIHE_E2E_TOOL_FACE_PROBE=1",
    );
    // Whole-test budget = SSOT hard cap (60 s); check-e2e-timeouts rejects exempted literals >60 s.
    test.setTimeout(LONG_TIMEOUT_CAP_MS);

    test("provider tool_count equals the graph table and the assembled all_tools", async ({
        request,
    }) => {
        const ctx = await registerJourneyUser(request, "tool-face-probe");
        const wsId = ctx.workspaceId;
        const headers = { ...ctx.headers, "X-Workspace-Id": wsId };
        const auth: Auth = { authToken: ctx.authToken, workspaceId: wsId, headers };

        const meRes = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
        expect(meRes.ok(), await meRes.text()).toBeTruthy();
        const userId = ((await meRes.json()) as { id: string }).id;
        seedUserGrant(userId, wsId, [{ actionClass: "write", resource: "*" }]);
        await ensureUserDefaultConnection(request, ctx);

        const principalId = await createWorkspacePrincipal(request, auth);
        await waitForControlPlaneAgentReady(request, headers);

        const session = await newSession(request, headers, principalId, "ToolFaceProbe");
        const closeSse = await openSessionSse(session.sessionId, ctx.authToken);
        const results: ReturnType<typeof record>[] = [];
        try {
            if (UNWIRED) {
                // Counterexample: same workspace lane, but both conditional-face
                // builders see no XIHE_CP_URL and grant nothing.
                const runId = await sendRun(
                    request,
                    headers,
                    session.sessionId,
                    session.branchId,
                    "Reply with ok.",
                    "workspace",
                );
                const durable = await readDurable(runId);
                const agent = await readAgent(runId);
                results.push(record("R3-workspace-unwired", runId, durable, agent));
                assertThreeWay("R3", durable, agent);
                expect(agent.granted, "R3 grant set").toBe("none");
                expect(agent.added, "R3 conditional faces added").toBe(0);
                for (const face of HANDOFF_FACES) {
                    expect(agent.tableNames, `R3 must not carry ${face}`).not.toContain(face);
                }
            } else {
                const groundedRun = await sendRun(
                    request,
                    headers,
                    session.sessionId,
                    session.branchId,
                    "Reply with ok.",
                    "workspace",
                );
                const groundedDurable = await readDurable(groundedRun);
                const groundedAgent = await readAgent(groundedRun);
                results.push(
                    record("R1-workspace-wired", groundedRun, groundedDurable, groundedAgent),
                );
                assertThreeWay("R1", groundedDurable, groundedAgent);
                for (const face of CONDITIONAL_FACES) {
                    expect(groundedAgent.tableNames, `R1 must carry ${face}`).toContain(face);
                }
                expect(groundedAgent.granted, "R1 grant set").toBe("team_task,handoff");

                // toolMode=none drops the MCP and base tools; whatever remains is
                // exactly what the conditional assembly contributed.
                const noneRun = await sendRun(
                    request,
                    headers,
                    session.sessionId,
                    session.branchId,
                    "Reply with ok.",
                    "none",
                );
                const noneDurable = await readDurable(noneRun);
                const noneAgent = await readAgent(noneRun);
                results.push(record("R2-none-wired", noneRun, noneDurable, noneAgent));
                assertThreeWay("R2", noneDurable, noneAgent);
                expect([...noneAgent.tableNames].sort(), "R2 table is the six faces").toEqual(
                    [...CONDITIONAL_FACES].sort(),
                );
            }
        } finally {
            closeSse();
        }

        const out = path.join(HOST_ROOT, "tool-face-probe.json");
        writeFileSync(
            out,
            JSON.stringify({ unwired: UNWIRED, agentLog: AGENT_LOG, results }, null, 2),
            "utf8",
        );
        console.log(`[tool-face] summary written to ${out}`);
    });
});
