// timeout-exempt: 首条发送路径要等 202 + 乐观插入，并含反向控制（task-590）
/**
 * task-590：mock 车道「能走完发送路径」的夹具 —— 自证 spec（四条验收逐条对应）。
 *
 * 1. helpers 提供能走完整发送路径的能力 —— `setupMockSendable()`（helpers/sendable.ts）；
 * 2. 自证：装夹具后拿到 1 条 `POST /api/v1/chat` + 1 个 user 气泡 + 输入框清空；
 * 3. 反向：不装夹具时同一动作拿不到以上任一条（证明夹具真在起作用）；
 * 4. 选型判据：装夹具时 **0 条** `POST .../bind-defaults` —— 绑定来自会话投影
 *    （`sendableSession()` 带 `providerConnectionId`），**不依赖** bind-defaults 回带后的重放时机。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockSendable } from "./helpers/sendable";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CHAT_URL = "/workspace/" + WORKSPACE_ID + "/session/" + SESSION_ID;
const TEXT = "夹具自证一次";

type Reads = { chat: number; bindDefaults: number; posts: string[] };

function watchPosts(page: Page): Reads {
    const reads: Reads = { chat: 0, bindDefaults: 0, posts: [] };
    page.on("request", (request) => {
        if (request.method() !== "POST") return;
        const path = new URL(request.url()).pathname;
        reads.posts.push(path);
        if (path === "/api/v1/chat") reads.chat += 1;
        if (path.endsWith("/bind-defaults")) reads.bindDefaults += 1;
    });
    return reads;
}

async function openAndSend(page: Page): Promise<void> {
    await page.goto(CHAT_URL);
    const input = page.getByTestId("chat-input");
    await expect(input).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await input.fill(TEXT);
    await page.getByTestId("chat-send-button").click({ timeout: ACTION_TIMEOUT_MS });
}

test.describe("task-590 mock 发送路径夹具", () => {
    test("装夹具 ⇒ 1 条 POST /chat + 气泡 +1 + 输入框清空，且 0 条 bind-defaults", async ({
        page,
    }) => {
        const reads = watchPosts(page);
        await setupMockSendable(page, SESSION_ID);
        await openAndSend(page);

        await expect.poll(() => reads.chat, { timeout: LONG_TIMEOUT_MS }).toBe(1);
        await expect(page.getByText(TEXT), "user bubble appears").toHaveCount(1, {
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.getByTestId("chat-input"), "draft cleared").toHaveValue("", {
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 第 4 条：绑定来自会话投影 ⇒ 根本不该打 bind-defaults。
        expect(reads.bindDefaults, "装夹具后不得再打 bind-defaults").toBe(0);
    });

    test("不装夹具 ⇒ 0 条 POST /chat、无气泡、输入框内容仍在（反向控制）", async ({ page }) => {
        const reads = watchPosts(page);
        // 显式选「旧有限体口径」（task-62）：本用例的判据就是**连接不建立 ⇒ 发送静默不发生**，
        // 默认值已改为真实长连接（chat 流永不关闭），「不装夹具」不再等于「发不出去」。
        // 这里不放松任何断言，只是把「要靠超时证明的否定」重新钉回它原本的前提。
        await setupMockAuth(page, { sse: false });
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "未绑定会话" }] });
        await openAndSend(page);

        await page.waitForTimeout(ACTION_TIMEOUT_MS * 2);
        expect(reads.chat, "未装夹具时不得发出 /chat").toBe(0);
        await expect(page.getByText(TEXT), "no user bubble").toHaveCount(0);
        await expect(page.getByTestId("chat-input"), "draft kept").toHaveValue(TEXT);
    });
});
