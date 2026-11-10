// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
// PLAN-0590 — Agent run-config isolation across two workspaces in one process.
//
// Target invariant (default mode): a chat run in workspace B resolves config from
// B's own (workspace, user) identity, never from the workspace the Agent process
// was booted with (`XIHE_WORKSPACE_ID`). The pre-change baseline is recorded by
// running the same spec with XIHE_E2E_PLAN0590_BASELINE=1, which flips the B-side
// assertions to the known cross-talk values (workspace A's layer).
//
// The chat itself runs through the product composer (the UI owns the dispatch
// shape); only the session SSE subscription stays in-page as a read-only probe.
// PLAN-0687 removed the old in-page POST /api/v1/chat: that POST completed a
// product behaviour from inside `page.evaluate` and bypassed the UI under test.
// MCP tooling (PLAN-0588) is deliberately out of scope here.
//
// Runs on the host E2E mock lane (fake LLM, 0 real provider calls):
//   node scripts/e2e-host.mjs --llm-mode=mock e2e/real/plan-0590-config-isolation.spec.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { agentName } from "./helpers/agent-name";
import { createSessionWithPrincipal } from "./helpers/agent-principal";
import { ensureFakeUserProvider } from "./helpers/fake-provider";
import {
    CP_URL,
    awaitLatestChatRunCompleted,
    ensureAgentWorkspaceBinding,
    ensureChatBinding,
    evidenceDir,
    registerJourneyUser,
    seedPage,
    type JourneyContext,
} from "./helpers/journey";
import { seedUserGrantPermissions, standardWorkspaceUserPermissions } from "./helpers/user-grants";
import { LONG_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../timeouts";

/** A-only workspace-layer values; B's workspace layer stays empty. */
const A_MAX_INPUT_TOKENS = 98765;
const A_PRUNE_WINDOW_CHARS = 4321;
/** Code defaults (`context_policy.py`), i.e. what B must resolve. */
const CODE_DEFAULT_PRUNE_WINDOW_CHARS = 80000;

const BASELINE = process.env.XIHE_E2E_PLAN0590_BASELINE === "1";
const EVIDENCE_DIR = evidenceDir("plan-0590-config-isolation");

interface AgentAuth {
    accessToken: string;
    workspaceId: string;
}

interface ResolvedPolicyLog {
    line: string;
    maxInputTokens: string;
    pruneWindowChars: number;
    workspaceId: string | null;
}

interface PlainChatResult {
    windowTokens: number | null;
    done: boolean;
    bufferChars: number;
}

function hostRunDir(): string {
    const root = path.resolve(process.cwd(), "../../.tmp/e2e-host");
    const stateFile = path.join(root, "persistent-stack.json");
    if (existsSync(stateFile)) {
        const state = JSON.parse(readFileSync(stateFile, "utf8")) as { runId?: string };
        if (state.runId) return path.join(root, state.runId);
    }
    const candidates = existsSync(root)
        ? readdirSync(root, { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && entry.name.startsWith("host-"))
              .map((entry) => path.join(root, entry.name))
              .filter((dir) => existsSync(path.join(dir, "logs", "agent.log")))
        : [];
    candidates.sort(
        (a, b) =>
            statSync(path.join(a, "logs", "agent.log")).mtimeMs -
            statSync(path.join(b, "logs", "agent.log")).mtimeMs,
    );
    if (candidates.length === 0) {
        throw new Error(`agent.log not found under ${root}; pass XIHE_E2E_AGENT_LOG_DIR`);
    }
    return candidates[candidates.length - 1];
}

function agentLogFile(): string {
    const fromEnv = process.env.XIHE_E2E_AGENT_LOG_DIR;
    if (fromEnv) return path.join(fromEnv, "agent.log");
    return path.join(hostRunDir(), "logs", "agent.log");
}

/** Read only the bytes appended after `offset` (loguru serialized JSON lines). */
function readLogDelta(file: string, offset: number): string[] {
    const size = statSync(file).size;
    if (size <= offset) return [];
    const text = readFileSync(file).subarray(offset).toString("utf8");
    return text
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => {
            try {
                const record = JSON.parse(line) as { text?: string; record?: { message?: string } };
                return record.text ?? record.record?.message ?? line;
            } catch {
                return line;
            }
        });
}

function resolvedPolicies(lines: string[]): ResolvedPolicyLog[] {
    return lines
        .filter((line) => line.includes("event=context_policy_resolved"))
        .map((line) => {
            const maxInput = /maxInputTokens=(\S+)/.exec(line)?.[1] ?? "missing";
            const prune = Number(/pruneWindowChars=(\d+)/.exec(line)?.[1] ?? "NaN");
            const workspaceId = /workspaceId=([0-9a-f-]{36})/.exec(line)?.[1] ?? null;
            return { line, maxInputTokens: maxInput, pruneWindowChars: prune, workspaceId };
        });
}

async function provisionPlainChatPrincipal(
    request: APIRequestContext,
    auth: AgentAuth,
    name: string,
): Promise<string> {
    // fixture-only: 带 X-Workspace-Id = 工作区门（MANAGE_WORKSPACE_AGENTS）。PLAN-0750 M1 起
    // 缺头 = 用户级门（CREATE_OWN_AGENT ⇒ 201 / 缺原子 403），不再 409；BL-328（409499d6）的历史修复保留。
    const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
        "X-Workspace-Id": auth.workspaceId,
    };
    const me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
    expect(me.ok(), await me.text()).toBe(true);
    const { id: userId } = (await me.json()) as { id: string };
    seedUserGrantPermissions(userId, standardWorkspaceUserPermissions(auth.workspaceId));

    const roleId = randomUUID(),
        templateId = randomUUID();
    const template = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
        headers,
        data: {
            roles: JSON.stringify([{ id: roleId, name: `${name} Role`, permissions: [] }]),
            templates: JSON.stringify([
                {
                    id: templateId,
                    name,
                    description: "PLAN-0590 plain-chat fixture (no MCP tools)",
                    systemPrompt: "Answer with one short sentence.",
                    toolMode: "none",
                    provider: "openai",
                    model: "fake-openai",
                    roleId,
                },
            ]),
        },
    });
    expect(template.status(), await template.text()).toBe(200);

    const created = await request.post(`${CP_URL}/api/v1/agent-principals`, {
        headers,
        data: { name, templateId },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { principalId } = (await created.json()) as { principalId: string };

    const bound = await request.put(
        `${CP_URL}/api/v1/workspaces/${auth.workspaceId}/agents/${principalId}`,
        { headers, data: { permissions: [] } },
    );
    expect(bound.status(), await bound.text()).toBe(200);
    return principalId;
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
                    maxInputTokens: A_MAX_INPUT_TOKENS,
                    pruneWindowChars: A_PRUNE_WINDOW_CHARS,
                    recoveryBand: 0.9,
                }),
            },
        },
    );
    expect(response.status(), await response.text()).toBe(200);
}

async function expectEmptyWorkspaceLayer(
    request: APIRequestContext,
    ctx: JourneyContext,
    domain: string,
): Promise<void> {
    const response = await request.get(
        `${CP_URL}/api/v1/config/${domain}?layer=workspace&workspaceId=${ctx.workspaceId}`,
        { headers: ctx.headers },
    );
    expect(response.ok(), await response.text()).toBe(true);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([]);
}

/**
 * Plain chat through the product path: subscribe the session SSE from the page
 * (read-only probe; CP requires a subscriber before dispatch), send from the
 * composer, then read the probe buffer back. PLAN-0687: the old in-page
 * `POST /api/v1/chat` was a bypass — sending now goes through the UI under test.
 */
async function runPlainChat(
    page: Page,
    request: APIRequestContext,
    ctx: JourneyContext,
    sessionId: string,
): Promise<PlainChatResult> {
    await seedPage(page, ctx);
    await page.goto(`/workspace/${ctx.workspaceId}/chat/${sessionId}`, { waitUntil: "load" });
    await page
        .locator('[data-testid="chat-input"]')
        .waitFor({ state: "visible", timeout: LONG_TIMEOUT_MS });
    await ensureChatBinding(page, sessionId);

    // 1) read-only SSE subscription (page-side; only reads the event stream).
    const probeKey = "__plan0590PlainChatProbe";
    const subscribed = await page.evaluate(
        async ({ sid, ws, key }) => {
            // read-only: 只读订阅 session 事件流（SSE GET），不写任何服务端状态。
            const token = localStorage.getItem("xihe-token") ?? "";
            const headers: Record<string, string> = {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "X-Workspace-Id": ws,
            };
            const controller = new AbortController();
            const sse = await fetch(`/api/v1/events?sessionId=${encodeURIComponent(sid)}`, {
                headers,
                signal: controller.signal,
            }).catch(() => null);
            if (!sse || !sse.ok || !sse.body) {
                return { ok: false, status: sse?.status ?? 0 };
            }
            const reader = sse.body.getReader();
            const decoder = new TextDecoder();
            const state = { buffer: "", done: false, failure: "" };
            (window as unknown as Record<string, unknown>)[key] = { state };
            void (async () => {
                const deadline = Date.now() + 120000;
                while (!state.done && Date.now() < deadline) {
                    const chunk = await reader
                        .read()
                        .catch(() => ({ value: undefined, done: true }));
                    if (chunk.done || !chunk.value) break;
                    state.buffer += decoder.decode(chunk.value, { stream: true });
                    if (
                        /"type"\s*:\s*"done"/.test(state.buffer) ||
                        state.buffer.includes("event:done")
                    )
                        state.done = true;
                }
                controller.abort();
            })().catch((error: unknown) => {
                state.failure = String(error);
            });
            return { ok: true, status: sse.status };
        },
        { sid: sessionId, ws: ctx.workspaceId, key: probeKey },
    );
    expect(subscribed.ok, "session SSE subscription (read-only probe)").toBe(true);

    // 2) product path: send the probe message from the composer, not via fetch.
    await page.getByTestId("chat-input").fill("plan-0590 plain chat probe");
    await page.getByTestId("chat-send-button").click();

    // 3) read the probe buffer back (read-only) and derive the reported window.
    const result = await page.evaluate(
        async ({ key }) => {
            const probe = (window as unknown as Record<string, unknown>)[key] as
                | { state: { buffer: string; done: boolean; failure: string } }
                | undefined;
            if (!probe) {
                return { windowTokens: null, done: false, bufferChars: -1 };
            }
            const deadline = Date.now() + 120000;
            while (!probe.state.done && !probe.state.failure && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            const match = /"windowTokens"\s*:\s*(\d+)/.exec(probe.state.buffer);
            return {
                windowTokens: match ? Number(match[1]) : null,
                done: probe.state.done,
                bufferChars: probe.state.buffer.length,
            };
        },
        { key: probeKey },
    );
    await awaitLatestChatRunCompleted(request, ctx.headers, ctx.workspaceId);
    return result;
}

test.describe("@host PLAN-0590 Agent run-config isolation (two workspaces, one process)", () => {
    test.describe.configure({ mode: "serial" });

    let wsA: JourneyContext, wsB: JourneyContext;
    let principalA = "",
        principalB = "";
    let sessionA = "",
        sessionB = "";

    test.beforeAll(async ({ request }) => {
        test.setTimeout(TEST_TIMEOUT_MS);
        wsA = await registerJourneyUser(request, "plan-0590-ws-a");
        wsB = await registerJourneyUser(request, "plan-0590-ws-b");
        expect(wsA.workspaceId).not.toBe(wsB.workspaceId);

        // fixture-only: POST /sessions 会解析主体的默认模型 profile 并要一条可用连接，
        // 共享真栈/宿主 lane 上这两个新建用户都没有连接，会 409 LLM_PROFILE_CONFLICT。
        await ensureFakeUserProvider(request, {
            accessToken: wsA.authToken,
            workspaceId: wsA.workspaceId,
        });
        await ensureFakeUserProvider(request, {
            accessToken: wsB.authToken,
            workspaceId: wsB.workspaceId,
        });

        // Only A carries a workspace layer; B must never see it.
        await writeWorkspaceContextPolicy(request, wsA);
        await expectEmptyWorkspaceLayer(request, wsB, "context-policy");
        await expectEmptyWorkspaceLayer(request, wsB, "agent-runtime");

        principalA = await provisionPlainChatPrincipal(
            request,
            { accessToken: wsA.authToken, workspaceId: wsA.workspaceId },
            agentName("Plan0590A"),
        );
        principalB = await provisionPlainChatPrincipal(
            request,
            { accessToken: wsB.authToken, workspaceId: wsB.workspaceId },
            agentName("Plan0590B"),
        );
        sessionA = await createSessionWithPrincipal(
            request,
            { accessToken: wsA.authToken, workspaceId: wsA.workspaceId },
            { principalId: principalA, title: "PLAN-0590 A run" },
        );
        sessionB = await createSessionWithPrincipal(
            request,
            { accessToken: wsB.authToken, workspaceId: wsB.workspaceId },
            { principalId: principalB, title: "PLAN-0590 B run" },
        );

        // The rebind restart inherits this process env (journey.ts spreads
        // process.env into the Agent child), so the Agent's *process* config
        // baseline is explicitly workspace A — never B's.
        process.env.XIHE_WORKSPACE_ID = wsA.workspaceId;
        await ensureAgentWorkspaceBinding(wsA.workspaceId);
    });

    test.afterAll(() => {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        writeFileSync(
            path.join(EVIDENCE_DIR, "manifest.json"),
            JSON.stringify(
                {
                    plan: "PLAN-0590",
                    baseline: BASELINE,
                    runId: process.env.XIHE_E2E_RUN_ID ?? null,
                    workspaceA: wsA?.workspaceId ?? null,
                    workspaceB: wsB?.workspaceId ?? null,
                    sessionA,
                    sessionB,
                    agentLog: (() => {
                        try {
                            return agentLogFile();
                        } catch {
                            return null;
                        }
                    })(),
                    capturedAt: new Date().toISOString(),
                },
                null,
                2,
            ),
        );
    });

    test("workspace A run resolves A's workspace-layer context policy", async ({
        page,
        request,
    }, testInfo) => {
        const logFile = agentLogFile();
        const offset = statSync(logFile).size;
        const chat = await runPlainChat(page, request, wsA, sessionA);
        testInfo.annotations.push({
            type: "plain-chat",
            description: `A u=${wsA.workspaceId} windowTokens=${chat.windowTokens} done=${chat.done}`,
        });

        const policies = resolvedPolicies(readLogDelta(logFile, offset));
        if (BASELINE) {
            const observed = policies[policies.length - 1];
            expect(observed, "A run must log a resolved context policy").toBeTruthy();
            expect(observed.maxInputTokens).toBe(String(A_MAX_INPUT_TOKENS));
            expect(observed.pruneWindowChars).toBe(A_PRUNE_WINDOW_CHARS);
            expect(observed.workspaceId, "baseline: runs are not attributed").toBeNull();
            return;
        }
        expect(policies.length, "A run must log a resolved context policy").toBeGreaterThan(0);
        const scoped = policies.filter((entry) => entry.workspaceId === wsA.workspaceId);
        expect(
            scoped.length,
            `A run must log its workspace identity; lines=${JSON.stringify(policies.map((p) => p.line))}`,
        ).toBeGreaterThan(0);
        expect(scoped[scoped.length - 1].maxInputTokens).toBe(String(A_MAX_INPUT_TOKENS));
        expect(scoped[scoped.length - 1].pruneWindowChars).toBe(A_PRUNE_WINDOW_CHARS);
    });

    test("workspace B run resolves B's own defaults, not A's workspace layer", async ({
        page,
        request,
    }, testInfo) => {
        const logFile = agentLogFile();
        const offset = statSync(logFile).size;
        const chat = await runPlainChat(page, request, wsB, sessionB);
        testInfo.annotations.push({
            type: "plain-chat",
            description: `B u=${wsB.workspaceId} windowTokens=${chat.windowTokens} done=${chat.done}`,
        });

        const policies = resolvedPolicies(readLogDelta(logFile, offset));
        expect(policies.length, "B run must log a resolved context policy").toBeGreaterThan(0);
        const scoped = policies.filter((entry) => entry.workspaceId === wsB.workspaceId);

        if (BASELINE) {
            // Pre-change evidence: the process snapshot (workspace A) is the base,
            // so B inherits A's workspace layer even though B's layer is empty.
            expect(scoped.length, "baseline: the Agent cannot attribute a run to B").toBe(0);
            const observed = policies[policies.length - 1];
            expect(observed.maxInputTokens).toBe(String(A_MAX_INPUT_TOKENS));
            expect(observed.pruneWindowChars).toBe(A_PRUNE_WINDOW_CHARS);
            return;
        }
        expect(
            scoped.length,
            `B run must log workspaceId=${wsB.workspaceId}; lines=${JSON.stringify(policies.map((p) => p.line))}`,
        ).toBeGreaterThan(0);
        expect(scoped[scoped.length - 1].maxInputTokens).toBe("None");
        expect(scoped[scoped.length - 1].pruneWindowChars).toBe(CODE_DEFAULT_PRUNE_WINDOW_CHARS);
    });
});
