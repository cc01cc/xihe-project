import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import {
    CP_URL,
    ensureChatBinding,
    getRootBranchId,
    registerJourneyUser,
    seedPage,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";

const AGENT_URL = `http://127.0.0.1:${process.env.XIHE_AGENT_PORT ?? "12632"}`;
const SERVICE_TOKEN = process.env.XIHE_CP_API_TOKEN ?? "";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKPOINT_CONTINUATION_URL = `${CP_URL}/api/v1/chat/runs`;

test.describe.configure({ mode: "serial", retries: 0 });

type RunView = { runId: string; status: string; errorCode: string | null };
type FixtureState = { mutationCount: number; ambiguousArmed: boolean; pendingResponses: number };
type CursorSnapshot = { checkpointId: string; eventSequence: number; branchHead: number };

function requiredUuid(value: string, label: string): string {
    if (!UUID_PATTERN.test(value)) throw new Error(`${label} is not a UUID`);
    return value;
}

function psql(sql: string): string {
    const container = process.env.XIHE_E2E_PG_CONTAINER;
    const database = process.env.XIHE_E2E_PG_DATABASE;
    const dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error("isolated PostgreSQL fixture metadata is unavailable");
    }
    try {
        return execFileSync(
            process.platform === "win32" ? "docker.exe" : "docker",
            ["exec", container, "psql", "-X", "-A", "-t", "-U", dbUser, "-d", database, "-c", sql],
            {
                encoding: "utf8",
                timeout: 15_000,
                windowsHide: true,
                stdio: ["ignore", "pipe", "ignore"],
            },
        ).trim();
    } catch {
        throw new Error("isolated PostgreSQL checkpoint query failed");
    }
}

function readCursorSnapshot(
    sessionId: string,
    branchId: string,
    sourceRunId: string,
): CursorSnapshot | null {
    requiredUuid(sessionId, "sessionId");
    requiredUuid(branchId, "branchId");
    requiredUuid(sourceRunId, "sourceRunId");
    const row = psql(
        `SELECT c.checkpoint_id || '|' || (c.metadata->>'eventSequence') || '|' || ` +
            `COALESCE((SELECT max(sequence)::text FROM context_events ` +
            `WHERE session_id='${sessionId}'::uuid AND branch_id='${branchId}'::uuid), '0') ` +
            `FROM agent_graph_checkpoints c ` +
            `JOIN agent_graph_checkpoint_lineages l ON l.lineage_id=c.lineage_id ` +
            `WHERE l.source_run_id='${sourceRunId}'::uuid AND l.session_id='${sessionId}'::uuid ` +
            `AND l.branch_id='${branchId}'::uuid AND c.checkpoint_ns='' ` +
            `AND c.metadata ? 'eventSequence' ` +
            `ORDER BY c.created_at DESC, c.checkpoint_id DESC LIMIT 1`,
    );
    if (!row) return null;
    const [checkpointId, sequenceText, headText] = row.split("|");
    const eventSequence = Number(sequenceText);
    const branchHead = Number(headText);
    if (
        !checkpointId ||
        !Number.isSafeInteger(eventSequence) ||
        !Number.isSafeInteger(branchHead)
    ) {
        throw new Error("checkpoint cursor query returned an invalid projection");
    }
    return { checkpointId, eventSequence, branchHead };
}

function toolCalledCount(sessionId: string, branchId: string, runId: string): number {
    requiredUuid(sessionId, "sessionId");
    requiredUuid(branchId, "branchId");
    requiredUuid(runId, "runId");
    const result = psql(
        `SELECT count(*) FROM context_events WHERE session_id='${sessionId}'::uuid ` +
            `AND branch_id='${branchId}'::uuid AND event_type='tool.called' ` +
            `AND correlation_id='${runId}'`,
    );
    const count = Number(result);
    if (!Number.isSafeInteger(count)) throw new Error("tool event count is invalid");
    return count;
}

function continuationCheckpointId(runId: string): string {
    requiredUuid(runId, "runId");
    const checkpointId = psql(
        `SELECT continuation_checkpoint_id FROM chat_runs WHERE id='${runId}'::uuid`,
    );
    if (!checkpointId) throw new Error("continued Run has no checkpoint provenance");
    return checkpointId;
}

function lineageInvocationState(sourceRunId: string, originatingToolCallId: string): string {
    requiredUuid(sourceRunId, "sourceRunId");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(originatingToolCallId)) {
        throw new Error("originating tool-call identity is invalid");
    }
    const result = psql(
        `SELECT COALESCE(li.status, 'missing') || '|' || COALESCE(mi.status, 'missing') ` +
            `FROM agent_graph_checkpoint_lineages l ` +
            `LEFT JOIN agent_lineage_invocations li ON li.lineage_id=l.lineage_id ` +
            `AND li.originating_tool_call_id='${originatingToolCallId}' ` +
            `LEFT JOIN mcp_invocations mi ON mi.id=li.mcp_invocation_id ` +
            `WHERE l.source_run_id='${sourceRunId}'::uuid LIMIT 1`,
    );
    return result || "missing|missing";
}

async function openSessionSse(sessionId: string, accessToken: string): Promise<() => void> {
    const controller = new AbortController();
    const response = await fetch(
        `${CP_URL}/api/v1/events?sessionId=${encodeURIComponent(sessionId)}`,
        {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: "text/event-stream" },
            signal: controller.signal,
        },
    );
    expect(response.status, `Session SSE open failed: ${response.status}`).toBe(200);
    const reader = response.body?.getReader();
    void (async () => {
        try {
            for (;;) {
                const chunk = await reader?.read();
                if (chunk?.done !== false) break;
            }
        } catch (error) {
            // Restart intentionally closes this stream; keep only safe error metadata.
            console.info(
                `[checkpoint-resume] session SSE closed (${error instanceof Error ? error.name : "unknown"})`,
            );
        }
    })();
    return () => controller.abort();
}

async function runView(
    request: APIRequestContext,
    headers: Record<string, string>,
    runId: string,
): Promise<RunView> {
    const response = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, { headers });
    if (!response.ok()) return { runId, status: "unavailable", errorCode: null };
    return (await response.json()) as RunView;
}

async function pendingApprovalIds(sessionId: string): Promise<string[]> {
    requiredUuid(sessionId, "sessionId");
    return psql(
        `SELECT request_id FROM approval_requests WHERE session_id='${sessionId}'::uuid ` +
            `AND state='pending' ORDER BY created_at LIMIT 32`,
    )
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

async function approvePending(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
): Promise<void> {
    for (const requestId of await pendingApprovalIds(sessionId)) {
        const response = await request.post(
            `${CP_URL}/api/v1/chat/approvals/${requestId}/decision`,
            {
                headers,
                data: { decision: "once" },
            },
        );
        expect(response.status(), `approval decision failed (${response.status()})`).toBe(200);
    }
}

async function hostControl(
    path: string,
    data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const url = process.env.XIHE_E2E_HOST_CONTROL_URL;
    const token = process.env.XIHE_E2E_HOST_CONTROL_TOKEN;
    if (!url || !token) throw new Error("runner-owned Host control is unavailable");
    const response = await fetch(`${url}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(120_000),
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status, `runner control ${path} failed with HTTP ${response.status}`).toBe(200);
    return body;
}

async function fakeMutationState(): Promise<FixtureState> {
    const body = await hostControl("/resume-fixture", { action: "state" });
    return body as FixtureState;
}

async function resetFakeMutation(): Promise<void> {
    const state = (await hostControl("/resume-fixture", { action: "reset" })) as FixtureState;
    expect(state).toMatchObject({ mutationCount: 0, ambiguousArmed: false, pendingResponses: 0 });
}

async function armAgentPause(
    request: APIRequestContext,
    stage: "before_tool_dispatch" | "after_tool_dispatch",
): Promise<void> {
    const response = await request.post(`${AGENT_URL}/internal/v1/agent/checkpoint-resume-probe`, {
        headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, "Content-Type": "application/json" },
        data: { action: "arm", stage },
    });
    expect(response.status(), "Agent failpoint must be enabled only for this exact Host spec").toBe(
        200,
    );
    expect(await response.json()).toMatchObject({
        enabled: true,
        armed: true,
        paused: false,
        stage,
    });
}

async function waitForAgentPause(
    request: APIRequestContext,
    stage: "before_tool_dispatch" | "after_tool_dispatch",
    onPoll?: () => Promise<void>,
): Promise<void> {
    await expect
        .poll(
            async () => {
                await onPoll?.();
                const response = await request.get(
                    `${AGENT_URL}/internal/v1/agent/checkpoint-resume-probe`,
                    {
                        headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
                    },
                );
                if (!response.ok()) return "unavailable";
                const body = (await response.json()) as {
                    enabled?: boolean;
                    paused?: boolean;
                    stage?: string;
                };
                return body.enabled && body.paused && body.stage === stage ? "paused" : "waiting";
            },
            { timeout: 90_000, intervals: [250, 500, 1000, 2000] },
        )
        .toBe("paused");
}

async function restartCpAndAgent(
    request: APIRequestContext,
    headers: Record<string, string>,
): Promise<void> {
    for (const service of ["control-plane", "agent"] as const) {
        const result = await hostControl("/restart-service", { service });
        expect(result).toEqual({ service, pidChanged: true });
    }
    await waitForControlPlaneAgentReady(request, headers);
}

async function waitForRunTerminal(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
    runId: string,
): Promise<RunView> {
    let current: RunView = { runId, status: "unobserved", errorCode: null };
    await expect
        .poll(
            async () => {
                await approvePending(request, headers, sessionId);
                current = await runView(request, headers, runId);
                return current.status;
            },
            { timeout: 150_000, intervals: [500, 1000, 2000, 3000] },
        )
        .toMatch(/^(succeeded|partial|failed|cancelled|ambiguous)$/);
    return current;
}

async function submitMutationRun(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
    branchId: string,
    tag: string,
): Promise<string> {
    const response = await request.post(`${CP_URL}/api/v1/chat`, {
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        data: {
            sessionId,
            branchId,
            content: `XIHE-E2E-RESUME-MUTATE ${tag}`,
            toolMode: "workspace",
        },
        timeout: 30_000,
    });
    expect(response.status(), `Chat admission failed: HTTP ${response.status()}`).toBe(202);
    const body = (await response.json()) as { runId?: string };
    if (!body.runId || !UUID_PATTERN.test(body.runId))
        throw new Error("Chat admission omitted Run identity");
    return body.runId;
}

async function resumePending(
    request: APIRequestContext,
    headers: Record<string, string>,
    sourceRunId: string,
): Promise<{ response: number; body: Record<string, unknown> }> {
    const result = await request.post(`${CHECKPOINT_CONTINUATION_URL}/${sourceRunId}/continue`, {
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        data: { mode: "resume_pending" },
    });
    const body = (await result.json()) as Record<string, unknown>;
    return { response: result.status(), body };
}

async function createRemoteMutationServer(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
): Promise<void> {
    const serverId = randomUUID();
    const fakeMcpPort = process.env.XIHE_FAKE_MCP_PORT ?? "13641";
    const fakeOAuthPort = process.env.XIHE_FAKE_OAUTH_PORT ?? "13640";
    const cpPort = process.env.XIHE_CP_PORT ?? "12631";
    const session = await request.post(`${CP_URL}/api/v1/oauth/sessions`, {
        headers,
        data: {
            workspaceId,
            serverId,
            remoteEndpoint: `http://host.docker.internal:${fakeMcpPort}/mcp`,
            clientId: "xihe-e2e-client",
            authorizationEndpoint: `http://localhost:${fakeOAuthPort}/authorize`,
            tokenEndpoint: `http://127.0.0.1:${fakeOAuthPort}/token`,
            redirectUri: `http://localhost:${cpPort}/api/v1/oauth/callback`,
            scope: "mcp:tools",
        },
    });
    expect(session.ok(), `OAuth session setup failed: HTTP ${session.status()}`).toBeTruthy();
    const oauth = (await session.json()) as { authorizationUrl?: string };
    if (!oauth.authorizationUrl) throw new Error("OAuth authorization URL is unavailable");
    const authorize = await request.get(oauth.authorizationUrl, { maxRedirects: 0 });
    expect(authorize.status()).toBe(302);
    const location = authorize.headers().location;
    if (!location) throw new Error("Fake OAuth authorization omitted callback location");
    const callback = new URL(location);
    const callbackResult = await request.get(`${CP_URL}${callback.pathname}${callback.search}`);
    expect(
        callbackResult.ok(),
        `OAuth callback failed: HTTP ${callbackResult.status()}`,
    ).toBeTruthy();

    // The fixture mutation is classified only in this test workspace so the
    // existing CP authorization and approval path handles it like a write.
    const face = await request.post(`${CP_URL}/api/v1/policy/tool-faces`, {
        headers,
        data: {
            scope: "workspace",
            tool: "remote_mutate",
            actionClass: "write",
            shape: "structured",
        },
    });
    expect(face.ok(), `Workspace tool-face setup failed: HTTP ${face.status()}`).toBeTruthy();
}

test("@host PLAN-0510 continuation resumes only an exact safe checkpoint", async ({
    page,
    request,
}) => {
    test.setTimeout(600_000);
    // PLAN-0510: this probe only runs through the runner's dedicated resume lane
    // (the spec is passed explicitly and e2e-host.mjs derives
    // XIHE_E2E_LLM_MODE=checkpoint_resume). A directory-expanded batch cannot
    // satisfy that contract, so gate it instead of failing the whole lane.
    test.skip(
        process.env.XIHE_E2E_CHECKPOINT_RESUME_ACTIVE !== "true" ||
            process.env.XIHE_E2E_LLM_MODE !== "checkpoint_resume",
        "requires the dedicated checkpoint-resume lane (node scripts/e2e-host.mjs e2e/real/checkpoint-resume.spec.ts); current mode=" +
            (process.env.XIHE_E2E_LLM_MODE ?? "unset"),
    );
    expect(Boolean(process.env.XIHE_E2E_RUN_ID)).toBe(true);
    expect(Boolean(SERVICE_TOKEN)).toBe(true);
    expect(Boolean(process.env.XIHE_FAKE_MCP_ACCESS_TOKEN)).toBe(true);
    expect(Boolean(process.env.XIHE_E2E_PG_CONTAINER)).toBe(true);

    const journey = await registerJourneyUser(request, "checkpoint-resume");
    const headers = { ...journey.headers, "X-Workspace-Id": journey.workspaceId };
    seedPage(page, journey);
    await page.goto(`/workspace/${journey.workspaceId}`, { waitUntil: "load" });
    await createRemoteMutationServer(request, headers, journey.workspaceId);
    const principalId = await provisionWorkspaceAgentPrincipal(
        request,
        { accessToken: journey.authToken, workspaceId: journey.workspaceId },
        {
            name: `Checkpoint Resume ${process.env.XIHE_E2E_RUN_ID}`,
            actions: ["write"],
            systemPrompt:
                "Use the available tools to complete the requested mutation, then answer briefly.",
        },
    );
    await waitForControlPlaneAgentReady(request, headers);

    let closeSse: (() => void) | undefined;
    const newSession = async (label: string) => {
        const sessionId = await createSessionWithPrincipal(
            request,
            { accessToken: journey.authToken, workspaceId: journey.workspaceId },
            { principalId, title: `${label}-${process.env.XIHE_E2E_RUN_ID}` },
        );
        await ensureChatBinding(page, sessionId);
        const branchId = await getRootBranchId(request, sessionId, headers);
        return { sessionId, branchId };
    };

    try {
        // Positive: checkpointed pending AI tool call, interruption before any
        // CP dispatch, then restart and resume that same pending node once.
        await resetFakeMutation();
        const before = await newSession("resume-before-dispatch");
        const beforeTag = `before-${randomUUID()}`;
        const beforeOriginId = `call-resume-mutate-${beforeTag}`;
        closeSse = await openSessionSse(before.sessionId, journey.authToken);
        await armAgentPause(request, "before_tool_dispatch");
        const beforeRunId = await submitMutationRun(
            request,
            headers,
            before.sessionId,
            before.branchId,
            beforeTag,
        );
        await waitForAgentPause(request, "before_tool_dispatch", () =>
            approvePending(request, headers, before.sessionId),
        );
        const beforeCursor = readCursorSnapshot(before.sessionId, before.branchId, beforeRunId);
        expect(beforeCursor, "the pending tool-call checkpoint must be durable").not.toBeNull();
        expect(beforeCursor!.eventSequence).toBe(beforeCursor!.branchHead);
        expect(toolCalledCount(before.sessionId, before.branchId, beforeRunId)).toBe(0);
        expect(await fakeMutationState()).toMatchObject({ mutationCount: 0, pendingResponses: 0 });

        closeSse?.();
        closeSse = undefined;
        await restartCpAndAgent(request, headers);
        await expect
            .poll(async () => runView(request, headers, beforeRunId), {
                timeout: 45_000,
                intervals: [250, 500, 1000, 2000],
            })
            .toMatchObject({ status: "ambiguous", errorCode: "CP_RESTARTED" });
        closeSse = await openSessionSse(before.sessionId, journey.authToken);
        const accepted = await resumePending(request, headers, beforeRunId);
        expect(accepted.response, `resume admission failed: ${JSON.stringify(accepted.body)}`).toBe(
            202,
        );
        expect(accepted.body.mode).toBe("resume_pending");
        const resumedRunId = accepted.body.runId;
        expect(typeof resumedRunId).toBe("string");
        expect(continuationCheckpointId(String(resumedRunId))).toBe(beforeCursor!.checkpointId);
        const resumed = await waitForRunTerminal(
            request,
            headers,
            before.sessionId,
            String(resumedRunId),
        );
        expect(["succeeded", "partial"]).toContain(resumed.status);
        expect(await fakeMutationState()).toMatchObject({ mutationCount: 1, pendingResponses: 0 });
        expect(lineageInvocationState(beforeRunId, beforeOriginId)).toBe("completed|completed");

        closeSse?.();
        closeSse = undefined;

        // Negative: the MCP side effect and CP ledger settle, but the Agent is
        // stopped before a ToolMessage/checkpoint can represent the result.
        await resetFakeMutation();
        const after = await newSession("resume-after-dispatch");
        closeSse = await openSessionSse(after.sessionId, journey.authToken);
        const afterTag = `after-${randomUUID()}`;
        const afterOriginId = `call-resume-mutate-${afterTag}`;
        await armAgentPause(request, "after_tool_dispatch");
        const afterRunId = await submitMutationRun(
            request,
            headers,
            after.sessionId,
            after.branchId,
            afterTag,
        );
        await waitForAgentPause(request, "after_tool_dispatch", () =>
            approvePending(request, headers, after.sessionId),
        );
        expect(await fakeMutationState()).toMatchObject({ mutationCount: 1, pendingResponses: 0 });
        expect(toolCalledCount(after.sessionId, after.branchId, afterRunId)).toBe(1);
        const afterCursor = readCursorSnapshot(after.sessionId, after.branchId, afterRunId);
        expect(afterCursor).not.toBeNull();
        expect(afterCursor!.branchHead).toBeGreaterThan(afterCursor!.eventSequence);

        closeSse?.();
        closeSse = undefined;
        await restartCpAndAgent(request, headers);
        await expect
            .poll(async () => runView(request, headers, afterRunId), {
                timeout: 45_000,
                intervals: [250, 500, 1000, 2000],
            })
            .toMatchObject({ status: "ambiguous", errorCode: "CP_RESTARTED" });
        closeSse = await openSessionSse(after.sessionId, journey.authToken);
        const staleAfterDispatch = await resumePending(request, headers, afterRunId);
        expect(staleAfterDispatch.response).toBe(409);
        expect(staleAfterDispatch.body.code).toBe("CONTINUATION_SOURCE_STALE");
        expect(await fakeMutationState()).toMatchObject({ mutationCount: 1, pendingResponses: 0 });
        expect(lineageInvocationState(afterRunId, afterOriginId)).toBe("completed|completed");

        closeSse?.();
        closeSse = undefined;

        // Ambiguous: the remote fixture increments its independent side-effect
        // counter and drops the MCP response. CP restart converts the active
        // source Run to CP_RESTARTED; freshness rejects before V70 admission.
        await resetFakeMutation();
        const ambiguousArm = (await hostControl("/resume-fixture", {
            action: "arm-ambiguous",
        })) as FixtureState;
        expect(ambiguousArm.ambiguousArmed).toBe(true);
        const ambiguous = await newSession("resume-ambiguous-mutation");
        closeSse = await openSessionSse(ambiguous.sessionId, journey.authToken);
        const ambiguousTag = `ambiguous-${randomUUID()}`;
        const ambiguousOriginId = `call-resume-mutate-${ambiguousTag}`;
        const ambiguousRunId = await submitMutationRun(
            request,
            headers,
            ambiguous.sessionId,
            ambiguous.branchId,
            ambiguousTag,
        );
        await expect
            .poll(
                async () => {
                    await approvePending(request, headers, ambiguous.sessionId);
                    return await fakeMutationState();
                },
                { timeout: 120_000, intervals: [500, 1000, 2000, 3000] },
            )
            .toMatchObject({ mutationCount: 1, pendingResponses: 1 });
        closeSse?.();
        closeSse = undefined;
        await restartCpAndAgent(request, headers);
        await expect
            .poll(async () => runView(request, headers, ambiguousRunId), {
                timeout: 45_000,
                intervals: [250, 500, 1000, 2000],
            })
            .toMatchObject({ status: "ambiguous", errorCode: "CP_RESTARTED" });
        closeSse = await openSessionSse(ambiguous.sessionId, journey.authToken);
        const staleAmbiguous = await resumePending(request, headers, ambiguousRunId);
        expect(staleAmbiguous.response).toBe(409);
        expect(staleAmbiguous.body.code).toBe("CONTINUATION_SOURCE_STALE");
        expect(await fakeMutationState()).toMatchObject({ mutationCount: 1 });
        const ambiguousLedger = lineageInvocationState(ambiguousRunId, ambiguousOriginId).split(
            "|",
        );
        expect(ambiguousLedger[0]).toBe("pending");
        expect(["ambiguous", "unknown"]).toContain(ambiguousLedger[1]);

        await expect
            .poll(async () => (await fakeMutationState()).pendingResponses, {
                timeout: 45_000,
                intervals: [500, 1000, 2000],
            })
            .toBe(0);
        await resetFakeMutation();
    } finally {
        closeSse?.();
    }
});
