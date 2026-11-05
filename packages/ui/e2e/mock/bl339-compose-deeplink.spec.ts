/**
 * BL-339 · 深链预填（`?compose=<base64url(JSON)>`）的 mock E2E。
 *
 * 产品口径：外部入口（托盘 / 通知 / CLI / 别的应用）能把「要发的内容 + 目标主体」带进来，
 * 但**只预填、绝不代发**。本 spec 用 mock 夹具自包含地证三件事：
 *  1. 带参打开 ⇒ composer 里有预填文本；
 *  2. 预填后 URL 里的 `compose` 已经消失（刷新/后退都不会重复预填）；
 *  3. **没有自动发送**：消息条数保持 0，且没有任何 `/chat` 发送请求。
 *
 * 不碰 `helpers/**`：全部复用既有 `setupMockAuth` / `setupMockSessions`。
 */
import { expect, test } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

const SESSION_ID = "bl339-session";

/** UTF-8 JSON → base64url（与外部入口的拼法一致：`-`/`_`、无 padding）。 */
function encodeCompose(payload: unknown): string {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

test.describe("BL-339 深链预填", () => {
    test("带 compose 打开 ⇒ composer 预填、URL 清参、未自动发送", async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "BL-339" }] });

        // 计数发送请求：预填不等于发送。
        let chatRequests = 0;
        await page.route("**/api/v1/sessions/*/chat", async (route) => {
            chatRequests += 1;
            await route.fulfill({
                status: 202,
                contentType: "application/json",
                body: JSON.stringify({ accepted: true }),
            });
        });

        const compose = encodeCompose({
            text: "来自托盘的预填内容：帮我核对这条绑定",
            sessionId: SESSION_ID,
        });
        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}?compose=${compose}`);

        const input = page.getByTestId("chat-input");
        await expect(input).toHaveValue("来自托盘的预填内容：帮我核对这条绑定", { timeout: 15000 });

        // 立刻清参：URL 不再携带 compose（刷新不会重复预填）。
        await expect.poll(() => new URL(page.url()).searchParams.has("compose")).toBe(false);

        // 未自动发送：消息列表为空，且没有发生 /chat 请求。
        await expect(page.getByTestId("message-list").getByTestId("message-item")).toHaveCount(0);
        expect(chatRequests).toBe(0);
    });

    test("非法载荷 ⇒ 静默忽略（composer 空、URL 清参、无请求、不打断）", async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "BL-339 bad" }] });

        let chatRequests = 0;
        await page.route("**/api/v1/sessions/*/chat", async (route) => {
            chatRequests += 1;
            await route.fulfill({ status: 202, contentType: "application/json", body: "{}" });
        });

        const warnSpy: string[] = [];
        page.on("console", (message) => {
            if (message.type() === "warning") warnSpy.push(message.text());
        });

        // `text` 缺失 ⇒ 整条忽略。
        await page.goto(
            `/workspace/workspace-1/chat/${SESSION_ID}?compose=${encodeCompose({ to: ["x"] })}`,
        );

        await expect(page.getByTestId("chat-input")).toHaveValue("", { timeout: 15000 });
        await expect.poll(() => new URL(page.url()).searchParams.has("compose")).toBe(false);
        expect(chatRequests).toBe(0);
        expect(warnSpy.some((text) => text.includes("[compose-deeplink]"))).toBe(true);
    });
});
