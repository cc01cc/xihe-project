/**
 * Capacity / sampling batch (PLAN-0546) — closes the sampling items that
 * PLAN-0588 / 0590 / 0583 handed off at archive time.
 *
 * One spec, mode-gated by env so a single stack boot answers exactly one
 * question (each mode needs different Agent env knobs):
 *
 *   XIHE_E2E_CAP_MODE=config     maxShards=1 vs 16 时同一 (ws,user) 的 run 配置值一致
 *   XIHE_E2E_CAP_MODE=capacity   N 个 ws 顺序首调后的分片数（N=64 容量档）
 *   XIHE_E2E_CAP_MODE=stress     N 个 ws **并发**首调（N=8/16/64）+ 每 ws 建立耗时
 *   XIHE_E2E_CAP_MODE=attribution N≥20 个 (ws, run) 的 mcp_invocation 归属逐条核对
 *   XIHE_E2E_CAP_MODE=ttl        跨空闲 TTL 后同一 ws 重新发现且工具调用仍成功
 *
 * Invariants kept from the L2 batches: 0 real model calls (fake LLM lane),
 * isolated host stack only, no fixed sleeps beyond the deliberate TTL wait.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, test, type APIRequestContext } from "@playwright/test";
import {
    CP_URL,
    getRootBranchId,
    registerJourneyUser,
    waitForControlPlaneAgentReady,
    type JourneyContext,
} from "./helpers/journey";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { bindToolCapableChat } from "./helpers/tool-capable-chat";

const RUN_ID = process.env.XIHE_E2E_RUN_ID ?? "";
const AGENT_PORT = Number(process.env.XIHE_AGENT_PORT || "12632");
const AGENT_URL = `http://127.0.0.1:${AGENT_PORT}`;
const MODE = process.env.XIHE_E2E_CAP_MODE ?? "";
const COUNT = Number(process.env.XIHE_E2E_CAP_N ?? "8");
const IDLE_TTL = Number(process.env.XIHE_E2E_CAP_TTL ?? "5");
const AGENT_LOG = path.resolve(
    process.cwd(),
    "../../.tmp/e2e-host",
    RUN_ID || "unknown-run",
    "logs",
    "agent.log",
);
const TERMINAL = /^(succeeded|failed|partial|cancelled|ambiguous|awaiting_approval)$/;

test.describe.configure({ retries: 0, mode: "serial" });
test.setTimeout(900_000);
test.skip(!RUN_ID, "requires an isolated host stack (scripts/e2e-host.mjs)");

// ── helpers ─────────────────────────────────────────────────────────────────
interface WorkspaceFixture {
    ctx: JourneyContext;
    principalId: string;
    sessionId: string;
}

function readLog(): string {
    return fs.existsSync(AGENT_LOG) ? fs.readFileSync(AGENT_LOG, "utf8") : "";
}

/** loguru writes every record to two sinks; de-duplicate identical lines. */
function uniqueLines(needle: string): string[] {
    const lines = readLog()
        .split(/\r?\n/)
        .filter((line) => line.includes(needle));
    return [...new Set(lines)];
}

function shardCreates(workspaceId: string): string[] {
    return uniqueLines(`event=mcp_shard_created workspaceId=${workspaceId}`);
}

function shardElapsedMs(workspaceId: string): number {
    const line = shardCreates(workspaceId)[0] ?? "";
    const match = line.match(/elapsedMs=(\d+)/);
    return match ? Number(match[1]) : -1;
}

async function agentHealth(): Promise<{
    mcpShards?: number;
    mcpInitialized?: boolean;
    toolsCount?: number;
}> {
    const response = await fetch(`${AGENT_URL}/internal/v1/agent/health`);
    expect(response.ok, `agent health ${response.status}`).toBe(true);
    return (await response.json()) as {
        mcpShards?: number;
        mcpInitialized?: boolean;
        toolsCount?: number;
    };
}

async function newWorkspace(request: APIRequestContext, prefix: string): Promise<WorkspaceFixture> {
    const ctx = await registerJourneyUser(request, prefix);
    await waitForControlPlaneAgentReady(request, ctx.headers);
    const principalId = await provisionWorkspaceAgentPrincipal(
        request,
        { accessToken: ctx.authToken, workspaceId: ctx.workspaceId },
        { name: `${prefix} principal`, actions: ["read", "write"] },
    );
    const sessionId = await createSessionWithPrincipal(
        request,
        { accessToken: ctx.authToken, workspaceId: ctx.workspaceId },
        { principalId, title: `${prefix} session` },
    );
    await bindToolCapableChat(
        request,
        { authToken: ctx.authToken, workspaceId: ctx.workspaceId },
        sessionId,
        "wire-model",
    );
    return { ctx, principalId, sessionId };
}

async function latestRunStatus(request: APIRequestContext, ctx: JourneyContext): Promise<string> {
    const res = await request.get(
        `${CP_URL}/api/v1/audit/entries?type=chat_run&size=1&workspaceId=${encodeURIComponent(ctx.workspaceId)}`,
        { headers: ctx.headers },
    );
    if (!res.ok()) return `http-${res.status()}`;
    const body = (await res.json()) as { entries?: Array<{ status?: string }> };
    return body.entries?.[0]?.status ?? "none";
}

/**
 * Dispatch a workspace-tool chat straight through the public contract (CP SSE
 * subscription + `POST /api/v1/chat`). `marker` drives the fake LLM's
 * deterministic write_file tool call, so reaching a non-failed run proves the
 * Agent discovered that workspace's MCP tools.
 */
async function workspaceToolChat(
    request: APIRequestContext,
    fixture: WorkspaceFixture,
    marker: string,
): Promise<string> {
    const { ctx, principalId, sessionId } = fixture;
    const headers = {
        Authorization: `Bearer ${ctx.authToken}`,
        "Content-Type": "application/json",
        "X-Workspace-Id": ctx.workspaceId,
    };
    const branchId = await getRootBranchId(request, sessionId, ctx.headers);
    const sse = await fetch(`${CP_URL}/api/v1/events?sessionId=${sessionId}`, { headers });
    expect(sse.ok, `sse ${sse.status}`).toBe(true);
    const chat = fetch(`${CP_URL}/api/v1/chat`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
            sessionId,
            branchId,
            content: `XIHE-E2E-WRITE ${marker}.txt capacity batch`,
            agentPrincipalId: principalId,
            toolMode: "workspace",
        }),
    });
    const reader = sse.body?.getReader();
    if (reader) {
        // Drain one chunk so the subscription is definitely attached before
        // dispatch, then stop reading: CP only requires an emitter to exist, and
        // gating every round on a terminal SSE event makes N-workspace runs
        // quadratic (measured: ~70 s/workspace instead of a few seconds).
        await reader.read().catch(() => ({ value: undefined, done: true }));
        await reader.cancel().catch(() => {});
    }
    const response = await chat;
    const body = await response.text();
    expect(response.ok, `chat ${response.status} ${body}`).toBe(true);
    await expect.poll(() => latestRunStatus(request, ctx), { timeout: 120_000 }).toMatch(TERMINAL);
    return latestRunStatus(request, ctx);
}

async function writeWorkspaceContextPolicy(
    request: APIRequestContext,
    ctx: JourneyContext,
): Promise<void> {
    const response = await request.put(
        `${CP_URL}/api/v1/config/workspace/context-policy?workspaceId=${ctx.workspaceId}`,
        {
            headers: ctx.headers,
            data: {
                defaults: JSON.stringify({
                    maxInputTokens: 98765,
                    pruneWindowChars: 4321,
                    recoveryBand: 0.9,
                }),
            },
        },
    );
    expect(response.status(), await response.text()).toBe(200);
}

// ── items ───────────────────────────────────────────────────────────────────
test("@host capacity: maxShards mode keeps run config identical", async ({ request }) => {
    test.skip(MODE !== "config", "mode gate");
    const fixture = await newWorkspace(request, "cap-config");
    await writeWorkspaceContextPolicy(request, fixture.ctx);

    const status = await workspaceToolChat(request, fixture, "cap-config");
    expect(status, "workspace-tool chat must not fail").not.toBe("failed");

    const resolved = uniqueLines(
        `event=context_policy_resolved workspaceId=${fixture.ctx.workspaceId}`,
    ).filter((line) => line.includes("model=wire-model"));
    expect(resolved.length, "a run must log its resolved context policy").toBeGreaterThan(0);
    const line = resolved[resolved.length - 1];
    expect(line, "workspace-layer values must win").toContain("source=config");
    expect(line).toContain("maxInputTokens=98765");
    expect(line).toContain("pruneWindowChars=4321");

    // The knob under test, echoed for the evidence table.
    console.log(`[capacity] maxShards=${process.env.XIHE_AGENT_MCP_MAX_SHARDS ?? "(default)"}`);
    console.log(`[capacity] shardCount=${(await agentHealth()).mcpShards}`);
});

test("@host capacity: N workspaces get N shards under the configured cap", async ({ request }) => {
    test.skip(MODE !== "capacity", "mode gate");
    const fixtures: WorkspaceFixture[] = [];
    for (let index = 0; index < COUNT; index += 1) {
        fixtures.push(await newWorkspace(request, `cap-seq-${index}`));
    }
    for (const [index, fixture] of fixtures.entries()) {
        const status = await workspaceToolChat(request, fixture, `cap-seq-${index}`);
        expect(status, `workspace ${index} chat must not fail`).not.toBe("failed");
    }
    const created = fixtures.filter((fixture) => shardCreates(fixture.ctx.workspaceId).length > 0);
    const health = await agentHealth();
    console.log(
        `[capacity] N=${COUNT} created=${created.length} health.mcpShards=${health.mcpShards}`,
    );
    // The registry never exceeds its cap; with N <= cap every workspace keeps a shard.
    expect(health.mcpShards ?? 0).toBeLessThanOrEqual(64);
    expect(created.length).toBe(Math.min(COUNT, 64));
});

test("@host capacity: N concurrent first calls each create their own shard", async ({
    request,
}) => {
    test.skip(MODE !== "stress", "mode gate");
    const fixtures: WorkspaceFixture[] = [];
    for (let index = 0; index < COUNT; index += 1) {
        fixtures.push(await newWorkspace(request, `cap-par-${index}`));
    }
    const startedAt = Date.now();
    const statuses = await Promise.all(
        fixtures.map((fixture, index) =>
            workspaceToolChat(request, fixture, `cap-par-${index}`).catch((error) => String(error)),
        ),
    );
    const wallMs = Date.now() - startedAt;
    expect(statuses.filter((status) => status === "failed")).toEqual([]);

    const elapsed = fixtures.map((fixture) => shardElapsedMs(fixture.ctx.workspaceId));
    const created = elapsed.filter((value) => value >= 0).length;
    const max = Math.max(...elapsed.filter((value) => value >= 0));
    const health = await agentHealth();
    console.log(
        `[capacity] N=${COUNT} concurrent created=${created} wallMs=${wallMs} ` +
            `maxShardElapsedMs=${max} health.mcpShards=${health.mcpShards} ` +
            `elapsed=${elapsed.join(",")}`,
    );
    expect(created).toBe(Math.min(COUNT, Number(process.env.XIHE_AGENT_MCP_MAX_SHARDS ?? 16)));
});

test("@host capacity: N≥20 MCP invocations keep their own workspace", async ({ request }) => {
    test.skip(MODE !== "attribution", "mode gate");
    const fixtures: WorkspaceFixture[] = [];
    for (let index = 0; index < COUNT; index += 1) {
        fixtures.push(await newWorkspace(request, `cap-attr-${index}`));
    }
    for (const [index, fixture] of fixtures.entries()) {
        await workspaceToolChat(request, fixture, `cap-attr-${index}`);
    }

    let checked = 0;
    for (const fixture of fixtures) {
        const res = await request.get(
            `${CP_URL}/api/v1/audit/entries?type=mcp_invocation&size=20&workspaceId=${encodeURIComponent(fixture.ctx.workspaceId)}`,
            { headers: fixture.ctx.headers },
        );
        expect(res.ok(), `audit ${res.status()}`).toBe(true);
        const body = (await res.json()) as {
            entries?: Array<{ workspaceId?: string; id?: string }>;
        };
        for (const entry of body.entries ?? []) {
            expect(entry.workspaceId, "invocation must carry its own workspace").toBe(
                fixture.ctx.workspaceId,
            );
            checked += 1;
        }
    }
    console.log(`[capacity] attribution rows checked=${checked} over N=${COUNT} workspaces`);
    expect(checked, "must reach the N>=20 sampling threshold").toBeGreaterThanOrEqual(20);
});

test("@host capacity: a workspace rediscovers after the idle TTL and still calls tools", async ({
    request,
}) => {
    test.skip(MODE !== "ttl", "mode gate");
    const fixture = await newWorkspace(request, "cap-ttl");
    const first = await workspaceToolChat(request, fixture, "cap-ttl-first");
    expect(first).not.toBe("failed");
    expect(shardCreates(fixture.ctx.workspaceId).length, "first discovery").toBe(1);

    // Let the idle TTL elapse; the registry reclaims lazily on the next pickup.
    await new Promise((resolve) => setTimeout(resolve, (IDLE_TTL + 3) * 1000));

    // A second session in the same workspace: the first run is parked at the
    // approval gate, and one session admits a single in-flight run (409
    // CHAT_IN_PROGRESS), so reusing it would test the wrong thing.
    const secondSession = await createSessionWithPrincipal(
        request,
        { accessToken: fixture.ctx.authToken, workspaceId: fixture.ctx.workspaceId },
        { principalId: fixture.principalId, title: "cap-ttl-second" },
    );
    await bindToolCapableChat(
        request,
        { authToken: fixture.ctx.authToken, workspaceId: fixture.ctx.workspaceId },
        secondSession,
        "wire-model",
    );
    const second = await workspaceToolChat(
        request,
        { ...fixture, sessionId: secondSession },
        "cap-ttl-second",
    );
    expect(second, "run after TTL must not fail").not.toBe("failed");
    const creations = shardCreates(fixture.ctx.workspaceId).length;
    console.log(`[capacity] idleTtl=${IDLE_TTL}s creations=${creations} secondRunStatus=${second}`);
    expect(creations, "the evicted shard must be rediscovered").toBe(2);
    expect((await agentHealth()).mcpShards ?? 0).toBeGreaterThanOrEqual(1);
});
