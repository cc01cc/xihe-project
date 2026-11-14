import { randomUUID } from "node:crypto";
import { type Page } from "@playwright/test";
import { sendableSession, setupMockAuth, setupMockSessions } from "./auth";
import { setupMockParticipants, setupMockProviderBinding } from "./session-matrix";
import { installContextEventStream } from "./context-events";

/**
 * task-590：mock 车道的「能走完发送路径」夹具。
 *
 * <p>为什么需要它：单靠 `setupMockSessions` 拿不到 `POST /api/v1/chat` —— 发送路径上有四道前提，
 * 少一道就静默停在中途（实测：点发送后既无 `POST /chat`、也无气泡、输入框内容仍在，且**没有**
 * toast 报错，看起来像"点了没反应"）。**诚实边界**：这四条是一次性备齐后从红转绿的，
 * 没有逐项二分出"缺哪一条就必然不发"（每次实验约 40 s，成本高于收益）；四条备齐是本夹具的
 * 契约，不是对产品发送路径各段必要性的断言。</p>
 *
 * 1. 会话投影要带 provider 绑定（`ChatPanel.guardProviderBinding`，BL-270）—— 用
 *    `sendableSession()` 让它自带，不靠 bind-defaults 回带后的重放；
 * 2. `POST /api/v1/chat` 要回一个**已知** runId 的 202（否则 SSE 侧对不上 run）；
 * 3. 会话参与者投影要在（`GET /sessions/{id}/participants`）；
 * 4. context event stream 要在（对话流的推送面）。
 *
 * <p>判据见 `e2e/mock/task590-sendable-fixture.spec.ts`：装它 ⇒ 1 条 `POST /chat` + 气泡 +1 +
 * 输入框清空且 **0 条** bind-defaults；不装 ⇒ 0 条 `POST /chat`。</p>
 */
export async function setupMockSendable(
    page: Page,
    sessionId: string,
    options: { title?: string; runId?: string } = {},
): Promise<{ runId: string }> {
    const runId = options.runId ?? "run-mock-sendable";
    await setupMockAuth(page);
    // 注册在 setupMockAuth 之后：Playwright 后注册的路由优先。
    await page.route("**/api/v1/chat", async (route) => {
        const body = route.request().postDataJSON() as { sessionId?: string } | null;
        await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({
                origin: "user_submission",
                status: "accepted",
                sessionId: body?.sessionId ?? sessionId,
                runId,
                messageId: randomUUID(),
            }),
        });
    });
    await setupMockSessions(page, {
        sessions: [sendableSession({ id: sessionId, title: options.title ?? "可发送会话" })],
    });
    await setupMockParticipants(page, sessionId);
    await setupMockProviderBinding(page, sessionId);
    await installContextEventStream(page);
    return { runId };
}
