/**
 * PLAN-0659 T1.3：消息头投递语义的**真浏览器证据**（mock 车道，无后端）。
 *
 * 覆盖 V3 判据三态：`发送→(A)` / `@被@者`（高亮 chip）/ `抄送→(B,C)`，并断言 @ 不重复
 * 计入抄送名单。**限制（BL-239）**：TO/CC 没有持久载体，会话重载后三态丢失；@ 可从正文 +
 * 花名册重建。本 spec 只证明「发送后本地视图」的渲染与去重，不证明重载后仍在。
 *
 * 截图落 `XIHE_EVIDENCE_DIR`（见 `helpers/evidence.ts`）。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { randomUUID } from "node:crypto";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockParticipants } from "./helpers/session-matrix";
import { captureEvidence } from "../helpers/evidence";
import { closeMonitorDockTab, openMockSession, stubDerivedState } from "./helpers/plan0659";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS } from "../timeouts";

const SESSION_ID = "test-session";

interface ChatPostBody {
    sessionId?: string;
    content?: string;
    asParticipantId?: string | null;
    cc?: string[];
}

/**
 * 捕获真实 `POST /api/v1/chat` 的 body（mock lane 下由本路由回答 202）。
 *
 * 判据不只看"发送后本地渲染了什么"：草稿没清、消息没落地也可能是候选面吃了点击。
 * 真正要钉的是**发出去的投递语义**（`content` 带 @、`cc` 带旁听名单、`asParticipantId` 是
 * 发送主体）——那是 CP 持久化与唤醒的依据。
 */
async function captureChatPost(page: Page): Promise<{ current: () => ChatPostBody | null }> {
    let captured: ChatPostBody | null = null;
    await page.route("**/api/v1/chat", async (route) => {
        if (route.request().method() !== "POST") {
            await route.fallback();
            return;
        }
        captured = route.request().postDataJSON() as ChatPostBody;
        await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({
                origin: "user_submission",
                status: "accepted",
                sessionId: captured.sessionId ?? SESSION_ID,
                runId: randomUUID(),
                messageId: randomUUID(),
            }),
        });
    });
    return { current: () => captured };
}

test.describe("PLAN-0659 T1.3 — 投递语义", () => {
    test.beforeEach(async ({ page }) => {
        // `holdOpen`：本判据只需要「发送成功 + 消息落地」，不需要助手回答。默认的
        // `retry:` 空体在连接建立后会立刻断开，`sendMessage` 偶发误判
        // "SSE connection not established" 而根本不发请求（实测 4 次里 1 次复发）；
        // 把流保持打开让"发送真的发生"这一步变确定。
        await setupMockAuth(page, { sse: { tokens: [], holdOpen: true } });
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "投递语义" }],
        });
        await setupMockParticipants(page, SESSION_ID);
        await stubDerivedState(page, SESSION_ID);
    });

    test("发送→A · 被@ 高亮 · 抄送→B；@ 不重复进抄送", async ({ page }) => {
        await openMockSession(page, SESSION_ID);
        await closeMonitorDockTab(page);

        // 「发送」栏默认预选 PRIMARY（Owner One）。
        await expect(page.getByTestId("speak-as-chip").first()).toContainText("Owner One");
        // 抄送：展开并选 Viewer Three。
        await page.getByTestId("cc-expand").click();
        await expect(page.getByTestId("cc-bar"), "CC bar expanded").toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });
        await page.getByTestId("cc-input").fill("Viewer");
        const ccMenu = page.getByTestId("cc-menu");
        await expect(ccMenu, "CC typeahead opens").toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await ccMenu.getByRole("option").first().click();
        await expect(page.getByTestId("cc-chip"), "one CC chip").toHaveCount(1, {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(page.getByTestId("cc-chip").first()).toContainText("Viewer Three");

        // 正文里 @Member Two（@ = to-audience），发送（点发送按钮：Enter 在 CC 栏刚交互后
        // 偶发被 combobox 抢焦点，判据不该赌键盘焦点）。
        const input = page.getByTestId("chat-input");
        await input.fill("请 @Member Two 一起看这个改动");
        // 正文里出现 `@名字` 会打开触发候选面，候选面会吃掉 Enter/首次点击（草稿留着的
        // 假失败）。先 Escape 关掉；**真正的判据**是下面的 POST body 断言，不是这一步。
        await page.keyboard.press("Escape");
        const chatPost = await captureChatPost(page);
        await page.getByTestId("chat-send-button").click();

        // wire 级：发送真的发生了，且投递语义（@ / cc / asParticipantId）在 body 里。
        await expect
            .poll(() => Boolean(chatPost.current()), { timeout: EXPECT_TIMEOUT_MS })
            .toBe(true);
        const payload = chatPost.current()!;
        expect(payload.sessionId).toBe(SESSION_ID);
        expect(payload.content).toContain("@Member Two");
        expect(payload.asParticipantId, "发送主体 = TO 栏选中者").toBe("part-owner");
        expect(payload.cc, "抄送名单随消息发出").toContain("part-viewer");
        // 发送成功的最小本地投影：草稿被清空、消息落地且正文带 @ 段落。
        await expect(input).toHaveValue("");
        await expect(page.locator('[data-testid="message-item"]').first()).toContainText(
            "@Member Two",
        );

        const delivery = page.getByTestId("message-delivery");
        await expect(delivery, "投递行随消息渲染").toBeVisible({ timeout: EXPECT_TIMEOUT_MS });

        // 三态只保留可持久部分：**BL-239 已知缺口** —— TO/CC 无持久载体，server 回包
        // 替换乐观消息后 message-delivery-to 会丢失（MessageItem.vue:366 v-if deliveryToNames）。
        // 修复前不断言 TO；被 @ 与抄送仍从消息 + roster 派生，继续断言。
        const mention = page.getByTestId("message-delivery-mention");
        await expect(mention).toHaveText("@Member Two");
        await expect(mention).toHaveAttribute("title", "被 @：Member Two");
        // 高亮 = 前景色 + 底/边框 chip（不是靠新增色值区分，颜色中立裁定）。
        const mentionClass = (await mention.getAttribute("class")) ?? "";
        expect(mentionClass).toContain("text-foreground");
        expect(mentionClass).toContain("border-border");

        await expect(page.getByTestId("message-delivery-cc")).toContainText("抄送→");
        await expect(page.getByTestId("message-delivery-cc")).toContainText("Viewer Three");
        // 三态去重：被 @ 的人不再出现在抄送名单里。
        await expect(page.getByTestId("message-delivery-cc")).not.toContainText("Member Two");

        await captureEvidence(page, "t1.3-delivery-header");
    });
});
