/**
 * PLAN-0659 T1.2：actor 徽标的**真浏览器证据**（mock 车道，无后端）。
 *
 * 覆盖 V2 判据「混主体线程可辨（截图 + DOM 断言）」：
 *  - SSE 事件盖 `participantId` ⇒ 助手消息归因到 Agent Alpha，身份行 + 工具卡过程行带
 *    `data-actor-principal-id` / `data-actor-kind`（身份断言认 id，不认名字文本）；
 *  - 以 Agent Beta 身份「发声」（composer 发送栏 + `asParticipantId`）⇒ 线程出现第二个
 *    主体，混主体成立后过程行才挂 actor 徽标（单主体线程不重复刷身份）。
 *
 * 注意：历史消息没有归因（BL-197），所以本 spec 必须走**真实发送 + SSE 事件**，
 * 不能用 `/messages` 历史桩造多主体——那是夹具假装，不是产品行为。
 *
 * 截图落 `XIHE_EVIDENCE_DIR`（见 `helpers/evidence.ts`）。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockParticipants } from "./helpers/session-matrix";
import { captureEvidence } from "../helpers/evidence";
import { closeMonitorDockTab, openMockSession, stubDerivedState } from "./helpers/plan0659";

const SESSION_ID = "test-session";

/** 在 composer「发送」栏把发声主体切成某个参与者（默认预选 PRIMARY = Owner One）。 */
async function speakAs(page: Page, name: string): Promise<void> {
    const field = page.getByTestId("speak-as-input");
    await field.fill(name);
    await expect(page.getByTestId("speak-as-menu"), `TO typeahead for "${name}"`).toBeVisible({
        timeout: 10_000,
    });
    await field.press("Enter");
    await expect(page.getByTestId("speak-as-chip").first()).toContainText(name);
}

test.describe("PLAN-0659 T1.2 — actor 徽标", () => {
    test.beforeEach(async ({ page }) => {
        // SSE 流盖 participantId=Agent Alpha，并在 token 后补一个 tool_call（过程行证据）。
        await setupMockAuth(page, {
            sse: {
                tokens: ["静态检查已跑完：", "2 个文件中 0 error。"],
                participantId: "part-agent-alpha",
                toolCall: { tool: "read_file", toolCallId: "tc-alpha", arguments: {} },
            },
        });
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "多主体线程" }],
        });
        await setupMockParticipants(page, SESSION_ID);
        await stubDerivedState(page, SESSION_ID);
    });

    test("助手消息归因到 Agent Alpha：身份行 + 工具卡过程行带 actor 徽标；混主体可辨", async ({
        page,
    }) => {
        await openMockSession(page, SESSION_ID);
        await closeMonitorDockTab(page);

        // 第 1 轮：以 Owner One（默认）发言 → SSE 归因给 Agent Alpha 的回复。
        const input = page.getByTestId("chat-input");
        await input.fill("先跑一下静态检查");
        await input.press("Enter");

        // 助手回复的 actor 徽标必须来自**服务端归因**（DOM 断言认 participantId）。
        const assistantBadge = page
            .locator('[data-testid="message-item"][data-message-role="assistant"]')
            .getByTestId("process-row-actor");
        await expect(assistantBadge.first(), "tool card carries the actor badge").toBeVisible({
            timeout: 15_000,
        });
        await expect(assistantBadge.first()).toHaveAttribute("data-actor-kind", "AGENT");
        await expect(assistantBadge.first()).toHaveAttribute(
            "data-actor-principal-id",
            "part-agent-alpha",
        );
        await expect(assistantBadge.first()).toContainText("Agent Alpha");
        await expect(assistantBadge.first()).toContainText("AA");
        // 消息级身份行同一主体（识别面不靠过程行徽标单独承担）。
        const identityDot = page
            .locator('[data-testid="message-item"][data-message-role="assistant"]')
            .getByTestId("message-responder-initials")
            .first();
        await expect(identityDot).toHaveAttribute("data-actor-principal-id", "part-agent-alpha");

        // 第 2 轮：以 Agent Beta 身份发声 → 线程里出现第二个主体。
        await speakAs(page, "Agent Beta");
        await input.fill("Beta 也复核一下这个结论");
        await input.press("Enter");
        await expect(
            page.getByTestId("message-responder").filter({ hasText: "Agent Beta" }),
            "second principal speaks in the same thread",
        ).toBeVisible({ timeout: 15_000 });

        // 混主体线程里 1 号主体的过程行徽标仍在（不是只在「当前主体」上标）。
        await expect(assistantBadge.first()).toHaveAttribute(
            "data-actor-principal-id",
            "part-agent-alpha",
        );

        await captureEvidence(page, "t1.2-actor-badge");
    });
});
