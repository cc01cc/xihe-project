import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

/**
 * C1（2026-11-04 用户裁定）：会话 UI 不绑定模型 ⇒ 新建会话是裸会话，发送前必须被引导，
 * 不允许静默失败（BL-204 B：`modelDisplay` 曾显示 profile 兜底模型名，用户一发言就 409
 * `PROVIDER_REQUIRED`）。
 *
 * 本 spec 钉住完整链路：裸会话发送 → 引导弹窗（消息**没有**发出）→ 点「自动绑定」→
 * CP `bind-defaults` 200 → toast「已自动绑定 …」→ 被拦下的消息自动重发 → 上屏。
 *
 * Runs in the mock lane: `pnpm exec playwright test --config e2e/playwright.config.ts
 * e2e/mock/provider-binding-guide.spec.ts`（`XIHE_UI_PORT` 需指向空闲端口）。
 */
const SESSION_ID = "c1-provider-binding-guide";

// 第一次 bind-defaults 的 400 是**故意**造出的引导路径；page-failures 门禁只放行这一条。
test.use({
    mockAllow: [...DEFAULT_MOCK_ALLOW, String.raw`bind-defaults`],
});

test.describe("C1: provider binding guide before send", () => {
    test("guides an unbound session, auto-binds on retry, then the message goes through", async ({
        page,
    }) => {
        await setupMockAuth(page, { sse: { tokens: ["bound reply"] } });
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "C1 guide" }] });
        // 绑成功后重发走 POST /api/v1/chat（catch-all {} 无 runId）；补 202 最小契约。
        await page.route("**/api/v1/chat", async (route) => {
            await route.fulfill({
                status: 202,
                contentType: "application/json",
                body: JSON.stringify({
                    status: "accepted",
                    sessionId: SESSION_ID,
                    runId: "run-c1-guide",
                }),
            });
        });

        let bindAttempts = 0;
        await page.route(`**/api/v1/sessions/${SESSION_ID}/bind-defaults`, async (route) => {
            bindAttempts += 1;
            if (bindAttempts === 1) {
                // 第一次：CP 没有可解析的默认绑定（无模型身份）⇒ 引导，而不是 409 到聊天区。
                await route.fulfill({
                    status: 400,
                    contentType: "application/problem+json",
                    body: JSON.stringify({
                        type: "https://xihe.dev/problems/provider_required",
                        title: "Bad Request",
                        status: 400,
                        code: "PROVIDER_REQUIRED",
                        detail: "No provider binding: set an agent default model",
                        requestId: "req-c1-guide",
                    }),
                });
                return;
            }
            // 第二次（用户点「自动绑定」）：CP 解析出默认连接并落库。
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    id: SESSION_ID,
                    title: "C1 guide",
                    workspaceId: "workspace-1",
                    // normalizeSession 的 detail 契约要求 archived 为 boolean；缺字段会被判成
                    // InvalidSessionProjectionError → onBlocked(BIND_FAILED)，toast 永远不会出现。
                    archived: false,
                    agentPrincipalId: "00000000-0000-4000-8000-0000000000a1",
                    modelProvider: "deepseek",
                    modelName: "deepseek-flash",
                    providerConnectionId: "conn-1",
                    connectionRevision: 2,
                    createdAt: "2026-11-04T10:00:00Z",
                    updatedAt: "2026-11-04T10:00:00Z",
                }),
            });
        });

        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
        const textarea = page.locator('[data-testid="chat-input"]');
        await expect(textarea).toBeVisible();
        await textarea.fill("hello from c1");
        await textarea.press("Enter");

        // 1) 发送被拦下：引导弹窗可见，消息没有上屏（不是静默失败，也不是直接 409）。
        const guide = page.locator('[data-testid="provider-binding-guide-body"]');
        await expect(guide).toBeVisible();
        await expect(page.getByText("会话尚未绑定模型")).toBeVisible();
        await expect(page.locator("text=hello from c1")).toHaveCount(0);

        // 2) 点「自动绑定」→ CP 200 → toast 提示 + 引导关闭。
        await page.locator('[data-testid="provider-binding-guide-retry"]').click();
        await expect(page.getByText(/已自动绑定/)).toBeVisible();
        await expect(guide).toBeHidden();

        // 3) 被拦下的消息自动重发并上屏，回复到达。
        await expect(page.locator("text=hello from c1")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.locator("text=bound reply")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });

        expect(bindAttempts).toBe(2);
    });
});
