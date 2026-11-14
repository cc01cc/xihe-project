// timeout-exempt: 走完整发送路径（202 + 乐观插入），含 CC/TO chip 交互（task-124）
/**
 * task-124（源 `cp-1` 的 `task-121` 缺的那条前提）：**清空 TO chip 但保留 CC 时，UI 到底发了什么**。
 *
 * <p>结论口径（本卡只钉 UI 侧 wire，**不断言 CP 行为**）：请求体同时带两个键 ——
 * `toParticipantIds: []`（显式空，不是省略）与 `cc: [<participantId>]`（非空）。
 * CP 是否该在这格里仍给 CC 发通知属产品语义（`P-16` 待用户裁），两种裁法下「UI 确实发了」都不变。</p>
 *
 * <p>为什么必须走真浏览器：`git grep -ln toParticipantIds -- e2e` 曾经 **0 命中** ⇒ e2e 层对 TO 载荷
 * 零覆盖；单测只到 `emit`/`body` 两层，中间还隔着 `ChatPanel.handleSend` → `submitMessage` →
 * `useSSE` 三跳（任一跳把 `[]` 当 falsy 掉，单测都发现不了）。</p>
 *
 * <p>只观察 `POST /api/v1/chat` 的请求体：不 mock 业务行为、不改 CP、不改 `D-1273` 语义。</p>
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "./helpers/mock-test";
import { setupMockSendable } from "./helpers/sendable";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CHAT_URL = "/workspace/" + WORKSPACE_ID + "/chat/" + SESSION_ID;
const TEXT = "清空发送栏但保留抄送";
const TO_ID = "part-agent-alpha";
const CC_ID = "part-agent-beta";

test.describe("task-124 显式空 TO + 非空 CC 的 wire 形态", () => {
    test("删光 TO chip、保留 CC chip ⇒ toParticipantIds: [] 且 cc 非空", async ({ page }) => {
        await setupMockSendable(page, SESSION_ID);

        // 在夹具之后注册（Playwright 后注册优先）：只观察 + 回同形状 202，不改业务。
        const bodies: Record<string, unknown>[] = [];
        await page.route("**/api/v1/chat", async (route) => {
            bodies.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
            await route.fulfill({
                status: 202,
                contentType: "application/json",
                body: JSON.stringify({
                    origin: "user_submission",
                    status: "accepted",
                    sessionId: SESSION_ID,
                    runId: "run-task124-wire",
                    messageId: randomUUID(),
                }),
            });
        });

        await page.goto(CHAT_URL);
        const input = page.getByTestId("chat-input");
        await expect(input).toBeVisible({ timeout: LONG_TIMEOUT_MS });

        // 抄送栏默认收起：没渲染就先展开。
        const ccInput = page.getByTestId("cc-input");
        if ((await ccInput.count()) === 0) {
            await page.getByTestId("cc-expand").click({ timeout: ACTION_TIMEOUT_MS });
        }
        await expect(ccInput).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await ccInput.fill("Agent Beta");
        await ccInput.press(" ");
        await expect(page.getByTestId("cc-chip")).toHaveCount(1, { timeout: EXPECT_TIMEOUT_MS });

        // 先选一个 TO，再**删光**它 —— 这一删就是本用例要证的「用户意图」。
        const toInput = page.getByTestId("to-targets-input");
        await toInput.fill("Agent Alpha");
        await toInput.press(" ");
        await expect(page.getByTestId("to-targets-chip")).toHaveCount(1, {
            timeout: EXPECT_TIMEOUT_MS,
        });
        await page
            .getByTestId("to-targets-chip-remove")
            .first()
            .click({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByTestId("to-targets-chip")).toHaveCount(0, {
            timeout: EXPECT_TIMEOUT_MS,
        });

        await input.fill(TEXT);
        await page.getByTestId("chat-send-button").click({ timeout: ACTION_TIMEOUT_MS });
        await expect.poll(() => bodies.length, { timeout: LONG_TIMEOUT_MS }).toBe(1);

        const body = bodies[0]!;
        // 判据 1：显式空集必须**在**（不是省略）—— 这才是「用户清空了」的载体。
        expect(
            Object.prototype.hasOwnProperty.call(body, "toParticipantIds"),
            "清空 TO 后必须带显式空集；省略会被 CP 读成「没提收件人」",
        ).toBe(true);
        expect(body.toParticipantIds).toEqual([]);
        // 判据 2：CC 照样发（UI 没有吞掉它）。
        expect(Array.isArray(body.cc), "cc 必须存在").toBe(true);
        expect(body.cc).toEqual([CC_ID]);
        // 对照组：TO 里的那个 id 确实不在 wire 里（被删干净了，不是被误当成 CC）。
        expect(body.toParticipantIds).not.toContain(TO_ID);
    });
});
