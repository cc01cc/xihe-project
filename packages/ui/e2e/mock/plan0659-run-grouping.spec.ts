/**
 * PLAN-0659 T1.1：run 分组渲染的**真浏览器证据**（mock lane：无后端，Playwright 自起 Vite
 * dev server，路由拦截见 `helpers/auth.ts` / `helpers/session-matrix.ts`）。
 *
 * 覆盖 V1 判据：
 *  - 同一线程两个 run ⇒ 各自一条 run 头，`data-run-id` 是**全文** runId（短码只用于展示）；
 *  - 行归属：run 头之后缩进该 run 的消息（`run-group-body` 带左边框），顺序不串组；
 *  - 失败 run 默认折叠成单行 run 头（`data-failed="true"`），点击可展开；
 *  - 单 run 会话不分组（无 run 头、无缩进）——design 反证「单 run 不增噪音」。
 *
 * 截图证据落 `XIHE_EVIDENCE_DIR`（缺失即失败，见 `helpers/evidence.ts`）。
 * 运行方式（避开其它车道的 stack 端口；本 spec 只需自己的 dev server + 单窗口浏览器）：
 *   $env:XIHE_UI_PORT = "12650"; $env:XIHE_E2E_BROWSER_CHANNEL = "chrome-beta"
 *   $env:XIHE_E2E_HEADED = "1"; $env:XIHE_EVIDENCE_DIR = "<one>/plans/PLAN-0659-.../evidence"
 *   pnpm exec playwright test --config e2e/playwright.config.ts e2e/mock/plan0659-run-grouping.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockParticipants } from "./helpers/session-matrix";
import { captureEvidence } from "../helpers/evidence";

const SESSION_ID = "test-session";
const SINGLE_RUN_SESSION_ID = "single-run-session";

const RUN_A = "aaaaaaaa-1111-4222-8333-444444444444";
const RUN_B = "bbbbbbbb-1111-4222-8333-444444444444";
const RUN_C = "cccccccc-1111-4222-8333-444444444444";

/** `setupMockSessions` 的 `messages` 只接受 `Record<string, unknown>[]`（wire 原文透传）。 */
interface RawMessageDto extends Record<string, unknown> {
    id: string;
    sessionId: string;
    role: "USER" | "ASSISTANT";
    content: string;
    createdAt: string;
    runId: string;
    runStatus: string;
    terminalOutcome: string | null;
}

function userMessage(id: string, sessionId: string, content: string, runId: string): RawMessageDto {
    return {
        id,
        sessionId,
        role: "USER",
        content,
        createdAt: "2026-11-04T10:00:00.000Z",
        runId,
        runStatus: "succeeded",
        terminalOutcome: "success",
    };
}

function assistantMessage(
    id: string,
    sessionId: string,
    content: string,
    runId: string,
    status: string,
    outcome: string | null,
): RawMessageDto {
    return {
        id,
        sessionId,
        role: "ASSISTANT",
        content,
        createdAt: "2026-11-04T10:00:01.000Z",
        runId,
        runStatus: status,
        terminalOutcome: outcome,
    };
}

function runSummary(
    runId: string,
    sessionId: string,
    status: string,
    outcome: string | null,
    terminalAt: string | null,
) {
    return {
        runId,
        sessionId,
        origin: "user_submission",
        status,
        terminalOutcome: outcome,
        errorCode: outcome === "error" ? "PROVIDER_UNAVAILABLE" : null,
        createdAt: "2026-11-04T10:00:00.000Z",
        terminalAt,
        waitingOnRunId: null,
        waitingToolCallId: null,
    };
}

async function setupRunsRoute(
    page: Page,
    sessionId: string,
    runs: ReturnType<typeof runSummary>[],
): Promise<void> {
    await page.route(`**/api/v1/chat/sessions/${sessionId}/runs*`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessionId, page: 0, size: 100, runs }),
        });
    });
}

async function openSession(page: Page, sessionId: string): Promise<void> {
    await page.goto(`/workspace/workspace-1/chat/${sessionId}`);
    await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
        timeout: 15_000,
    });
}

/**
 * 证据截图只讲 run 分组这一件事：右栏 dock 的监控面板在 mock 车道没有真实数据，
 * 截进去就是「监控数据加载失败」的红字噪音（会被误读成产品缺陷）。关掉该 tab 是
 * 普通用户动作，不改布局默认值（持久化在 localStorage，测试上下文即丢）。
 */
async function closeMonitorDockTab(page: Page): Promise<void> {
    const close = page.getByTestId("dock-tab-close-monitor");
    if ((await close.count()) > 0) await close.click();
    await expect(page.getByTestId("dock-tab-monitor")).toHaveCount(0);
}

/**
 * derived-state 投影是独立面板（「子任务状态」）。mock 车道不造委派数据时它诚实报
 * 「暂不可用」——那是**没桩**，不是被测行为；证据截图前桩成空投影。
 */
async function stubDerivedState(page: Page, sessionId: string): Promise<void> {
    await page.route(`**/api/v1/sessions/${sessionId}/derived-state`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessionId, activeChildren: [], terminalNotices: [] }),
        });
    });
}

test.describe("PLAN-0659 T1.1 — run 分组渲染", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, {
            sessions: [
                { id: SESSION_ID, title: "两 run 线程" },
                { id: SINGLE_RUN_SESSION_ID, title: "单 run 线程" },
            ],
            messages: {
                [SESSION_ID]: [
                    userMessage("a-user", SESSION_ID, "把登录页的错误提示统一一下", RUN_A),
                    assistantMessage(
                        "a-assistant",
                        SESSION_ID,
                        "已统一 3 处错误提示，并补了 aria-assertive。",
                        RUN_A,
                        "succeeded",
                        "success",
                    ),
                    userMessage("b-user", SESSION_ID, "再跑一遍 lint", RUN_B),
                    assistantMessage(
                        "b-assistant",
                        SESSION_ID,
                        "lint 失败：oxfmt 在 2 个文件上漂移。",
                        RUN_B,
                        "failed",
                        "error",
                    ),
                ],
                [SINGLE_RUN_SESSION_ID]: [
                    userMessage("c-user", SINGLE_RUN_SESSION_ID, "单 run 提问", RUN_C),
                    assistantMessage(
                        "c-assistant",
                        SINGLE_RUN_SESSION_ID,
                        "单 run 回答。",
                        RUN_C,
                        "succeeded",
                        "success",
                    ),
                ],
            },
        });
        await setupMockParticipants(page, SESSION_ID, { participants: [] });
    });

    test("两个 run 各自分组；失败 run 默认折叠、可展开；截图留证", async ({ page }) => {
        await setupRunsRoute(page, SESSION_ID, [
            runSummary(RUN_A, SESSION_ID, "succeeded", "success", "2026-11-04T10:00:03.400Z"),
            runSummary(RUN_B, SESSION_ID, "failed", "error", "2026-11-04T10:00:12.000Z"),
        ]);
        await stubDerivedState(page, SESSION_ID);
        await openSession(page, SESSION_ID);
        await closeMonitorDockTab(page);

        const headers = page.getByTestId("run-header");
        await expect(headers, "two runs ⇒ two run headers").toHaveCount(2, { timeout: 15_000 });
        // 身份一律全文 runId（短码只用于展示）。
        await expect(headers.nth(0)).toHaveAttribute("data-run-id", RUN_A);
        await expect(headers.nth(1)).toHaveAttribute("data-run-id", RUN_B);
        await expect(headers.nth(0)).toHaveAttribute("data-run-status", "succeeded");
        await expect(headers.nth(1)).toHaveAttribute("data-run-status", "failed");
        // 终态 run 显示耗时（createdAt → terminalAt），在途不显示。
        await expect(page.getByTestId("run-header-duration").nth(0)).toHaveText("3.4s");
        await expect(page.getByTestId("run-header-duration").nth(1)).toHaveText("12s");

        // 失败 run 默认折叠：第二组的两条消息都不渲染，只剩 run 头（红色）。
        await expect(headers.nth(1)).toHaveAttribute("data-failed", "true");
        await expect(page.getByTestId("message-item"), "A 组 2 条可见，B 组折叠").toHaveCount(2);
        await expect(page.getByTestId("run-group-body")).toHaveCount(2);
        await expect(
            page.getByTestId("run-group-body").first(),
            "分组态消息带缩进左边框",
        ).toHaveClass(/border-l/);
        // 行归属：可见消息都来自 run A，且顺序保持（用户消息在回答之前）。
        await expect(page.getByTestId("message-item").nth(0)).toContainText("把登录页的错误提示");
        await expect(page.getByTestId("message-item").nth(1)).toContainText("已统一 3 处错误提示");

        await captureEvidence(page, "t1.1-run-grouping-collapsed");

        // 点击失败 run 头展开：该 run 的消息回来。
        await headers.nth(1).getByTestId("run-header-toggle").click();
        await expect(page.getByTestId("message-item"), "展开后 B 组 2 条回来").toHaveCount(4);
        await expect(page.getByTestId("message-item").nth(2)).toContainText("再跑一遍 lint");
        await expect(headers.nth(1)).toHaveAttribute("data-failed", "true");

        await captureEvidence(page, "t1.1-run-grouping-expanded");
    });

    test("单 run 会话不分组：无 run 头、无缩进", async ({ page }) => {
        await setupRunsRoute(page, SINGLE_RUN_SESSION_ID, [
            runSummary(
                RUN_C,
                SINGLE_RUN_SESSION_ID,
                "succeeded",
                "success",
                "2026-11-04T10:00:02.000Z",
            ),
        ]);
        await stubDerivedState(page, SINGLE_RUN_SESSION_ID);
        await openSession(page, SINGLE_RUN_SESSION_ID);
        await closeMonitorDockTab(page);

        await expect(page.getByTestId("message-item")).toHaveCount(2, { timeout: 15_000 });
        await expect(page.getByTestId("run-header"), "单 run 不增噪音").toHaveCount(0);
        await expect(page.getByTestId("run-group-body").first()).not.toHaveClass(/border-l/);

        await captureEvidence(page, "t1.1-run-grouping-single");
    });
});
