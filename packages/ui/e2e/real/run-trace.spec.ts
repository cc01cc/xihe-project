import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page, type Response } from "@playwright/test";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { actionableErrors } from "./helpers/console";
import {
    CP_URL,
    awaitOperationCompletedForRun,
    ensureAgentWorkspaceBinding,
    ensureChatReady,
    evidenceDir,
    registerJourneyUser,
    seedPage,
    waitForControlPlaneAgentReady,
    type JourneyContext,
} from "./helpers/journey";
import type { RunTraceEvent, RunTraceResponse } from "../../src/types";

const REAL_ROUTE = process.env.XIHE_E2E_REAL_ROUTE ?? "native";
const REAL_MODEL =
    process.env.XIHE_E2E_REAL_MODEL ?? process.env.XIHE_E2E_REAL_OPENAI_MODEL ?? "mimo-v2.6-flash";
const REAL_PROVIDER = REAL_ROUTE === "openai-compat" ? "openai" : "xiaomi";
const REAL_API_TYPE = REAL_ROUTE === "openai-compat" ? "openai-chat-completions" : "mimo-responses";
const REAL_BASE =
    process.env.XIHE_E2E_REAL_BASE ??
    (REAL_ROUTE === "openai-compat" ? process.env.XIHE_E2E_REAL_OPENAI_BASE : undefined) ??
    "https://api.xiaomimimo.com/v1";
const EVIDENCE_DIR = evidenceDir("plan-0509-run-trace");
const PANEL = '[data-testid="session-monitor-panel"]';

const RESPONSE_KEYS = [
    "asOf",
    "completeness",
    "events",
    "nextCursor",
    "provenance",
    "runId",
    "sources",
];
const PROVENANCE_KEYS = [
    "apiTypeId",
    "apiTypeVersion",
    "connectionRevision",
    "contextTemplateId",
    "contextTemplateLayer",
    "contextTemplateVersion",
    "providerConnectionId",
    "status",
];
const EVENT_KEYS = [
    "durationMs",
    "errorCode",
    "eventId",
    "kind",
    "modelId",
    "occurredAt",
    "providerId",
    "references",
    "source",
    "status",
    "toolName",
    "usage",
];
const REFERENCE_KEYS = new Set([
    "attemptId",
    "contextEventId",
    "mcpInvocationId",
    "runtimeJobId",
    "toolCallId",
]);
const TRACE_SOURCE_ALLOWLIST = [
    "chat_run",
    "context_event",
    "provider_attempt",
    "mcp_invocation",
    "runtime_job",
] as const;
const EVENT_STATUS_ALLOWLIST: Record<string, string[]> = {
    "run.lifecycle": [
        "created",
        "queued",
        "running",
        "awaiting_approval",
        "completed",
        "failed",
        "cancelled",
        "unknown",
    ],
    "input.admitted": ["admitted"],
    "context.source": ["resolved", "missing", "rejected", "stale", "unknown"],
    "agent.tool": ["started", "succeeded", "failed", "unknown"],
    "provider.attempt": ["started", "succeeded", "failed", "unknown"],
    "mcp.invocation": ["started", "succeeded", "failed", "pending", "ambiguous", "unknown"],
    "runtime.job": ["queued", "running", "completed", "failed", "cancelled", "unknown"],
    "usage.recorded": ["recorded", "estimated", "unknown"],
};
const EVENT_SOURCE_ALLOWLIST: Record<string, string> = {
    "run.lifecycle": "chat_run",
    "input.admitted": "context_event",
    "context.source": "context_event",
    "agent.tool": "context_event",
    "provider.attempt": "provider_attempt",
    "mcp.invocation": "mcp_invocation",
    "runtime.job": "runtime_job",
    "usage.recorded": "context_event",
};

interface RunTraceProvenance {
    status: "complete" | "partial" | "unknown";
    providerConnectionId: string | null;
    connectionRevision: number | null;
    apiTypeId: string | null;
    apiTypeVersion: number | null;
    contextTemplateLayer: "instance" | "user" | "workspace" | null;
    contextTemplateId: string | null;
    contextTemplateVersion: number | null;
}

type TraceEvent = Omit<RunTraceEvent, "kind" | "status"> & {
    kind: RunTraceEvent["kind"] | "input.admitted";
    status: RunTraceEvent["status"] | "admitted";
};

type TraceResponse = Omit<RunTraceResponse, "events"> & {
    provenance: RunTraceProvenance;
    events: TraceEvent[];
};

interface SessionModelView {
    modelProvider?: string;
    modelName?: string;
}

function traceRunIdFromResponse(response: Response): string | null {
    try {
        const url = new URL(response.url());
        if (response.request().method() !== "GET") return null;
        return url.pathname.match(/^\/api\/v1\/chat\/runs\/([^/]+)\/trace$/)?.[1] ?? null;
    } catch {
        return null;
    }
}

function isUuid(value: unknown): value is string {
    return (
        typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    );
}

function isSafeIdentifier(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 128 &&
        /^[A-Za-z0-9_.:-]+$/.test(value)
    );
}

function isSafeCount(value: unknown): value is number | null {
    return (
        value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    );
}

function assertSafeTrace(
    body: TraceResponse,
    runId: string,
    promptMarker: string,
    promptBody: string,
): void {
    expect(body.runId === runId, "trace belongs to the submitted Run").toBe(true);
    expect(Object.keys(body).sort()).toEqual([...RESPONSE_KEYS].sort());
    expect(body.events.length).toBeGreaterThan(0);
    expect(["complete", "partial", "unknown"].includes(body.completeness)).toBe(true);

    const provenance = body.provenance;
    expect(Object.keys(provenance).sort()).toEqual([...PROVENANCE_KEYS].sort());
    expect(["complete", "partial", "unknown"].includes(provenance.status)).toBe(true);
    expect(isUuid(provenance.providerConnectionId)).toBe(true);
    expect(
        typeof provenance.connectionRevision === "number" &&
            Number.isSafeInteger(provenance.connectionRevision) &&
            provenance.connectionRevision > 0,
    ).toBe(true);
    expect(provenance.apiTypeId === REAL_API_TYPE).toBe(true);
    expect(provenance.apiTypeVersion === 1).toBe(true);
    expect(
        provenance.contextTemplateLayer === null ||
            ["instance", "user", "workspace"].includes(provenance.contextTemplateLayer),
    ).toBe(true);
    expect(provenance.contextTemplateId === null || isUuid(provenance.contextTemplateId)).toBe(
        true,
    );
    expect(
        provenance.contextTemplateVersion === null ||
            (Number.isSafeInteger(provenance.contextTemplateVersion) &&
                provenance.contextTemplateVersion > 0),
    ).toBe(true);
    const provenanceValues = [
        provenance.providerConnectionId,
        provenance.connectionRevision,
        provenance.apiTypeId,
        provenance.apiTypeVersion,
        provenance.contextTemplateLayer,
        provenance.contextTemplateId,
        provenance.contextTemplateVersion,
    ];
    const presentProvenanceFields = provenanceValues.filter((value) => value !== null).length;
    const expectedProvenanceStatus =
        presentProvenanceFields === 0
            ? "unknown"
            : presentProvenanceFields === 7
              ? "complete"
              : "partial";
    expect(provenance.status === expectedProvenanceStatus).toBe(true);

    for (const source of body.sources) {
        expect(Object.keys(source).sort()).toEqual(["source", "status"]);
        expect(TRACE_SOURCE_ALLOWLIST.includes(source.source)).toBe(true);
        expect(
            ["complete", "unavailable", "not_applicable", "unknown"].includes(source.status),
        ).toBe(true);
    }
    for (const event of body.events) {
        expect(Object.keys(event).sort()).toEqual([...EVENT_KEYS].sort());
        expect(Object.hasOwn(EVENT_STATUS_ALLOWLIST, event.kind)).toBe(true);
        expect(
            event.status === null || EVENT_STATUS_ALLOWLIST[event.kind]?.includes(event.status),
        ).toBe(true);
        const hasExpectedSource = EVENT_SOURCE_ALLOWLIST[event.kind] === event.source;
        const isUnknownMapping =
            event.kind === "run.lifecycle" &&
            event.status === "unknown" &&
            TRACE_SOURCE_ALLOWLIST.includes(event.source);
        expect(hasExpectedSource || isUnknownMapping).toBe(true);
        expect(Object.keys(event.references).every((key) => REFERENCE_KEYS.has(key))).toBe(true);
        expect(Object.values(event.references).every(isSafeIdentifier)).toBe(true);
        expect(event.toolName === null || isSafeIdentifier(event.toolName)).toBe(true);
        expect(event.providerId === null || isSafeIdentifier(event.providerId)).toBe(true);
        expect(event.modelId === null || isSafeIdentifier(event.modelId)).toBe(true);
        expect(event.errorCode === null || /^[A-Z][A-Z0-9_]{2,63}$/.test(event.errorCode)).toBe(
            true,
        );
        expect(
            event.durationMs === null ||
                (Number.isSafeInteger(event.durationMs) && event.durationMs >= 0),
        ).toBe(true);
        if (event.usage !== null) {
            expect(Object.keys(event.usage).sort()).toEqual([
                "inputTokens",
                "outputTokens",
                "totalTokens",
            ]);
            expect(isSafeCount(event.usage.inputTokens)).toBe(true);
            expect(isSafeCount(event.usage.outputTokens)).toBe(true);
            expect(isSafeCount(event.usage.totalTokens)).toBe(true);
        }
    }

    const admittedEvents = body.events.filter((event) => event.kind === "input.admitted");
    expect(admittedEvents).toHaveLength(1);
    const admitted = admittedEvents[0]!;
    expect(admitted.source === "context_event").toBe(true);
    expect(admitted.status === "admitted").toBe(true);
    expect(admitted.eventId.startsWith("context_event:")).toBe(true);
    expect(Object.keys(admitted.references).every((key) => key === "contextEventId")).toBe(true);
    const contextEventId = admitted.references.contextEventId;
    expect(
        isSafeIdentifier(contextEventId) &&
            contextEventId === admitted.eventId.slice("context_event:".length),
    ).toBe(true);

    const serializedEvents = JSON.stringify(body.events);
    expect(
        !serializedEvents.includes(promptMarker) && !serializedEvents.includes(promptBody),
        "the admitted input marker and prompt body stay out of every Trace event",
    ).toBe(true);
}

test.describe("@host PLAN-0509 Run trace browser acceptance", () => {
    test.describe.configure({ mode: "serial", retries: 0 });
    test.setTimeout(300000);

    test.skip(
        (process.env.XIHE_E2E_LLM_MODE ?? "mock") !== "real",
        "requires the real-provider host lane (node scripts/xihe.mjs test real)",
    );
    test.skip(
        !process.env.XIHE_E2E_REAL_XIAOMI_KEY,
        "requires XIHE_E2E_REAL_XIAOMI_KEY; the value is never read or logged by this spec",
    );
    let ctx: JourneyContext;
    let sessionId = "";
    let runId = "";
    let pageErrors: string[] = [];
    const traceResponses = new Map<string, Response[]>();
    const screenshots: Array<{ name: string; bytes: number; viewport: string }> = [];

    test.beforeAll(async ({ request }) => {
        if (REAL_ROUTE !== "native" && REAL_ROUTE !== "openai-compat") {
            throw new Error(`unsupported XIHE_E2E_REAL_ROUTE: ${REAL_ROUTE}`);
        }
        ctx = await registerJourneyUser(request, "plan-0509-run-trace");
        const agentAuth = { accessToken: ctx.authToken, workspaceId: ctx.workspaceId };
        const principalId = await provisionWorkspaceAgentPrincipal(request, agentAuth, {
            name: "Run Trace Agent",
            systemPrompt: "Answer briefly in Chinese. Do not call tools unless asked.",
        });
        sessionId = await createSessionWithPrincipal(request, agentAuth, {
            principalId,
            title: "Run trace browser acceptance",
        });
        await bindRealProvider(request, sessionId, ctx);
        await ensureAgentWorkspaceBinding(ctx.workspaceId);
        await waitForControlPlaneAgentReady(request, {
            ...ctx.headers,
            "X-Workspace-Id": ctx.workspaceId,
        });
        await waitForAgentCircuitRecovered(request, {
            ...ctx.headers,
            "X-Workspace-Id": ctx.workspaceId,
        });
    });

    test.beforeEach(async ({ page }) => {
        pageErrors = [];
        page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message}`));
        page.on("console", (message) => {
            if (message.type() !== "error") return;
            const url = message.location()?.url ?? "";
            pageErrors.push(`console: ${message.text()} (${url})`);
        });
        page.on("response", (response) => {
            const responseRunId = traceRunIdFromResponse(response);
            if (responseRunId === null) return;
            const matches = traceResponses.get(responseRunId) ?? [];
            matches.push(response);
            traceResponses.set(responseRunId, matches);
        });
    });

    test.afterEach(async () => {
        const actionable = actionableErrors(pageErrors).filter(
            (entry) => !/fonts\.(googleapis|gstatic)\.com/.test(entry),
        );
        expect(actionable, pageErrors.join("\n")).toEqual([]);
    });

    test.afterAll(() => {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        writeFileSync(
            path.join(EVIDENCE_DIR, "manifest.json"),
            JSON.stringify(
                {
                    plan: "PLAN-0509",
                    runId: process.env.XIHE_E2E_RUN_ID ?? null,
                    sessionId,
                    traceRunId: runId || null,
                    capturedAt: new Date().toISOString(),
                    screenshots,
                },
                null,
                2,
            ),
        );
    });

    async function capture(page: Page, name: string): Promise<void> {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const file = path.join(EVIDENCE_DIR, name);
        await page.screenshot({ scale: "css", path: file, animations: "disabled", fullPage: false });
        const viewport = page.viewportSize();
        screenshots.push({
            name,
            bytes: statSync(file).size,
            viewport: `${viewport?.width ?? 0}x${viewport?.height ?? 0}`,
        });
    }

    async function sessionModel(request: APIRequestContext): Promise<string> {
        const response = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}`, {
            headers: { ...ctx.headers, "X-Workspace-Id": ctx.workspaceId },
        });
        if (!response.ok()) return "";
        const body = (await response.json()) as SessionModelView;
        return `${body.modelProvider ?? ""}/${body.modelName ?? ""}`;
    }

    async function bindRealProvider(
        request: APIRequestContext,
        targetSessionId: string,
        journey: JourneyContext,
    ): Promise<void> {
        const headers = { ...journey.headers, "X-Workspace-Id": journey.workspaceId };
        const listed = await request.get(`${CP_URL}/api/v1/provider-connections`, { headers });
        expect(
            listed.ok(),
            `provider connection list returned HTTP ${listed.status()} (${await safeProblemCode(listed)})`,
        ).toBe(true);
        const current = (await listed.json()) as {
            connections?: Array<{
                id: string;
                providerId: string;
                apiTypeId: string;
                apiTypeVersion: number;
                revision: number;
                baseUrl?: string | null;
                manualModels?: string[];
                scope?: string;
                operation?: string;
                enabled?: boolean;
                status?: string;
            }>;
        };
        let ready = current.connections?.find(
            (item) =>
                item.providerId === REAL_PROVIDER &&
                item.apiTypeId === REAL_API_TYPE &&
                item.apiTypeVersion === 1 &&
                item.baseUrl === REAL_BASE &&
                item.manualModels?.includes(REAL_MODEL) &&
                item.scope === "USER" &&
                item.operation === "chat" &&
                item.enabled === true &&
                item.status === "READY",
        );

        if (!ready) {
            const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
                headers,
                data: {
                    providerId: REAL_PROVIDER,
                    apiTypeId: REAL_API_TYPE,
                    apiTypeVersion: 1,
                    apiKey: process.env.XIHE_E2E_REAL_XIAOMI_KEY,
                    connectionKey: `e2e-run-trace-${Date.now().toString(36)}`,
                    label: "PLAN-0509 real Run trace",
                    scope: "USER",
                    modelDiscovery: "manual",
                    manualModels: [REAL_MODEL],
                    baseUrl: REAL_BASE,
                },
            });
            expect(
                created.ok(),
                `real provider connection create returned HTTP ${created.status()} (${await safeProblemCode(created)})`,
            ).toBe(true);
            const connection = (await created.json()) as { id?: string };
            expect(connection.id).toBeTruthy();

            const verified = await request.post(
                `${CP_URL}/api/v1/provider-connections/${connection.id}/verify`,
                { headers },
            );
            expect(
                verified.ok(),
                `real provider verification returned HTTP ${verified.status()} (${await safeProblemCode(verified)})`,
            ).toBe(true);
            const verification = (await verified.json()) as {
                connection?: typeof ready;
            };
            ready = verification.connection;
        }

        if (!ready?.id || typeof ready.revision !== "number" || ready.revision < 1) {
            throw new Error("verified real provider connection metadata is unavailable");
        }
        if (ready.status !== "READY") {
            throw new Error("real provider connection verification did not produce READY status");
        }

        const bound = await request.patch(`${CP_URL}/api/v1/sessions/${targetSessionId}`, {
            headers,
            data: {
                modelProvider: REAL_PROVIDER,
                modelName: REAL_MODEL,
                providerConnectionId: ready.id,
                connectionRevision: ready.revision,
            },
        });
        expect(
            bound.ok(),
            `real model binding returned HTTP ${bound.status()} (${await safeProblemCode(bound)})`,
        ).toBe(true);
    }

    async function safeProblemCode(
        response: Awaited<ReturnType<APIRequestContext["get"]>>,
    ): Promise<string> {
        try {
            const body = (await response.json()) as { code?: unknown };
            return typeof body.code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(body.code)
                ? body.code
                : "unavailable";
        } catch {
            return "unavailable";
        }
    }

    async function latestTraceResponse(): Promise<Response> {
        await expect
            .poll(
                () =>
                    (traceResponses.get(runId) ?? []).some((response) => response.status() === 200),
                { timeout: 30000, message: "the browser must load this Run's trace API response" },
            )
            .toBe(true);
        return (traceResponses.get(runId) ?? [])
            .filter((response) => response.status() === 200)
            .at(-1)!;
    }

    async function waitForAgentCircuitRecovered(
        request: APIRequestContext,
        headers: Record<string, string>,
    ): Promise<void> {
        let lastObserved = "unobserved";
        await expect
            .poll(
                async () => {
                    try {
                        const response = await request.get(`${CP_URL}/api/v1/status`, { headers });
                        if (!response.ok()) {
                            lastObserved = `status HTTP ${response.status()}`;
                            return lastObserved;
                        }
                        const body = (await response.json()) as {
                            services?: Array<{ key: string; circuitBreaker?: string }>;
                        };
                        const agent = body.services?.find((service) => service.key === "agent");
                        if (!agent) {
                            lastObserved = "Agent entry missing";
                            return lastObserved;
                        }
                        // Rebinding restarts the Agent and can open CP's 30s circuit; a Chat
                        // sent inside the cooldown is rejected, so wait until it clears.
                        lastObserved = `circuit=${agent.circuitBreaker ?? "missing"}`;
                        return agent.circuitBreaker !== "OPEN" ? "recovered" : lastObserved;
                    } catch (cause) {
                        lastObserved = cause instanceof Error ? cause.message : String(cause);
                        return "unavailable";
                    }
                },
                {
                    timeout: 90_000,
                    intervals: [1000, 2000],
                    message: `CP Agent circuit did not clear before the browser Chat; last observation: ${lastObserved}`,
                },
            )
            .toBe("recovered");
    }

    test("desktop: a real UI Run loads a safe trace and rebuilds it after refresh", async ({
        page,
        request,
    }) => {
        const headers = { ...ctx.headers, "X-Workspace-Id": ctx.workspaceId };
        seedPage(page, { ...ctx, headers });
        await page.goto(`/workspace/${ctx.workspaceId}/chat/${sessionId}`, { waitUntil: "load" });
        await ensureChatReady(page);

        // The route-matched real connection was reused or verified from the
        // host-injected key in beforeAll. Select that concrete catalog model in
        // the UI; do not call sendChat(), whose helper creates a fake connection.
        const modelTrigger = page.getByTestId("model-popover-trigger");
        await expect(modelTrigger).toBeVisible();
        await modelTrigger.click();
        const modelSearch = page.getByTestId("model-popover-search");
        await modelSearch.fill(REAL_MODEL);
        await expect(page.getByTestId(`model-item-${REAL_PROVIDER}/${REAL_MODEL}`)).toBeVisible({
            timeout: 15000,
        });
        await modelSearch.press("Enter");
        await expect
            .poll(() => sessionModel(request), { timeout: 15000 })
            .toBe(`${REAL_PROVIDER}/${REAL_MODEL}`);

        const panel = page.locator(PANEL);
        await expect(panel, "Monitor is visible beside the chat").toBeVisible({ timeout: 20000 });
        const promptMarker = `RUN-TRACE-PRIVACY-${Date.now().toString(36)}`;
        const prompt = `请简短回答“运行记录已创建”。验收标记 ${promptMarker}`;
        const chatPostPromise = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
                response.request().method() === "POST" &&
                url.pathname === "/api/v1/chat" &&
                response.status() === 202
            );
        });
        await page.getByTestId("chat-input").fill(prompt);
        await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 15000 });
        await page.getByTestId("chat-send-button").click();
        const chatPost = await chatPostPromise;
        const chatBody = (await chatPost.json()) as { runId?: string };
        runId = chatBody.runId ?? "";
        expect(runId, "the UI submission returns a durable Run id").not.toBe("");
        await awaitOperationCompletedForRun(request, headers, runId);

        const runResponse = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, { headers });
        expect(runResponse.ok(), `run ${runResponse.status()}: ${await runResponse.text()}`).toBe(
            true,
        );
        const run = (await runResponse.json()) as { status?: string };
        expect(run.status, "the real provider completed this no-tool Run").toBe("succeeded");

        const runSelect = page.getByTestId("monitor-trace-run-select");
        await expect(runSelect.locator(`option[value="${runId}"]`)).toBeAttached({
            timeout: 30000,
        });
        await runSelect.selectOption(runId);
        await expect
            .poll(() => page.getByTestId("run-trace-event").count(), {
                timeout: 30000,
                message: "the selected completed Run must refresh its trace events",
            })
            .toBeGreaterThan(0);
        const firstTraceResponse = await latestTraceResponse();
        expect(firstTraceResponse.status()).toBe(200);
        const firstTrace = (await firstTraceResponse.json()) as TraceResponse;
        assertSafeTrace(firstTrace, runId, promptMarker, prompt);

        const timeline = page.getByTestId("run-trace-timeline");
        await expect(timeline).toBeVisible();
        await expect(page.getByTestId("run-trace-events")).toBeVisible({ timeout: 20000 });
        const firstEventIds = await page
            .getByTestId("run-trace-event")
            .evaluateAll((items) => items.map((item) => item.getAttribute("data-event-id")));
        expect(firstEventIds.length).toBeGreaterThan(0);
        await capture(page, "desktop-run-trace-after-action.png");

        const refreshedTracePromise = page.waitForResponse((response) => {
            return traceRunIdFromResponse(response) === runId && response.status() === 200;
        });
        await page.reload({ waitUntil: "load" });
        await expect(page.locator(PANEL), "Monitor remounts after refresh").toBeVisible({
            timeout: 20000,
        });
        await expect(page.getByTestId("monitor-trace-run-select")).toHaveValue(runId, {
            timeout: 30000,
        });
        const refreshedTraceResponse = await refreshedTracePromise;
        const refreshedTrace = (await refreshedTraceResponse.json()) as TraceResponse;
        assertSafeTrace(refreshedTrace, runId, promptMarker, prompt);
        await expect(page.getByTestId("run-trace-events")).toBeVisible({ timeout: 20000 });
        const refreshedEventIds = await page
            .getByTestId("run-trace-event")
            .evaluateAll((items) => items.map((item) => item.getAttribute("data-event-id")));
        expect(new Set(refreshedEventIds).size).toBe(refreshedEventIds.length);
        expect(refreshedEventIds).toEqual(expect.arrayContaining(firstEventIds));
        expect(refreshedEventIds).toContain(`chat_run:${runId}`);
        await capture(page, "desktop-run-trace-after-refresh.png");
    });
});
