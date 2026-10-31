// PLAN-0590 — Agent run-config isolation across two workspaces in one process.
//
// Target invariant (default mode): a chat run in workspace B resolves config from
// B's own (workspace, user) identity, never from the workspace the Agent process
// was booted with (`XIHE_WORKSPACE_ID`). The pre-change baseline is recorded by
// running the same spec with XIHE_E2E_PLAN0590_BASELINE=1, which flips the B-side
// assertions to the known cross-talk values (workspace A's layer).
//
// The chat itself is a *plain* run (toolMode=none): the Workspace UI hardcodes
// toolMode=workspace, so this spec drives the documented public chat contract
// (SSE subscription + POST /api/v1/chat) from inside the browser context, reusing
// the app's own origin and localStorage token. MCP tooling (PLAN-0588) is
// deliberately out of scope here.
//
// Runs on the host E2E mock lane (fake LLM, 0 real provider calls):
//   node scripts/e2e-host.mjs --llm-mode=mock e2e/real/plan-0590-config-isolation.spec.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createSessionWithPrincipal } from "./helpers/agent-principal";
import {
    CP_URL,
    awaitLatestChatRunCompleted,
    ensureAgentWorkspaceBinding,
    ensureChatBinding,
    evidenceDir,
    getRootBranchId,
    registerJourneyUser,
    seedPage,
    type JourneyContext,
} from "./helpers/journey";
import {
    seedUserGrantPermissions,
    standardWorkspaceUserPermissions,
} from "./helpers/user-grants";

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
    const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
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
 * Plain chat (toolMode=none) through the public contract: open the session SSE
 * subscription first (CP requires it), then POST /api/v1/chat. Runs inside the
 * page so the app origin + localStorage token are reused.
 */
async function runPlainChat(
    page: Page,
    request: APIRequestContext,
    ctx: JourneyContext,
    sessionId: string,
    principalId: string,
    branchId: string,
): Promise<PlainChatResult> {
    await seedPage(page, ctx);
    await page.goto(`/workspace/${ctx.workspaceId}/chat/${sessionId}`, { waitUntil: "load" });
    await page.locator('[data-testid="chat-input"]').waitFor({ state: "visible", timeout: 20000 });
    await ensureChatBinding(page, sessionId);

    const result = await page.evaluate(
        async ({ sid, ws, principal, branch, session }) => {
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
                return { windowTokens: null, done: false, bufferChars: -1 };
            }
            const chat = fetch(`/api/v1/chat`, {
                method: "POST",
                headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
                body: JSON.stringify({
                    sessionId: sid,
                    branchId: branch,
                    content: "plan-0590 plain chat probe",
                    agentPrincipalId: principal,
                    toolMode: "none",
                }),
            }).catch(() => null);
            const reader = sse.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            const deadline = Date.now() + 120000;
            let done = false;
            while (!done && Date.now() < deadline) {
                const chunk = await reader.read().catch(() => ({ value: undefined, done: true }));
                if (chunk.done || !chunk.value) break;
                buffer += decoder.decode(chunk.value, { stream: true });
                if (/"type"\s*:\s*"done"/.test(buffer) || buffer.includes("event:done")) done = true;
            }
            controller.abort();
            await chat;
            const match = /"windowTokens"\s*:\s*(\d+)/.exec(buffer);
            return {
                windowTokens: match ? Number(match[1]) : null,
                done,
                bufferChars: buffer.length,
            };
        },
        {
            sid: sessionId,
            ws: ctx.workspaceId,
            principal: principalId,
            branch: branchId,
            session: sessionId,
        },
    );
    await awaitLatestChatRunCompleted(request, ctx.headers, ctx.workspaceId);
    return result;
}

test.describe("@host PLAN-0590 Agent run-config isolation (two workspaces, one process)", () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(300000);

    let wsA: JourneyContext, wsB: JourneyContext;
    let principalA = "", principalB = "";
    let sessionA = "", sessionB = "";

    test.beforeAll(async ({ request }) => {
        test.setTimeout(180000);
        wsA = await registerJourneyUser(request, "plan-0590-ws-a");
        wsB = await registerJourneyUser(request, "plan-0590-ws-b");
        expect(wsA.workspaceId).not.toBe(wsB.workspaceId);

        // Only A carries a workspace layer; B must never see it.
        await writeWorkspaceContextPolicy(request, wsA);
        await expectEmptyWorkspaceLayer(request, wsB, "context-policy");
        await expectEmptyWorkspaceLayer(request, wsB, "agent-runtime");

        principalA = await provisionPlainChatPrincipal(
            request,
            { accessToken: wsA.authToken, workspaceId: wsA.workspaceId },
            "PLAN-0590 A",
        );
        principalB = await provisionPlainChatPrincipal(
            request,
            { accessToken: wsB.authToken, workspaceId: wsB.workspaceId },
            "PLAN-0590 B",
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
        const branchId = await getRootBranchId(request, sessionA, wsA.headers);
        const logFile = agentLogFile();
        const offset = statSync(logFile).size;
        const chat = await runPlainChat(page, request, wsA, sessionA, principalA, branchId);
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
        const branchId = await getRootBranchId(request, sessionB, wsB.headers);
        const logFile = agentLogFile();
        const offset = statSync(logFile).size;
        const chat = await runPlainChat(page, request, wsB, sessionB, principalB, branchId);
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