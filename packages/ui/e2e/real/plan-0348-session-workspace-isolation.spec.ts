/**
 * PLAN-0588 V1 / T3.1 — two workspaces, one Agent process, each with its own
 * MCP tool context (supersedes PLAN-0348 V4's fail-closed expectation).
 *
 * Product design after PLAN-0588 (`spec/shard-registry-contract.md`):
 *  - a Session is still pinned to one Workspace for its lifetime (I5, unchanged);
 *  - the Agent process now holds one MCP shard per workspace, so chats in two
 *    workspaces succeed on the same process instead of failing closed with
 *    "MCP workspace context cannot be reused across workspaces".
 *
 * Judged here (verify.md V1 + V3 + V9):
 *  1. Workspace A and Workspace B both reach a non-failed run on one process
 *     (write_file lane pauses at the approval gate, which already proves the
 *     workspace tool call was dispatched);
 *  2. each workspace gets its own `mcp_shard_created` and its own
 *     `mcp_invocation` audit rows (no cross-workspace reuse);
 *  3. the Agent PID and instanceId are unchanged (no process restart) and the
 *     agent log carries no cross-workspace rejection;
 *  4. `logs/agent-rebind-*.log` count stays 0 (T4.2a `disabled` producer).
 *
 * Run (isolated host stack; never against a dev stack):
 *   node scripts/e2e-host.mjs --llm-mode=write_file \
 *     e2e/real/plan-0348-session-workspace-isolation.spec.ts
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { expect, test, type APIRequestContext } from "@playwright/test";
import {
    CP_URL,
    ensureChatReady,
    registerJourneyUser,
    seedPage,
    sendChat,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";

const RUN_ID = process.env.XIHE_E2E_RUN_ID ?? "";
const AGENT_PORT = Number(process.env.XIHE_AGENT_PORT || "12632");
const AGENT_URL = `http://127.0.0.1:${AGENT_PORT}`;
const HOST_ROOT = path.resolve(process.cwd(), "../../.tmp/e2e-host", RUN_ID || "unknown-run");
const AGENT_LOG = path.join(HOST_ROOT, "logs", "agent.log");
const REBIND_REJECTION = "MCP workspace context cannot be reused across workspaces";

test.describe.configure({ retries: 0 });
test.setTimeout(240_000);

test.skip(!RUN_ID, "requires an isolated host stack (scripts/e2e-host.mjs), never a dev stack");

interface AgentProcess {
    pid: number | null;
    instanceId: string | null;
}

interface AgentHealth {
    mcpShards?: number;
    mcpInitialized?: boolean;
    instanceId?: string;
}

function listeningPid(port: number): number | null {
    try {
        const out = execSync("netstat -ano -p tcp", { encoding: "utf8" });
        const line = out
            .split(/\r?\n/)
            .find((entry) => entry.includes(`:${port} `) && entry.includes("LISTENING"));
        const pid = line?.trim().split(/\s+/).pop();
        return pid ? Number(pid) : null;
    } catch {
        return null;
    }
}

async function agentHealth(): Promise<AgentHealth> {
    const response = await fetch(`${AGENT_URL}/internal/v1/agent/health`);
    expect(response.ok, `agent health ${response.status}`).toBe(true);
    return (await response.json()) as AgentHealth;
}

async function agentProcess(): Promise<AgentProcess> {
    const health = await agentHealth();
    return { pid: listeningPid(AGENT_PORT), instanceId: health.instanceId ?? null };
}

function readAgentLog(): string {
    return fs.existsSync(AGENT_LOG) ? fs.readFileSync(AGENT_LOG, "utf8") : "";
}

function rebindLogCount(): number {
    const dir = path.dirname(AGENT_LOG);
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((name) => name.startsWith("agent-rebind-")).length;
}

async function latestRunStatus(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
): Promise<string> {
    const res = await request.get(
        `${CP_URL}/api/v1/audit/entries?type=chat_run&size=1&workspaceId=${encodeURIComponent(workspaceId)}`,
        { headers },
    );
    if (!res.ok()) return `http-${res.status()}`;
    const body = (await res.json()) as { entries?: Array<{ status?: string }> };
    return body.entries?.[0]?.status ?? "none";
}

interface ConnectionView {
    id: string;
    providerId: string;
    revision: number;
    enabled: boolean;
    status: string;
    operation?: string;
    manualModels?: string[];
}

/**
 * PLAN-0591 capability gate: `custom-openai-compatible` declares
 * `capability.tools = false`, so the default mock-lane binding cannot dispatch a
 * request that carries MCP tools (LLM_TOOL_ROUTE_UNSUPPORTED). Bind the
 * tool-capable built-in `openai` provider row against the fake LLM instead.
 */
async function bindToolCapableChat(
    request: APIRequestContext,
    ctx: { authToken: string; workspaceId: string },
    sessionId: string,
    modelName: string,
): Promise<string> {
    const headers = {
        Authorization: `Bearer ${ctx.authToken}`,
        "Content-Type": "application/json",
        "X-Workspace-Id": ctx.workspaceId,
    };
    const baseUrl = `http://127.0.0.1:${process.env.XIHE_FAKE_LLM_PORT}/openai/v1`;
    const list = (await (
        await request.get(`${CP_URL}/api/v1/provider-connections`, { headers })
    ).json()) as { connections?: ConnectionView[] };
    let connection = (list.connections ?? []).find(
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
                apiKey: "sk-fake-openai-key",
                connectionKey: `e2e-0588-tools-${ctx.workspaceId.slice(0, 8)}`,
                label: "E2E 0588 tool-capable chat",
                scope: "USER",
                modelDiscovery: "manual",
                manualModels: [modelName],
                baseUrl,
            },
        });
        expect(created.ok(), `connection create ${created.status()}: ${await created.text()}`).toBe(
            true,
        );
        connection = (await created.json()) as ConnectionView;
        const verified = await request.post(
            `${CP_URL}/api/v1/provider-connections/${connection.id}/verify`,
            { headers },
        );
        expect(verified.ok(), `verify ${verified.status()}: ${await verified.text()}`).toBe(true);
        connection = ((await verified.json()) as { connection: ConnectionView }).connection;
        expect(connection.status, "tool-capable connection must be READY").toBe("READY");
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
        expect(patched.ok(), `models ${patched.status()}: ${await patched.text()}`).toBe(true);
        connection = (await patched.json()) as ConnectionView;
    }
    const bound = await request.patch(`${CP_URL}/api/v1/sessions/${sessionId}`, {
        headers,
        data: {
            providerConnectionId: connection.id,
            modelProvider: "openai",
            modelName,
            connectionRevision: connection.revision,
        },
    });
    expect(bound.ok(), `bind ${bound.status()}: ${await bound.text()}`).toBe(true);
    return connection.id;
}

async function mcpInvocationCount(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
): Promise<number> {
    const res = await request.get(
        `${CP_URL}/api/v1/audit/entries?type=mcp_invocation&size=20&workspaceId=${encodeURIComponent(workspaceId)}`,
        { headers },
    );
    if (!res.ok()) return -1;
    const body = (await res.json()) as { entries?: unknown[] };
    return body.entries?.length ?? 0;
}

test("@host two workspaces each get their own MCP shard on one Agent process", async ({
    page,
    request,
    browser,
}) => {
    const before = await agentProcess();
    const logBefore = readAgentLog().length;
    const rebindBefore = rebindLogCount();

    // ── Workspace A: a workspace-tool chat makes the Agent create A's shard.
    const a = await registerJourneyUser(request, "plan0588-ws-a");
    const authA = { accessToken: a.authToken, workspaceId: a.workspaceId };
    await waitForControlPlaneAgentReady(request, a.headers);
    const principalA = await provisionWorkspaceAgentPrincipal(request, authA, {
        name: "PLAN-0588 A",
        actions: ["read", "write"],
    });
    const sessionA = await createSessionWithPrincipal(request, authA, {
        principalId: principalA,
        title: "PLAN-0588 Workspace A",
    });
    seedPage(page, a);
    await page.goto(`/workspace/${a.workspaceId}/chat/${sessionA}`);
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await bindToolCapableChat(
        request,
        { authToken: a.authToken, workspaceId: a.workspaceId },
        sessionA,
        "wire-model",
    );
    await sendChat(page, "XIHE-E2E-WRITE plan0588-a.txt hello-from-workspace-a");
    await expect
        .poll(() => latestRunStatus(request, a.headers, a.workspaceId), { timeout: 90_000 })
        .toMatch(/^(succeeded|failed|partial|cancelled|ambiguous|awaiting_approval)$/);
    const statusA = await latestRunStatus(request, a.headers, a.workspaceId);
    expect(statusA, "Workspace A must not fail").not.toBe("failed");

    const logAfterA = readAgentLog().slice(logBefore);
    expect(logAfterA, "Agent must create a shard for workspace A").toContain(
        `event=mcp_shard_created workspaceId=${a.workspaceId}`,
    );

    // ── Workspace B (separate account, own workspace): no process restart.
    const b = await registerJourneyUser(request, "plan0588-ws-b");
    const authB = { accessToken: b.authToken, workspaceId: b.workspaceId };
    const principalB = await provisionWorkspaceAgentPrincipal(request, authB, {
        name: "PLAN-0588 B",
        actions: ["read", "write"],
    });
    const sessionB = await createSessionWithPrincipal(request, authB, {
        principalId: principalB,
        title: "PLAN-0588 Workspace B",
    });

    // Cross-workspace Session API access stays denied (this did not change).
    const foreignGet = await request.get(`${CP_URL}/api/v1/sessions/${sessionA}`, {
        headers: b.headers,
    });
    expect(foreignGet.status()).toBe(404);
    expect(((await foreignGet.json()) as { code?: string }).code).toBe("SESSION_NOT_FOUND");

    const contextB = await browser.newContext();
    try {
        const pageB = await contextB.newPage();
        seedPage(pageB, b);
        await pageB.goto(`/workspace/${b.workspaceId}/chat/${sessionB}`);
        await ensureChatReady(pageB);
        await bindToolCapableChat(
            request,
            { authToken: b.authToken, workspaceId: b.workspaceId },
            sessionB,
            "wire-model",
        );
        await sendChat(pageB, "XIHE-E2E-WRITE plan0588-b.txt hello-from-workspace-b");
        await expect
            .poll(() => latestRunStatus(request, b.headers, b.workspaceId), { timeout: 90_000 })
            .toMatch(/^(succeeded|failed|partial|cancelled|ambiguous|awaiting_approval|none)$/);
        const statusB = await latestRunStatus(request, b.headers, b.workspaceId);
        // PLAN-0588: B no longer fails closed; it gets its own shard.
        expect(statusB, "Workspace B must not fail on the same Agent process").not.toBe("failed");
    } finally {
        await contextB.close();
    }

    const logAll = readAgentLog();
    const logAfterB = logAll.slice(logBefore);
    expect(logAfterB, "Agent must create a shard for workspace B").toContain(
        `event=mcp_shard_created workspaceId=${b.workspaceId}`,
    );
    expect(logAll, "no cross-workspace reuse rejection may appear").not.toContain(REBIND_REJECTION);

    // Each workspace has its own tool invocations (no cross-workspace reuse).
    expect(await mcpInvocationCount(request, a.headers, a.workspaceId)).toBeGreaterThan(0);
    expect(await mcpInvocationCount(request, b.headers, b.workspaceId)).toBeGreaterThan(0);

    // No process restart: same PID and same per-process instanceId.
    const after = await agentProcess();
    expect(after.pid, "Agent PID must not change").toBe(before.pid);
    expect(after.instanceId, "Agent instanceId must not change").toBe(before.instanceId);
    expect(rebindLogCount(), "no agent-rebind log may be written").toBe(rebindBefore);

    // Workspace A stayed healthy throughout.
    expect(await latestRunStatus(request, a.headers, a.workspaceId)).not.toBe("failed");

    // Observable shard count is now ≥ 2 (counts only; no workspace ids).
    const health = await agentHealth();
    expect(health.mcpInitialized).toBe(true);
    expect(health.mcpShards ?? 0).toBeGreaterThanOrEqual(2);
});
