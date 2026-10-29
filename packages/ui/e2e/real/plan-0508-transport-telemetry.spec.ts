import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { actionableErrors } from "./helpers/console";
import {
    CP_URL,
    assertAgentLlmReady,
    awaitLatestChatRunCompleted,
    awaitOperationCompletedForRun,
    ensureAgentWorkspaceBinding,
    ensureChatBinding,
    ensureChatReady,
    evidenceDir,
    registerJourneyUser,
    seedPage,
    sendChat,
    type JourneyContext,
} from "./helpers/journey";

const EVIDENCE_DIR = evidenceDir("plan-0508-transport-telemetry"),
    PANEL = '[data-testid="session-monitor-panel"]',
    SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

interface TransportAttemptView {
    attemptId: string;
    seq: number;
    status: "running" | "terminal";
    outcome: string | null;
    provider: string | null;
    model: string | null;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    errorCode: string | number | null;
    firstChunkMs: number | null;
    chunkCount: number | null;
    uploadBytes: number | null;
    downloadBytes: number | null;
    lastProgressStage: string | null;
    lastProgressElapsedMs: number | null;
}

interface AttemptsBody {
    runId: string;
    attempts: TransportAttemptView[];
    aggregate: { attemptCount: number; failedCount: number; partialCount: number };
}

// PLAN-0508 T5.1/T5.2: provider-wire transport telemetry — the Agent dispatches
// real HTTP to the fake LLM (llm-mode=success), the CP persists each attempt row
// before relaying, and the Monitor renders the running → terminal → refresh
// states. Deterministic categories come from the fake-LLM markers
// XIHE-E2E-SLOW / XIHE-E2E-DROP.
//   node scripts/e2e-host.mjs --batch=transport --retries=0
test.describe("@host PLAN-0508 transport telemetry relay and diagnostics", () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(300000);

    let ctx: JourneyContext,
        sessionId = "",
        pageErrors: string[] = [];
    let failureCode: string | null = null;
    // The generic "latest run completed" poll can match the previous terminal
    // run before the new one exists; tests capture the exact run id instead.
    let previousRunId = "";
    const shots: Array<{ name: string; bytes: number; viewport: string }> = [];

    test.beforeAll(async ({ request }) => {
        // PLAN-0525 / BL-143: `ensureAgentWorkspaceBinding` now uses a 30s
        // readiness budget (fast-fail on terminal `llmReady` states, 500ms poll)
        // instead of 180s. Keep this hook's budget above it (90s) so the helper's
        // descriptive error is still not masked by an opaque beforeAll timeout.
        test.setTimeout(90000);
        ctx = await registerJourneyUser(request, "plan-0508-transport");
        // AgentAuth uses `accessToken` while JourneyContext exposes `authToken`.
        const agentAuth = { accessToken: ctx.authToken, workspaceId: ctx.workspaceId };
        const principalId = await provisionWorkspaceAgentPrincipal(request, agentAuth, {
            name: "Transport Agent",
        });
        sessionId = await createSessionWithPrincipal(request, agentAuth, {
            principalId,
            title: "Transport telemetry session",
        });
        await ensureAgentWorkspaceBinding(ctx.workspaceId);
    });

    test.beforeEach(async ({ page }) => {
        pageErrors = [];
        page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message}`));
        page.on("console", (message) => {
            if (message.type() !== "error") return;
            const url = message.location()?.url ?? "";
            pageErrors.push(`console: ${message.text()} (${url})`);
        });
    });

    test.afterEach(async () => {
        // The Google Fonts CDN is unreachable from this network; a blocked font
        // stylesheet is external noise, not a product console error.
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
                    plan: "PLAN-0508",
                    runId: process.env.XIHE_E2E_RUN_ID ?? null,
                    sessionId,
                    capturedAt: new Date().toISOString(),
                    screenshots: shots,
                },
                null,
                2,
            ),
        );
    });

    function requireWireMode(): void {
        test.skip(
            (process.env.XIHE_E2E_LLM_MODE ?? "mock") !== "success",
            "requires XIHE_E2E_LLM_MODE=success (provider wire); current: " +
                (process.env.XIHE_E2E_LLM_MODE ?? "mock"),
        );
    }

    async function attemptsApi(request: APIRequestContext, runId: string): Promise<AttemptsBody> {
        const response = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}/attempts`, {
            headers: ctx.headers,
        });
        expect(
            response.ok(),
            `attempts ${response.status()}: ${await response.text()}`,
        ).toBeTruthy();
        return (await response.json()) as AttemptsBody;
    }

    async function latestRunId(request: APIRequestContext): Promise<string> {
        const response = await request.get(
            `${CP_URL}/api/v1/chat/sessions/${sessionId}/runs?size=1`,
            { headers: ctx.headers },
        );
        expect(response.ok(), `runs ${response.status()}`).toBeTruthy();
        const body = (await response.json()) as { runs?: Array<{ runId: string }> };
        const runId = body.runs?.[0]?.runId;
        expect(runId, "session has a newest run").toBeTruthy();
        return runId!;
    }

    async function capture(page: Page, name: string): Promise<void> {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const file = path.join(EVIDENCE_DIR, name);
        await page.screenshot({ path: file, animations: "disabled" });
        const viewport = page.viewportSize();
        shots.push({
            name,
            bytes: statSync(file).size,
            viewport: `${viewport?.width ?? 0}x${viewport?.height ?? 0}`,
        });
    }

    test("desktop: a normal run lands one durable success attempt with safe fields", async ({
        page,
        request,
    }) => {
        requireWireMode();
        seedPage(page, ctx);
        await page.goto("/workspace/" + ctx.workspaceId, { waitUntil: "load" });
        await ensureChatReady(page);
        await ensureChatBinding(page, sessionId);
        // PLAN-0525: check readiness per layer before the wire send — Agent direct
        // health here, Session Provider connection inside ensureChatBinding.
        await assertAgentLlmReady();

        const panel = page.locator(PANEL);
        await expect(panel, "monitor panel visible").toBeVisible({ timeout: 20000 });

        await sendChat(page, "transport normal probe");
        await awaitLatestChatRunCompleted(request, ctx.headers, ctx.workspaceId);
        const runId = await latestRunId(request);

        const body = await attemptsApi(request, runId);
        expect(body.runId).toBe(runId);
        expect(body.attempts.length).toBeGreaterThanOrEqual(1);
        const attempt = body.attempts.at(-1)!;
        expect(attempt.status, "attempt is terminal").toBe("terminal");
        expect(attempt.outcome, "provider-wire attempt succeeded").toBe("success");
        expect(attempt.seq).toBeGreaterThanOrEqual(1);
        expect(
            attempt.durationMs,
            "terminal duration comes from the Agent monotonic clock",
        ).toBeGreaterThan(0);
        expect(attempt.firstChunkMs).toBeGreaterThanOrEqual(0);
        expect(attempt.chunkCount).toBeGreaterThan(0);
        expect(attempt.errorCode).toBeNull();
        expect(attempt.uploadBytes, "wire bytes stay unknown in v1").toBeNull();
        expect(attempt.downloadBytes).toBeNull();
        expect(attempt.lastProgressStage, "bounded sample survives the terminal transition").toBe(
            "attempt_finished",
        );
        expect(attempt.provider, "identity projects from the ChatRun snapshot").toBeTruthy();
        expect(attempt.model).toBeTruthy();
        // Durable projection never carries prompt text or credentials.
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain("transport normal probe");
        expect(serialized).not.toContain("sk-fake");

        expect(body.aggregate.attemptCount).toBe(body.attempts.length);
        expect(body.aggregate.failedCount).toBe(0);
        expect(body.aggregate.partialCount).toBe(0);

        // The session-level aggregate rides the monitor response independently of
        // the 20-run history window.
        const monitorRes = await request.get(
            `${CP_URL}/api/v1/chat/sessions/${sessionId}/monitor`,
            { headers: ctx.headers },
        );
        expect(monitorRes.ok(), `monitor ${monitorRes.status()}`).toBeTruthy();
        const monitor = (await monitorRes.json()) as {
            transport?: { attemptCount: number; failedCount: number; partialCount: number };
        };
        expect(monitor.transport?.attemptCount ?? 0).toBeGreaterThanOrEqual(1);

        await expect(
            panel.locator('[data-testid="monitor-transport-attempt"]').first(),
            "transport attempt row rendered from the durable read",
        ).toBeVisible({ timeout: 25000 });
        await expect(panel).toContainText("success");
        await expect(panel.locator('[data-testid="monitor-transport-metrics"]')).toContainText(
            "未知",
        );
        await capture(page, "desktop-transport-normal.png");
    });

    test("desktop: slow first response shows running progress, then terminal metrics", async ({
        page,
        request,
    }) => {
        requireWireMode();
        seedPage(page, ctx);
        await page.goto("/workspace/" + ctx.workspaceId, { waitUntil: "load" });
        await ensureChatReady(page);

        const panel = page.locator(PANEL);
        const attemptsResponses: number[] = [];
        page.on("response", (response) => {
            if (response.url().includes("/attempts")) {
                attemptsResponses.push(response.status());
            }
        });

        await sendChat(page, "XIHE-E2E-SLOW 8000 transport slow probe");

        // While the provider stalls the durable row stays running without a
        // summary — duration/chunks remain null (no invented metrics).
        let slowRunId = "";
        await expect
            .poll(
                async () => {
                    const runsRes = await request.get(
                        `${CP_URL}/api/v1/chat/sessions/${sessionId}/runs?size=1`,
                        { headers: ctx.headers },
                    );
                    if (!runsRes.ok()) return false;
                    const runs = (await runsRes.json()) as {
                        runs?: Array<{ runId: string; status: string }>;
                    };
                    const run = runs.runs?.[0];
                    if (!run || run.status !== "running") return false;
                    slowRunId = run.runId;
                    const attemptsRes = await request.get(
                        `${CP_URL}/api/v1/chat/runs/${slowRunId}/attempts`,
                        { headers: ctx.headers },
                    );
                    if (!attemptsRes.ok()) return false;
                    const attemptsBody = (await attemptsRes.json()) as AttemptsBody;
                    const row = attemptsBody.attempts.at(-1);
                    return (
                        row?.status === "running" &&
                        row.durationMs === null &&
                        row.chunkCount === null
                    );
                },
                { timeout: 30000, intervals: [500, 1000] },
            )
            .toBe(true);

        // SSE-driven: the panel shows the in-flight attempt without a reload.
        await expect(
            panel.locator('[data-testid="monitor-transport-attempt"]').first(),
        ).toBeVisible({ timeout: 25000 });
        await expect(panel, "running chip").toContainText("进行中", { timeout: 25000 });
        await capture(page, "desktop-transport-running.png");

        await awaitLatestChatRunCompleted(request, ctx.headers, ctx.workspaceId);
        const body = await attemptsApi(request, slowRunId);
        const row = body.attempts.at(-1)!;
        expect(row.outcome).toBe("success");
        expect(row.firstChunkMs, "first chunk reflects the provider stall").toBeGreaterThanOrEqual(
            5000,
        );
        expect(row.durationMs ?? 0).toBeGreaterThanOrEqual(row.firstChunkMs ?? 0);
        expect(row.chunkCount).toBeGreaterThan(0);
        expect(
            attemptsResponses.length,
            "attempts route served the panel over HTTP",
        ).toBeGreaterThan(0);
        expect(attemptsResponses.every((status) => status === 200)).toBe(true);
        previousRunId = slowRunId;
    });

    test("desktop: provider failure lands a safe-error attempt and survives refresh", async ({
        page,
        request,
    }) => {
        requireWireMode();
        seedPage(page, ctx);
        await page.goto("/workspace/" + ctx.workspaceId, { waitUntil: "load" });
        await ensureChatReady(page);

        await sendChat(page, "XIHE-E2E-DROP transport failure probe");
        // Track THIS run by id: the generic latest-run poll can satisfy against
        // the previous terminal run before the new one lands.
        let runId = "";
        await expect
            .poll(
                async () => {
                    const runsRes = await request.get(
                        `${CP_URL}/api/v1/chat/sessions/${sessionId}/runs?size=1`,
                        { headers: ctx.headers },
                    );
                    if (!runsRes.ok()) return false;
                    const runs = (await runsRes.json()) as {
                        runs?: Array<{ runId: string }>;
                    };
                    const run = runs.runs?.[0];
                    if (!run || run.runId === previousRunId) return false;
                    runId = run.runId;
                    return true;
                },
                { timeout: 30000, intervals: [300, 800] },
            )
            .toBe(true);
        await awaitOperationCompletedForRun(request, ctx.headers, runId);

        const runRes = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, {
            headers: ctx.headers,
        });
        expect(runRes.ok(), `run ${runRes.status()}`).toBeTruthy();
        const run = (await runRes.json()) as { status: string };
        // A provider stream torn down mid-flight is an uncertain-execution
        // disconnect; the ChatRun contract maps it to `ambiguous` (never
        // auto-retried). `failed`/`partial` stay accepted for variants.
        expect(run.status, "provider disconnect ends the run without retry").toMatch(
            /^(failed|partial|ambiguous)$/,
        );

        const body = await attemptsApi(request, runId);
        const row = body.attempts.at(-1)!;
        expect(row.outcome, "attempt ends as an error").toBe("error");
        expect(row.errorCode, "safe error code is present").toBeTruthy();
        expect(String(row.errorCode)).toMatch(SAFE_ERROR_CODE);
        expect(row.chunkCount ?? 0, "no content was produced before the drop").toBe(0);
        expect(row.firstChunkMs, "no first chunk before the drop").toBeNull();
        expect(body.aggregate.failedCount).toBe(1);
        failureCode = String(row.errorCode);

        const panel = page.locator(PANEL);
        await expect(
            panel.locator('[data-testid="monitor-transport-attempt"]').first(),
        ).toBeVisible({ timeout: 25000 });
        await expect(panel, "panel renders the safe error code").toContainText(failureCode);
        await capture(page, "desktop-transport-failure.png");

        // Refresh: the durable projection restores the state without any live SSE.
        await page.reload({ waitUntil: "load" });
        await expect(page.locator(PANEL)).toBeVisible({ timeout: 25000 });
        await expect(
            page.locator(PANEL),
            "after refresh the failure attempt renders from the durable read",
        ).toContainText(failureCode, { timeout: 25000 });
        await capture(page, "desktop-transport-refresh.png");
    });
});
