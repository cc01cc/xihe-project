/**
 * PLAN-0658 M5：并发（运行中再发送）排队矩阵（mock lane，无栈）。
 *
 * 覆盖清单（T1.3）：
 *  - 第一个 run 还在流式（holdOpen）时，composer 切换为「排队」形态：
 *    发送按钮变停止按钮 + 出现排队按钮（`chat-queue-button`）；
 *  - 第二条消息点排队 → 只发 `POST /sessions/{id}/follow-ups`（**不是**第二个
 *    `POST /chat`，并发双 run 由队列串行化），请求体带 content/branchId；
 *  - 排队后 composer 清空（转录不变由 queue 面板承载，形状耦合留给 real-lane R6）。
 *
 * 断言口径：UI affordance + wire 请求体（不依赖队列快照形状）。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockProviderBinding } from "./helpers/session-matrix";

const SESSION_ID = "test-session";

test("运行中再发送：排队 affordance + follow-ups wire（不产生第二个 /chat）", async ({ page }) => {
    await setupMockAuth(page, { sse: { tokens: ["工作流进行中"], holdOpen: true } });
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Matrix M5" }] });
    await setupMockProviderBinding(page, SESSION_ID);

    const enqueued: Array<Record<string, unknown>> = [];
    let chatPosts = 0;
    page.on("request", (request) => {
        if (request.url().endsWith("/api/v1/chat") && request.method() === "POST") chatPosts += 1;
    });
    await page.route(`**/api/v1/sessions/${SESSION_ID}/follow-ups`, async (route) => {
        if (route.request().method() === "POST") {
            enqueued.push(route.request().postDataJSON() as Record<string, unknown>);
            await route.fulfill({
                status: 202,
                contentType: "application/json",
                body: JSON.stringify({
                    items: [],
                    outstandingCount: enqueued.length,
                    queueState: "queued",
                    limit: 5,
                    pauseReason: null,
                }),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                items: [],
                outstandingCount: 0,
                queueState: "empty",
                limit: 5,
                pauseReason: null,
            }),
        });
    });

    await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
    const input = page.getByTestId("chat-input");
    await expect(input, "composer mounts").toBeVisible({ timeout: 15_000 });

    // 第一条：常规发送，SSE holdOpen 让 run 保持进行中。
    await input.fill("第一条任务");
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("chat-stop-button"), "run is active").toBeVisible({
        timeout: 15_000,
    });
    await expect(page.getByTestId("chat-queue-button"), "queue affordance appears").toBeVisible({
        timeout: 10_000,
    });

    // 第二条：排队（wire 断言：follow-ups POST，content 正确，且没有第二个 /chat）。
    await input.fill("第二条任务");
    const queued = page.waitForResponse(
        (response) =>
            response.url().includes(`/sessions/${SESSION_ID}/follow-ups`) &&
            response.request().method() === "POST",
    );
    await page.getByTestId("chat-queue-button").click();
    expect((await queued).status(), "follow-ups accepted").toBe(202);
    expect(enqueued.length, "exactly one enqueue request").toBe(1);
    expect(enqueued[0]?.content).toBe("第二条任务");
    expect(chatPosts, "queued message must not open a second run").toBe(1);
    await expect(input, "composer cleared after queueing").toHaveValue("");
});
