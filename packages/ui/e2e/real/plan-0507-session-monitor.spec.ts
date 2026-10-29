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
    ensureAgentWorkspaceBinding,
    ensureChatBinding,
    ensureChatReady,
    evidenceDir,
    registerJourneyUser,
    seedPage,
    sendChat,
    type JourneyContext,
} from "./helpers/journey";

const EVIDENCE_DIR = evidenceDir("plan-0507-session-monitor"),
    PANEL = '[data-testid="session-monitor-panel"]';

interface MonitorBody {
    generatedAt: string;
    session: { id: string };
    activity: Array<{ runId: string; status: string; leaseExpired: boolean }>;
    history: {
        windowSize: number;
        counts: Record<string, number>;
        recent: Array<{ runId: string; terminalOutcome: string | null; errorCode: string | null }>;
    };
    readiness: {
        connection: { status: string } | null;
        agent: { llmReady: string };
        lastObservedRun: { runId: string } | null;
    };
}

// PLAN-0507 T4.1/T4.2：右栏 Monitor 的真实浏览器验收（0453 #13/#17 已确认形态）。
// 覆盖：桌面默认打开 Monitor → 空态 → 一次真实 Run 后的数据对照（与 /runs、/monitor 双 API 互证）
// → SSE 事件驱动刷新（第二次 Run 无需手动刷新）→ 视图切换 → 取数失败保留快照+重试恢复
// → SSE 断开 stale 与重连恢复 → 移动端两视图 sheet。
//   node scripts/e2e-host.mjs --batch=session-monitor --retries=0
test.describe("@host PLAN-0507 session monitor panel", () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(300000);

    let ctx: JourneyContext,
        sessionId = "",
        pageErrors: string[] = [],
        intentionalAbort = false;
    const shots: Array<{ name: string; bytes: number; viewport: string }> = [];

    test.beforeAll(async ({ request }) => {
        // PLAN-0525 / BL-143: `ensureAgentWorkspaceBinding` now uses a 30s
        // readiness budget (fast-fail on terminal `llmReady` states, 500ms poll)
        // instead of 180s. Keep this hook's own budget above it (90s) so a
        // describe-scope `test.setTimeout` still cannot mask the helper's
        // descriptive error with an opaque beforeAll timeout.
        test.setTimeout(90000);
        // Agent binds one workspace per process — register exactly once.
        ctx = await registerJourneyUser(request, "plan-0507-monitor");
        // AgentAuth uses `accessToken` while JourneyContext exposes `authToken`.
        const agentAuth = { accessToken: ctx.authToken, workspaceId: ctx.workspaceId };
        // Fresh workspaces have no principal; workspace session creation requires
        // a bound agent principal (POST /api/v1/sessions 400 otherwise).
        const principalId = await provisionWorkspaceAgentPrincipal(request, agentAuth, {
            name: "Monitor Agent",
        });
        sessionId = await createSessionWithPrincipal(request, agentAuth, {
            principalId,
            title: "Monitor session",
        });
        await ensureAgentWorkspaceBinding(ctx.workspaceId);
    });

    test.beforeEach(async ({ page }) => {
        // Enhanced local collector: console text + resource URL, so failure
        // reports can distinguish dev-server noise from API failures.
        pageErrors = [];
        page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message}`));
        page.on("console", (message) => {
            if (message.type() !== "error") return;
            const url = message.location()?.url ?? "";
            pageErrors.push(`console: ${message.text()} (${url})`);
        });
        intentionalAbort = false;
    });

    test.afterEach(async () => {
        // Tests 2/3 break the network on purpose (route abort / CDP offline);
        // that logs net::ERR_FAILED by design. Recovery is proven by functional
        // assertions, and HTTP-level failures ("status of NNN") still fail.
        const actionable = actionableErrors(pageErrors).filter(
            (entry) => !(intentionalAbort && entry.includes("net::ERR_FAILED")),
        );
        expect(actionable, pageErrors.join("\n")).toEqual([]);
    });

    test.afterAll(() => {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        writeFileSync(
            path.join(EVIDENCE_DIR, "manifest.json"),
            JSON.stringify(
                {
                    plan: "PLAN-0507",
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

    async function monitorApi(request: APIRequestContext): Promise<MonitorBody> {
        const response = await request.get(`${CP_URL}/api/v1/chat/sessions/${sessionId}/monitor`, {
            headers: ctx.headers,
        });
        expect(
            response.ok(),
            `monitor ${response.status()}: ${await response.text()}`,
        ).toBeTruthy();
        return (await response.json()) as MonitorBody;
    }

    async function capture(page: Page, name: string): Promise<void> {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const file = path.join(EVIDENCE_DIR, name);
        await page.screenshot({ scale: "css", path: file, animations: "disabled" });
        const viewport = page.viewportSize();
        shots.push({
            name,
            bytes: statSync(file).size,
            viewport: `${viewport?.width ?? 0}x${viewport?.height ?? 0}`,
        });
    }

    test("desktop: default Monitor, API cross-check, SSE refresh, toggles", async ({
        page,
        request,
    }) => {
        // BL-148: the probe run needs a usable chat connection; `ensureChatBinding`
        // builds the real-lane one from the runner-provided identity (node side).
        seedPage(page, ctx);
        await page.goto("/workspace/" + ctx.workspaceId, { waitUntil: "load" });
        await ensureChatReady(page);
        // Bind a chat connection through the same fixture path sendChat specs use,
        // so readiness.connection has a READY fact to show.
        await ensureChatBinding(page, sessionId);
        // PLAN-0525: readiness is checked per layer before the first send — Agent
        // direct health here, Session Provider connection inside ensureChatBinding.
        await assertAgentLlmReady();

        // The Monitor is the default right-panel view on desktop.
        const panel = page.locator(PANEL);
        await expect(panel, "monitor panel is the default view").toBeVisible({ timeout: 20000 });
        await expect(panel.locator('[data-testid="monitor-activity-empty"]')).toBeVisible();
        await expect(panel.locator('[data-testid="monitor-history-empty"]')).toBeVisible();
        await expect(panel.locator('[data-testid="monitor-agent-global-tag"]')).toBeVisible();
        await capture(page, "desktop-monitor-empty.png");

        const monitorResponses: number[] = [];
        page.on("response", (response) => {
            if (response.url().includes(`/chat/sessions/${sessionId}/monitor`)) {
                monitorResponses.push(response.status());
            }
        });

        // First run → terminal → cross-check panel facts against both APIs.
        await sendChat(page, "monitor probe one");
        await awaitLatestChatRunCompleted(request, ctx.headers, ctx.workspaceId);

        const runsResponse = await request.get(
            `${CP_URL}/api/v1/chat/sessions/${sessionId}/runs?size=5`,
            { headers: ctx.headers },
        );
        expect(runsResponse.ok(), `runs ${runsResponse.status()}`).toBeTruthy();
        const runsBody = (await runsResponse.json()) as {
                runs?: Array<{ runId: string; status: string; terminalOutcome: string | null }>;
            },
            newest = runsBody.runs?.[0];
        expect(newest?.status, "mock probe run succeeds").toBe("succeeded");

        const monitor = await monitorApi(request);
        expect(monitor.activity, "terminal run leaves activity empty").toEqual([]);
        expect(monitor.history.recent[0]?.runId, "monitor newest terminal matches /runs").toBe(
            newest?.runId,
        );
        const [outcomeKey, outcomeCount] = Object.entries(monitor.history.counts)[0] ?? [];
        expect(outcomeKey).toBeTruthy();
        expect(outcomeCount).toBe(1);
        expect(monitor.readiness.connection?.status, "bound connection is READY").toBe("READY");
        expect(monitor.readiness.lastObservedRun?.runId).toBe(newest?.runId);

        await expect(panel, "panel shows the same run (short id)").toContainText(
            newest!.runId.slice(0, 8),
            { timeout: 20000 },
        );
        await expect(panel, "panel shows the outcome count chip").toContainText(
            `${outcomeKey} · ${outcomeCount}`,
            { timeout: 20000 },
        );
        await expect(panel, "readiness shows the explicit verify fact").toContainText("READY", {
            timeout: 20000,
        });
        await capture(page, "desktop-monitor-history.png");

        // Second run: refresh must arrive through SSE signals (no reload, no manual refresh).
        await sendChat(page, "monitor probe two");
        await awaitLatestChatRunCompleted(request, ctx.headers, ctx.workspaceId);
        await expect(panel, "SSE-driven refresh bumps the history count").toContainText(
            `${outcomeKey} · 2`,
            { timeout: 30000 },
        );

        // Toggle away and back.
        await page.locator('[data-testid="workspace-toolbar-changes"]').click();
        await expect(page.locator('[data-testid="workspace-changes-panel"]')).toBeVisible();
        await page.locator('[data-testid="workspace-toolbar-monitor"]').click();
        await expect(panel).toBeVisible();
        await capture(page, "desktop-monitor-toggle.png");

        expect(monitorResponses.length, "monitor endpoint was fetched over HTTP").toBeGreaterThan(
            0,
        );
        expect(monitorResponses.every((status) => status === 200)).toBe(true);
    });

    test("desktop: fetch failure keeps the snapshot and retry recovers", async ({ page }) => {
        seedPage(page, ctx);
        await page.goto("/workspace/" + ctx.workspaceId, { waitUntil: "load" });
        await ensureChatReady(page);

        const panel = page.locator(PANEL);
        await expect(panel).toBeVisible({ timeout: 20000 });
        await expect(panel.locator('[data-testid="monitor-history-item"]').first()).toBeVisible({
            timeout: 20000,
        });
        // The console must be clean up to this point; the intentional route
        // abort below logs net::ERR_FAILED by design, so the collector is
        // reset afterwards — real errors in the recovery window still fail.
        expect(actionableErrors(pageErrors), pageErrors.join("\n")).toEqual([]);

        intentionalAbort = true;
        const route = "**/api/v1/chat/sessions/*/monitor";
        await page.route(route, (handler) => handler.abort());
        await page.locator('[data-testid="monitor-refresh"]').click();
        await expect(
            page.locator('[data-testid="monitor-fetch-failed-banner"]'),
            "failure banner appears while the snapshot stays visible",
        ).toBeVisible({ timeout: 15000 });
        await expect(panel.locator('[data-testid="monitor-history-item"]').first()).toBeVisible();
        await capture(page, "desktop-monitor-fetch-failed.png");

        await page.unroute(route);
        await page.locator('[data-testid="monitor-fetch-failed-banner"] button').click();
        await expect(page.locator('[data-testid="monitor-fetch-failed-banner"]')).toBeHidden({
            timeout: 15000,
        });
    });

    test("desktop: SSE drop marks stale and reconnect restores live", async ({ page }) => {
        seedPage(page, ctx);
        // The chat events stream is blocked from its very first attempt:
        // Chromium's offline emulation does not reset the established fetch
        // stream, so the deterministic variant is a failed initial connect —
        // same stale/reconnect contract (transport latches one offline signal).
        // Retry attempts log net::ERR_FAILED; intentionalAbort filters them.
        intentionalAbort = true;
        const route = "**/api/v1/events*";
        await page.route(route, (handler) => handler.abort());
        await page.goto("/workspace/" + ctx.workspaceId, { waitUntil: "load" });
        await ensureChatReady(page);

        const panel = page.locator(PANEL),
            chip = page.locator('[data-testid="monitor-connection-chip"]');
        await expect(panel).toBeVisible({ timeout: 20000 });
        await expect(chip, "failed SSE connect flips the monitor to stale").toHaveText(/已断开/, {
            timeout: 30000,
        });
        await expect(page.locator('[data-testid="monitor-stale-banner"]')).toBeVisible();
        await capture(page, "desktop-monitor-stale.png");

        await page.unroute(route);
        await expect(chip, "transport reconnect restores live").toHaveText(/实时/, {
            timeout: 60000,
        });
    });

    test("mobile: monitor sheet with two tabs", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        seedPage(page, ctx);
        await page.goto("/workspace/" + ctx.workspaceId, { waitUntil: "load" });

        // PLAN-0560 M3 (cb5651a7) converged the workspace toolbar entries: on
        // mobile the monitor entry lives in the toolbar overflow menu
        // (`workspace-toolbar-more-mobile` → `workspace-toolbar-more-monitor`),
        // while the desktop row button (`workspace-toolbar-monitor`) is hidden
        // below the md breakpoint. Opening it selects the monitor tab by default
        // (`mobile-aux-tab-monitor`, aria-selected=true).
        const overflow = page.locator('[data-testid="workspace-toolbar-more-mobile"]');
        await expect(overflow).toBeVisible({ timeout: 20000 });
        await overflow.click();
        await page.locator('[data-testid="workspace-toolbar-more-monitor"]').click();
        const sheet = page.locator('[data-testid="mobile-changes-sheet"]');
        await expect(sheet).toBeVisible({ timeout: 10000 });
        await expect(
            sheet.locator('[data-testid="mobile-aux-tab-monitor"]'),
            "monitor tab is the default mobile aux tab",
        ).toHaveAttribute("aria-selected", "true");
        await expect(sheet.locator(PANEL), "monitor view inside the mobile sheet").toBeVisible({
            timeout: 20000,
        });
        await expect(sheet).toContainText("success", { timeout: 20000 });
        await capture(page, "mobile-monitor-sheet.png");

        await sheet.locator('[data-testid="mobile-aux-tab-changes"]').click();
        await expect(sheet.locator('[data-testid="workspace-changes-panel"]')).toBeVisible();
    });
});
