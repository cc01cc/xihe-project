// timeout-exempt: real-provider Agent-to-Agent TO acceptance (task-735, LONG_TIMEOUT_MS)
/**
 * task-735: the MVP sentence's last missing half — an agent must decide to TO another agent.
 *
 * This spec drives a real provider (Xiaomi MiMo through the OpenAI-compatible route) and asserts
 * the model, not the harness, emits `dispatch_agent_task`. The fixture is deliberately three
 * product surfaces only:
 *
 * - two Agent principals in one session;
 * - the target principal opts into a derived-run surface with
 *   `contextPolicy.derivedRunToolMode = "none"` (its answer needs no tools);
 * - the root run receives a real user message that asks it to find the other agent and delegate.
 *
 * No internal CP endpoint is called to create the TO. The only write under the target run is the
 * model's own tool call, and every acceptance assertion is read from durable rows:
 *
 * 1. `context_events{tool.called}` has a real `dispatch_agent_task` call with its arguments;
 * 2. the target run is `succeeded` and has assistant text;
 * 3. every `wake_dispatch{triggerSource=to}` row carries `parentRunId=rootRunId` and its joined
 *    run origin is not `user_submission`;
 * 4. the target provider request body carries both provenance frames — CP's
 *    "addressed to you by another participant" and Agent's "本轮你是被点名的一方".
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
    CP_URL,
    awaitOperationCompletedForRun,
    getRootBranchId,
    realLaneConnectionConfig,
    registerJourneyUser,
    seedPage,
    waitForControlPlaneAgentReady,
    type JourneyContext,
} from "./helpers/journey";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { agentName } from "./helpers/agent-name";
import { openSessionSse } from "./helpers/sse";
import { workspaceSessionPath } from "../../src/lib/routes";
import { LONG_TIMEOUT_MS } from "../timeouts";

const REAL = realLaneConnectionConfig();
const RUN_NONCE = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const EXPECTED_TARGET_TEXT = `K1-BATCH2-OK-${RUN_NONCE}`;
const EVIDENCE_DIR =
    process.env.XIHE_E2E_K1_EVIDENCE_DIR ??
    path.join(process.env.XIHE_WORKSPACE_HOST_ROOT ?? process.cwd(), "k1-batch2-agent-to");

type Auth = {
    accessToken: string;
    workspaceId: string;
    headers: Record<string, string>;
};

type RealConnection = {
    id: string;
    revision: number;
    provider: string;
    model: string;
};

type WakeRow = {
    runId: string;
    parentRunId: string;
    triggerSource: string;
    origin: string;
    chatTriggerSource: string;
    status: string;
};

type ToolCallRow = {
    toolName: string;
    toolCallId: string;
    targetDisplayName: string;
    instruction: string;
};

function psql(sql: string): string {
    const container = process.env.XIHE_E2E_PG_CONTAINER;
    const database = process.env.XIHE_E2E_PG_DATABASE;
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

function rows(raw: string): string[][] {
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split("|"));
}

async function ensureRealConnection(
    request: APIRequestContext,
    auth: Auth,
): Promise<RealConnection> {
    if (!REAL) throw new Error("task-735 requires the real-provider lane");
    const list = await request.get(`${CP_URL}/api/v1/provider-connections`, {
        headers: auth.headers,
    });
    expect(list.ok(), await list.text()).toBe(true);
    const connections =
        (
            (await list.json()) as {
                connections?: Array<{
                    id: string;
                    providerId: string;
                    connectionKey: string;
                    apiTypeId?: string;
                    baseUrl?: string;
                    revision: number;
                    enabled?: boolean;
                    status?: string;
                    manualModels?: string[];
                }>;
            }
        ).connections ?? [];
    let connection = connections.find(
        (row) =>
            row.providerId === REAL.provider &&
            row.connectionKey === "default" &&
            row.apiTypeId === REAL.apiTypeId &&
            row.baseUrl === REAL.baseUrl &&
            row.enabled !== false &&
            row.status === "READY" &&
            (row.manualModels ?? []).includes(REAL.model),
    );
    if (!connection) {
        const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers: auth.headers,
            data: {
                providerId: REAL.provider,
                apiTypeId: REAL.apiTypeId,
                apiTypeVersion: REAL.apiTypeVersion,
                apiKey: REAL.apiKey,
                connectionKey: "default",
                label: "K1 batch2 real provider",
                scope: "USER",
                modelDiscovery: "manual",
                manualModels: [REAL.model],
                baseUrl: REAL.baseUrl,
            },
        });
        expect(created.ok(), await created.text()).toBe(true);
        const createdBody = (await created.json()) as {
            id: string;
            revision: number;
            status: string;
        };
        connection = {
            ...createdBody,
            providerId: REAL.provider,
            connectionKey: "default",
            apiTypeId: REAL.apiTypeId,
            baseUrl: REAL.baseUrl,
            enabled: true,
            manualModels: [REAL.model],
        };
    }
    if (connection.status !== "READY") {
        const verified = await request.post(
            `${CP_URL}/api/v1/provider-connections/${connection.id}/verify`,
            { headers: auth.headers },
        );
        expect(verified.ok(), await verified.text()).toBe(true);
        const body = (await verified.json()) as {
            connection: { revision: number; status: string };
        };
        expect(body.connection.status).toBe("READY");
        connection.revision = body.connection.revision;
    }
    const profile = await request.put(`${CP_URL}/api/v1/config/user/llm-provider`, {
        headers: auth.headers,
        data: {
            profile: JSON.stringify({
                providerId: REAL.provider,
                connectionKey: "default",
                model: REAL.model,
            }),
        },
    });
    expect(profile.status(), await profile.text()).toBe(200);
    return {
        id: connection.id,
        revision: connection.revision,
        provider: REAL.provider,
        model: REAL.model,
    };
}

async function bindSessionToReal(
    request: APIRequestContext,
    auth: Auth,
    sessionId: string,
    connection: RealConnection,
): Promise<void> {
    const bound = await request.patch(`${CP_URL}/api/v1/sessions/${sessionId}`, {
        headers: auth.headers,
        data: {
            providerConnectionId: connection.id,
            modelProvider: connection.provider,
            modelName: connection.model,
            connectionRevision: connection.revision,
        },
    });
    expect(bound.ok(), await bound.text()).toBe(true);
}

async function optTargetIntoDerivedRun(
    request: APIRequestContext,
    auth: Auth,
    principalId: string,
): Promise<void> {
    const patched = await request.patch(`${CP_URL}/api/v1/agent-principals/${principalId}`, {
        headers: auth.headers,
        data: { contextPolicy: { derivedRunToolMode: "none" } },
    });
    expect(patched.status(), await patched.text()).toBe(200);
}

async function addAgentParticipant(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
    principalId: string,
): Promise<void> {
    const added = await request.post(`${CP_URL}/api/v1/sessions/${sessionId}/participants`, {
        headers,
        data: { principalKind: "AGENT", principalId, role: "MEMBER" },
    });
    expect(added.status(), await added.text()).toBe(201);
}

async function sendRootRun(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
    branchId: string,
): Promise<string> {
    const content =
        `Use list_session_participants to find the other AGENT participant (do not use yourself). ` +
        `Then call dispatch_agent_task exactly once and give that participant this self-contained ` +
        `instruction: Reply with exactly "${EXPECTED_TARGET_TEXT}" and nothing else. ` +
        `Do not answer that micro-task yourself. After the tool returns, acknowledge in one short sentence.`;
    const response = await request.post(`${CP_URL}/api/v1/chat`, {
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        data: { sessionId, branchId, content, toolMode: "workspace" },
    });
    expect(response.status(), `send failed: ${await response.text()}`).toBe(202);
    const runId = ((await response.json()) as { runId: string }).runId;
    await awaitOperationCompletedForRun(request, headers, runId);
    const status = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, { headers });
    expect(status.ok(), await status.text()).toBe(true);
    expect(
        ((await status.json()) as { status?: string }).status,
        `root run ${runId} did not succeed`,
    ).toBe("succeeded");
    return runId;
}

async function readTargetRunId(rootRunId: string, sessionId: string): Promise<string> {
    let target = "";
    await expect
        .poll(
            () => {
                const raw = psql(
                    `SELECT coalesce(payload->>'runId', '') FROM context_events ` +
                        `WHERE session_id = ${sqlLiteral(sessionId)}::uuid ` +
                        `AND event_type = 'wake_dispatch' ` +
                        `AND payload->>'triggerSource' = 'to' ` +
                        `AND payload->>'parentRunId' = ${sqlLiteral(rootRunId)} ` +
                        `ORDER BY sequence DESC LIMIT 1;`,
                );
                target = raw.trim();
                return target;
            },
            {
                timeout: LONG_TIMEOUT_MS,
                intervals: [500, 1_000, 2_000],
                message: `no agent-origin TO wake row landed for root run ${rootRunId}`,
            },
        )
        .not.toBe("");
    return target;
}

function readToolCalls(rootRunId: string, sessionId: string): ToolCallRow[] {
    // PLAN-0381 keeps two payload shapes behind the writer gate: the default legacy shape has
    // `call_id/tool_name/tool_input` and no runId; the v2 shape has `toolCallId/toolName/runId`.
    // Read both, and filter to the root run in JS (legacy rows carry no runId at all).
    const raw = psql(
        `SELECT coalesce(payload->>'toolName', payload->>'tool_name', ''), ` +
            `coalesce(payload->>'toolCallId', payload->>'call_id', ''), ` +
            `coalesce(payload #>> '{arguments,target_display_name}', ` +
            `payload #>> '{tool_input,target_display_name}', ''), ` +
            `coalesce(payload #>> '{arguments,instruction}', ` +
            `payload #>> '{tool_input,instruction}', ''), ` +
            `coalesce(payload->>'runId', '') ` +
            `FROM context_events ` +
            `WHERE session_id = ${sqlLiteral(sessionId)}::uuid ` +
            `AND event_type = 'tool.called' ` +
            `ORDER BY sequence;`,
    );
    return rows(raw)
        .filter((row) => {
            const runId = row[4] ?? "";
            return runId === "" || runId === rootRunId;
        })
        .map((row) => ({
            toolName: row[0] ?? "",
            toolCallId: row[1] ?? "",
            targetDisplayName: row[2] ?? "",
            instruction: row[3] ?? "",
        }));
}

function readToolEventPayloads(sessionId: string, limit: number): string[] {
    const raw = psql(
        `SELECT payload::text FROM context_events ` +
            `WHERE session_id = ${sqlLiteral(sessionId)}::uuid ` +
            `AND event_type = 'tool.called' ` +
            `ORDER BY sequence LIMIT ${limit};`,
    );
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function readToOrigins(sessionId: string): Array<{ runId: string; origin: string }> {
    const raw = psql(
        `SELECT coalesce(e.payload->>'runId', ''), coalesce(r.origin, '') ` +
            `FROM context_events e LEFT JOIN chat_runs r ` +
            `ON r.id::text = e.payload->>'runId' ` +
            `WHERE e.session_id = ${sqlLiteral(sessionId)}::uuid ` +
            `AND e.event_type = 'wake_dispatch' ` +
            `AND e.payload->>'triggerSource' = 'to' ` +
            `ORDER BY e.sequence;`,
    );
    return rows(raw).map(([runId, origin]) => ({ runId, origin }));
}

function readAllWakeRows(rootRunId: string, sessionId: string): WakeRow[] {
    const raw = psql(
        `SELECT coalesce(e.payload->>'runId', ''), coalesce(e.payload->>'parentRunId', ''), ` +
            `coalesce(e.payload->>'triggerSource', ''), coalesce(r.origin, ''), ` +
            `coalesce(r.trigger_source, ''), coalesce(r.status, '') ` +
            `FROM context_events e LEFT JOIN chat_runs r ` +
            `ON r.id::text = e.payload->>'runId' ` +
            `WHERE e.session_id = ${sqlLiteral(sessionId)}::uuid ` +
            `AND e.event_type = 'wake_dispatch' ` +
            `AND e.payload->>'triggerSource' = 'to' ` +
            `AND e.payload->>'parentRunId' = ${sqlLiteral(rootRunId)} ` +
            `ORDER BY e.sequence;`,
    );
    return rows(raw).map(
        ([runId, parentRunId, triggerSource, origin, chatTriggerSource, status]) => ({
            runId,
            parentRunId,
            triggerSource,
            origin,
            chatTriggerSource,
            status,
        }),
    );
}

function readRun(runId: string): {
    status: string;
    origin: string;
    triggerSource: string;
    parentRunId: string;
} {
    const raw = psql(
        `SELECT coalesce(status, ''), coalesce(origin, ''), coalesce(trigger_source, ''), ` +
            `coalesce(parent_run_id::text, '') FROM chat_runs WHERE id = ${sqlLiteral(runId)}::uuid;`,
    );
    const [status, origin, triggerSource, parentRunId] = (rows(raw)[0] ?? []).map(String);
    return {
        status: status ?? "",
        origin: origin ?? "",
        triggerSource: triggerSource ?? "",
        parentRunId: parentRunId ?? "",
    };
}

function readAssistantText(runId: string): string {
    return psql(
        `SELECT coalesce(string_agg(content, E'\\n' ORDER BY created_at), '') ` +
            `FROM messages WHERE run_id = ${sqlLiteral(runId)}::uuid AND role = 'ASSISTANT';`,
    );
}

function readTargetPromptFlags(runId: string): {
    hasDeliveredMessage: boolean;
    deliveredHasCpAddressee: boolean;
    deliveredHasAddresseeIdentity: boolean;
    hasPromptAdmitted: boolean;
    hasProviderBody: boolean;
    hasCpAddressee: boolean;
    hasAddresseeIdentity: boolean;
    toolCount: number;
    promptText: string;
} {
    // The provider-body column is audit-tier dependent (full = bytes, metadata/off = NULL),
    // and `context_events{prompt.admitted}` carries the Agent's admitted header rather than the
    // full delivered text on this lane. The durable row that CP actually delivered to the run is
    // `messages{role='USER'}` (it is written from the same `content` the wake path hands over).
    // The Agent addressee frame is a deterministic function of a non-empty parentRunId
    // (chat.py:model_input_content), covered by
    // packages/agent/tests/unit/test_wakee_addressee_frame.py.
    const messageRaw = psql(
        `SELECT count(*)::text, ` +
            `coalesce(bool_or(content LIKE ` +
            `'%addressed to you by another participant%'), false)::text, ` +
            `coalesce(bool_or(content LIKE '%You are %'), false)::text, ` +
            `coalesce(string_agg(replace(content, E'\\n', ' | '), E'\\n'), '') ` +
            `FROM messages ` +
            `WHERE run_id = ${sqlLiteral(runId)}::uuid ` +
            `AND role = 'USER' AND visibility = 'internal';`,
    );
    const [messageCount, deliveredCp, deliveredIdentity, promptText] = rows(messageRaw)[0] ?? [];

    // Diagnostic only: the Agent's admitted header is not the delivered message on this lane.
    const admittedRaw = psql(
        `SELECT count(*)::text FROM context_events ` +
            `WHERE correlation_id = ${sqlLiteral(runId)} ` +
            `AND event_type = 'prompt.admitted';`,
    );
    const [admittedCount] = rows(admittedRaw)[0] ?? [];

    // Strict source: the provider request body is what the model actually saw. The row may exist
    // while its body is withheld by the audit tier (metadata/off) — that is the observability gap
    // this assertion exposes, not a reason to lower the criterion.
    const bodyRaw = psql(
        `SELECT coalesce((request_body IS NOT NULL)::text, 'false'), ` +
            `coalesce(convert_from(request_body, 'UTF8') LIKE ` +
            `'%addressed to you by another participant%', false)::text, ` +
            `coalesce(convert_from(request_body, 'UTF8') LIKE ` +
            `'%本轮你是被点名的一方%', false)::text, ` +
            `coalesce(tool_count::text, '0') ` +
            `FROM chat_run_provider_requests WHERE run_id = ${sqlLiteral(runId)}::uuid ` +
            `ORDER BY provider_step LIMIT 1;`,
    );
    const [hasBody, cpAddressee, agentAddressee, toolCount] = rows(bodyRaw)[0] ?? [];
    return {
        hasDeliveredMessage: Number(messageCount ?? "0") > 0,
        deliveredHasCpAddressee: deliveredCp === "t",
        deliveredHasAddresseeIdentity: deliveredIdentity === "t",
        hasPromptAdmitted: Number(admittedCount ?? "0") > 0,
        hasProviderBody: hasBody === "t",
        hasCpAddressee: cpAddressee === "t",
        hasAddresseeIdentity: agentAddressee === "t",
        toolCount: Number(toolCount ?? "0"),
        promptText: (promptText ?? "").slice(0, 1_200),
    };
}

function persistObservation(payload: Record<string, unknown>): void {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(
        path.join(EVIDENCE_DIR, "observed.json"),
        JSON.stringify({ ...payload, observedAt: new Date().toISOString() }, null, 2),
        "utf8",
    );
}

test.describe.configure({ mode: "serial", retries: 0 });

test.describe("@host task-735 K1 batch2 agent-initiated TO", () => {
    test.skip(!REAL, "requires the real provider lane (XIHE_E2E_REAL_KEY)");
    // Declared SSOT budget (E2E_LONG_TIMEOUT_MS, default 30 s) × 4: same shape as the existing
    // real A→B TO spec; round 2 measured 28.5 s for the root turn alone, so this leaves headroom
    // for the delegated run without inventing an uncapped literal.
    test.setTimeout(LONG_TIMEOUT_MS * 4);

    test("model calls dispatch_agent_task and the target agent answers", async ({
        request,
        page,
    }) => {
        const ctx: JourneyContext = await registerJourneyUser(request, "k1-batch2");
        const auth: Auth = {
            accessToken: ctx.authToken,
            workspaceId: ctx.workspaceId,
            headers: { ...ctx.headers, "X-Workspace-Id": ctx.workspaceId },
        };
        const connection = await ensureRealConnection(request, auth);
        const leadPrincipal = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: auth.accessToken, workspaceId: auth.workspaceId },
            {
                name: agentName("K1Lead", RUN_NONCE),
                actions: ["write"],
                systemPrompt:
                    "You are the lead agent for an explicit delegation exercise. " +
                    "You must use list_session_participants before naming anyone, then call " +
                    "dispatch_agent_task exactly once to assign the micro-task to the other AGENT. " +
                    "Never assign the task to yourself and never do the micro-task yourself.",
            },
        );
        const peerPrincipal = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: auth.accessToken, workspaceId: auth.workspaceId },
            {
                name: agentName("K1Peer", RUN_NONCE),
                actions: [],
                systemPrompt:
                    "When you receive an instruction, perform it directly. Return only the exact " +
                    "text requested. Do not delegate and do not add commentary.",
            },
        );
        await optTargetIntoDerivedRun(request, auth, peerPrincipal);
        const sessionId = await createSessionWithPrincipal(
            request,
            { accessToken: auth.accessToken, workspaceId: auth.workspaceId },
            {
                principalId: leadPrincipal,
                title: `K1 batch2 ${RUN_NONCE}`,
                workspaceId: auth.workspaceId,
            },
        );
        await bindSessionToReal(request, auth, sessionId, connection);
        await addAgentParticipant(request, auth.headers, sessionId, peerPrincipal);
        const branchId = await getRootBranchId(request, sessionId, auth.headers);
        await waitForControlPlaneAgentReady(request, auth.headers);
        const closeSse = await openSessionSse(sessionId, auth.accessToken, {
            "X-Workspace-Id": auth.workspaceId,
        });

        const observed: Record<string, unknown> = {
            task: "task-735",
            expectedTargetText: EXPECTED_TARGET_TEXT,
            sessionId,
            branchId,
            leadPrincipal,
            peerPrincipal,
            provider: { provider: connection.provider, model: connection.model },
            evidenceDir: EVIDENCE_DIR,
        };
        try {
            const rootRunId = await sendRootRun(request, auth.headers, sessionId, branchId);
            observed.rootRunId = rootRunId;
            const rootText = readAssistantText(rootRunId);
            observed.rootAssistantText = rootText.slice(0, 1_200);

            const toolCalls = readToolCalls(rootRunId, sessionId);
            observed.toolCalls = toolCalls;
            const dispatchCalls = toolCalls.filter(
                (call) => call.toolName === "dispatch_agent_task",
            );
            if (dispatchCalls.length === 0) {
                observed.toolEventPayloads = readToolEventPayloads(sessionId, 20);
                persistObservation(observed);
                throw new Error(
                    `model did not call dispatch_agent_task; tool calls=${JSON.stringify(toolCalls)} ` +
                        `rootAssistantText=${JSON.stringify(rootText.slice(0, 1_200))}`,
                );
            }
            expect(dispatchCalls).toHaveLength(1);
            expect(dispatchCalls[0].toolCallId).not.toBe("");
            expect(dispatchCalls[0].targetDisplayName).not.toBe("");
            expect(dispatchCalls[0].instruction).toContain(EXPECTED_TARGET_TEXT);

            const targetRunId = await readTargetRunId(rootRunId, sessionId);
            observed.targetRunId = targetRunId;
            await awaitOperationCompletedForRun(request, auth.headers, targetRunId);
            const targetRun = readRun(targetRunId);
            const targetText = readAssistantText(targetRunId);
            const targetPrompt = readTargetPromptFlags(targetRunId);
            const wakeRows = readAllWakeRows(rootRunId, sessionId);
            const toOrigins = readToOrigins(sessionId);
            observed.targetRun = targetRun;
            observed.targetAssistantText = targetText.slice(0, 1_200);
            observed.targetPrompt = targetPrompt;
            observed.wakeRows = wakeRows;
            observed.toOrigins = toOrigins;

            expect(dispatchCalls[0].toolCallId, "real durable tool_call id").toBeTruthy();
            expect(targetRun.status, "target derived run status").toBe("succeeded");
            expect(targetText.length, "target assistantChars").toBeGreaterThan(0);
            expect(targetText, "target exact answer").toContain(EXPECTED_TARGET_TEXT);
            expect(targetRun.parentRunId, "target run parent").toBe(rootRunId);
            expect(targetRun.origin, "target run origin").not.toBe("user_submission");
            expect(wakeRows.length, "agent-origin TO rows").toBe(1);
            expect(wakeRows[0].runId).toBe(targetRunId);
            expect(wakeRows[0].parentRunId).toBe(rootRunId);
            expect(wakeRows[0].triggerSource).toBe("to");
            expect(wakeRows[0].origin).not.toBe("user_submission");
            expect(toOrigins.length, "all TO rows in this session").toBeGreaterThan(0);
            expect(
                toOrigins.filter((row) => row.origin === "user_submission"),
                "human-submitted TO rows",
            ).toHaveLength(0);
            expect(
                targetPrompt.hasDeliveredMessage,
                "durable USER message delivered to the target run",
            ).toBe(true);
            expect(targetPrompt.hasProviderBody, "target provider request body captured").toBe(
                true,
            );
            expect(targetPrompt.hasCpAddressee, "CP addressee provenance in target prompt").toBe(
                true,
            );
            expect(
                targetPrompt.hasAddresseeIdentity,
                "Agent addressee frame in the provider request body",
            ).toBe(true);

            await captureUi(page, ctx, sessionId);
            observed.criteria = {
                durableDispatchToolCall:
                    dispatchCalls.length === 1 && dispatchCalls[0].toolCallId !== "",
                targetRunSucceededWithText:
                    targetRun.status === "succeeded" && targetText.length > 0,
                noHumanToRow:
                    wakeRows.length === 1 &&
                    wakeRows[0].origin !== "user_submission" &&
                    toOrigins.every((row) => row.origin !== "user_submission"),
                assigneePromptVisible:
                    targetPrompt.hasProviderBody &&
                    targetPrompt.hasCpAddressee &&
                    targetPrompt.hasAddresseeIdentity,
            };
            persistObservation(observed);
        } catch (error) {
            observed.error = error instanceof Error ? error.message : String(error);
            persistObservation(observed);
            throw error;
        } finally {
            closeSse();
        }
    });
});

async function captureUi(page: Page, ctx: JourneyContext, sessionId: string): Promise<void> {
    try {
        await seedPage(page, ctx);
        await page.goto(workspaceSessionPath(ctx.workspaceId, sessionId));
        await expect
            .poll(() => page.locator('[data-testid="run-header"]').count(), {
                timeout: LONG_TIMEOUT_MS,
                intervals: [500, 1_000, 2_000],
            })
            .toBeGreaterThanOrEqual(2);
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "k1-batch2-session.png"),
            fullPage: true,
        });
    } catch (error) {
        console.warn(
            `[task-735] UI screenshot skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}
