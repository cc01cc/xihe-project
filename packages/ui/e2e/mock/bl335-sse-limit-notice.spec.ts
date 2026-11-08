// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * BL-335 · SSE 订阅上限（429）的 UI 提示：**先红**用例。
 *
 * 背景：CP 在 `WorkspaceEventManager` 达到上限时返回
 * `429 WORKSPACE_EVENT_SUBSCRIBERS_LIMIT`（detail: "Workspace event subscriber limit reached"，
 * 指引是"关掉不用的标签页"），`UserChannelSseManager` 对应 `429 USER_CHANNEL_FULL`。
 * UI 侧零处理：`useWorkspaceSSE` 只把 `Error.message` 存进 `connectionError`，code 丢掉，
 * 页面没有任何可见提示 ⇒ 用户只看到"页面不刷新了"。
 *
 * 本 spec 断言（修复前必红）：
 *  1. 工作区事件流 429 `WORKSPACE_EVENT_SUBSCRIBERS_LIMIT` ⇒ 出现 `[data-testid="sse-subscriber-limit-notice"]`，
 *     文案含"停止刷新"指引；
 *  2. 用户通道 429 `USER_CHANNEL_FULL` ⇒ 同样出现该提示（两个上限共用一条用户可见指引）；
 *  3. 提示是 `role="status"`（可被读屏播报），且**不是** toast（不做成 4 秒后消失的临时提示）。
 */
import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { LONG_TIMEOUT_MS } from "../timeouts";

// 这些 429 是本用例**故意**造出来的订阅上限，逐条放行。
test.use({
    mockAllow: [...DEFAULT_MOCK_ALLOW, String.raw`/events$`, String.raw`/user-events`],
});

const SESSION_ID = "bl335-session";

async function openWorkspace(page: import("@playwright/test").Page) {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "BL-335" }] });
}

test.describe("BL-335 SSE 订阅上限提示", () => {
    test("工作区事件流 429 WORKSPACE_EVENT_SUBSCRIBERS_LIMIT ⇒ 页面出现停止刷新指引", async ({
        page,
    }) => {
        await openWorkspace(page);
        await page.route("**/api/v1/workspaces/*/events", async (route) => {
            await route.fulfill({
                status: 429,
                contentType: "application/problem+json",
                body: JSON.stringify({
                    type: "https://xihe.dev/problems/too_many_requests",
                    title: "Too Many Requests",
                    status: 429,
                    code: "WORKSPACE_EVENT_SUBSCRIBERS_LIMIT",
                    detail: "Workspace event subscriber limit reached",
                }),
            });
        });

        await page.goto("/workspace/workspace-1/chat/bl335-session");

        // PLAN-0699 M2：同一上限会在「壳级横幅」(AppLayout) 与「页面级横幅」
        // (WorkspaceView，仅 disconnected/reconnecting 才渲染) 之外，还可能被两处壳挂载重复渲染；
        // 断言只针对第一条可见横幅，避免 strict-mode 双元素误伤。
        const notice = page.locator('[data-testid="sse-subscriber-limit-notice"]').first();
        await expect(notice).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect(notice).toHaveAttribute("role", "status");
        await expect(notice).toContainText("停止刷新");
        await expect(notice).toContainText("标签页");
        // 不是 toast：sonner 容器里不该出现这条提示
        await expect(
            page.locator("[data-sonner-toast]").filter({ hasText: "停止刷新" }),
        ).toHaveCount(0);
    });

    test("用户通道 429 USER_CHANNEL_FULL ⇒ 同样出现停止刷新指引", async ({ page }) => {
        await openWorkspace(page);
        await page.route("**/api/v1/user-events", async (route) => {
            await route.fulfill({
                status: 429,
                contentType: "application/problem+json",
                body: JSON.stringify({
                    type: "https://xihe.dev/problems/too_many_requests",
                    title: "Too Many Requests",
                    status: 429,
                    code: "USER_CHANNEL_FULL",
                    detail: "user channel subscriber limit reached",
                }),
            });
        });

        await page.goto("/workspace/workspace-1/chat/bl335-session");

        const notice = page.locator('[data-testid="sse-subscriber-limit-notice"]');
        await expect(notice).toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await expect(notice).toContainText("停止刷新");
    });
});
