import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

const SESSION_ID = "budget-exhausted-session";

/**
 * PLAN-0492 T3.1/T3.2: a budget-exhausted run surfaces the localized reason
 * (dimension from the CP's `budgetDimension=<dim>` error detail) plus the
 * takeover hint, and the session stays resumable from the same input.
 *
 * `holdOpen` keeps the mocked `/api/v1/events` stream open after the first POST so the
 * transport stays connected, and the second POST then streams a normal run (the error is
 * one-shot), proving the takeover path.
 *
 * **task-178：这段注释原先在描述一个不可能发生的场景。** 旧夹具在 `error` 事件后**既不发
 * `done` 也不 close**（`helpers/auth.ts` 的 error 分支），`holdOpen` 的成功路径同样只 `return`。
 * 于是第一次 run 在客户端永不终结（composer 停在「排队发送 / 停止生成」态，实测失败快照里
 * textarea 仍留着草稿、`chat-queue-button` 在），第二次回车进的是 **follow-up 队列**而不是新 run
 * ⇒ 队列等上一条 run 结束才 flush ⇒ 用户气泡永远不出现，「接续发送」根本没被验到。
 * 现在夹具在 `error` 之后补发 `done`（CP 的真实行为），本 spec 也显式断言「已退出队列态」与
 * 「第二次发送真的开了新 run（POST /api/v1/chat 计数 = 2）」，否则无法排除「队列碰巧灵了」。
 */
test.describe("Run budget exhaustion surface", () => {
    test("shows the localized turns reason and keeps the resume entry open", async ({ page }) => {
        await setupMockAuth(page, {
            sse: {
                tokens: ["Working ", "on ", "it..."],
                errorAfterTokens: {
                    code: "RUN_BUDGET_EXHAUSTED",
                    detail: "budgetDimension=turns",
                    dimension: "turns",
                    retryable: false,
                    outcome: "error",
                },
                holdOpen: true,
            },
        });
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "Budget" }],
        });

        // task-178：数「新 run 的请求次数」—— 只有它才能区分「直接开新 run」与「进了 follow-up 队列」。
        const chatPosts: string[] = [];
        page.on("request", (request) => {
            if (request.method() !== "POST") return;
            if (new URL(request.url()).pathname === "/api/v1/chat") chatPosts.push(request.url());
        });

        await page.goto(`/workspace/11111111-1111-4111-8111-111111111111/chat/${SESSION_ID}`);
        const input = page.locator('[data-testid="chat-input"]');
        await expect(input).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await input.fill("keep looping until the budget stops you");
        await input.press("Enter");

        const error = page.locator('[data-testid="message-error"]');
        await expect(error).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(error).toContainText("RUN_BUDGET_EXHAUSTED");
        await expect(error).toContainText("budgetDimension=turns");
        await expect(error).toContainText("本次运行已达到轮数上限");
        await expect(page.locator('[data-testid="message-budget-exhausted-hint"]')).toContainText(
            "可在下方输入框继续发送，接续本次会话",
        );
        await expect(page.locator('[data-testid="message-retry-button"]')).toHaveCount(0);

        // 提示语告诉用户「可在下方输入框继续发送，接续本次会话」⇒ 接续必须真的能发出去。
        await expect(input).toBeEnabled();
        // task-180：先证明**已经退出「进行中」态** —— 队列按钮在 ⇒ 还停在 follow-up 队列模式，
        // 那种情况下后来的「气泡出现」只可能来自队列 flush，而不是本条用例要验的接续发送。
        // 根因（源码链）：夹具的 `GET /chat/runs/{id}` 桩把这条 run 一直答成 `running`，
        // 客户端 `refreshRunRecovery` 据此把会话推回 `thinking`（`SSEStream.vue` recovery 分支）
        // ⇒ `isStreaming` 恒真（`chat.ts:256-264` 把 thinking/executing 也算 streaming）。
        // 修法在夹具：SSE 发出终态事件时同步把注册表里的 run 标成 failed。
        await expect(page.locator('[data-testid="chat-queue-button"]')).toHaveCount(0);
        expect(chatPosts.length, "预算耗尽只应产生 1 次 POST").toBe(1);

        await input.fill("resume after the budget");
        await input.press("Enter");
        await expect(page.locator("text=resume after the budget")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 渲染器用的是单字符省略号 U+2026（`…`），不是 ASCII `...`；断言必须对齐真实渲染文本。
        await expect(page.locator("text=Working on it…").first()).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 接续发送必须是**新 run**（第二次 POST /api/v1/chat），不是队列里的草稿。
        expect(chatPosts.length, "接续发送应开出第二个 run").toBe(2);

        await page.screenshot({ path: "test-results/run-budget-exhausted.png", fullPage: true });
    });

    test("keeps the exhaustion surface readable on a mobile viewport", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await setupMockAuth(page, {
            sse: {
                tokens: ["partial"],
                errorAfterTokens: {
                    code: "RUN_BUDGET_EXHAUSTED",
                    detail: "budgetDimension=elapsed",
                    dimension: "elapsed",
                    retryable: false,
                    outcome: "error",
                },
                holdOpen: true,
            },
        });
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "Budget" }],
        });

        await page.goto(`/workspace/11111111-1111-4111-8111-111111111111/chat/${SESSION_ID}`);
        // 390 视口下聊天在 `MobileChatSheet` 内：必须先点「Open chat」触发器，否则输入框根本不在可见层
        // （与 `checkpoint-rollback.spec.ts` / `approval.spec.ts` 的移动端写法一致）。
        if ((page.viewportSize()?.width ?? 1920) < 768) {
            await page.getByTestId("mobile-chat-open").click();
        }
        const input = page.locator('[data-testid="chat-input"]');
        await expect(input).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await input.fill("long running task");
        await input.press("Enter");

        const error = page.locator('[data-testid="message-error"]');
        await expect(error).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(error).toContainText("本次运行已达到累计耗时上限");
        const hint = page.locator('[data-testid="message-budget-exhausted-hint"]');
        await expect(hint).toBeVisible();

        const errorBox = await error.boundingBox();
        expect(errorBox).not.toBeNull();
        expect(errorBox!.x + errorBox!.width).toBeLessThanOrEqual(390 + 1);

        await page.screenshot({
            path: "test-results/run-budget-exhausted-mobile.png",
            fullPage: true,
        });
    });
});
