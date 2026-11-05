/**
 * BL-229：带工具的 run 结束后 composer 必须回到发送键（mock lane，无栈）。
 *
 * 真实 wire 形状：`tool_call`/`tool_result` 同时带 Agent 的 snake_case `run_id`（LangChain
 * 回调 id）与 CP 盖章的 camelCase `runId`（ChatRun id），而 `token`/`done`/`error` 只用后者。
 * UI 曾按 `run_id` 给 tool 事件选活气泡 ⇒ `done(runId)` 清不掉那个孤儿活 scope ⇒
 * `isStreaming()` 恒 true ⇒ InputArea 把 send 换成 stop（`chat-send-button` 从 DOM 消失，
 * 用户 62s 拿不到发送键）。
 *
 * 断言面（同根因的两个用户可见症状一起验）：
 *  1. `done(runId)` 后 `chat-send-button` 可见且 enabled、`chat-stop-button` count = 0；
 *  2. 工具卡与正文落在**同一条** assistant 消息行里（修复前是两条：孤儿工具气泡 + 正文气泡）。
 *
 * 事件通道：installContextEventStream + pushContextEvent（同 session-matrix-tools.spec）。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { randomUUID } from "node:crypto";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockParticipants, setupMockProviderBinding } from "./helpers/session-matrix";
import { installContextEventStream, pushContextEvent } from "./helpers/context-events";

const SESSION_ID = "test-session",
    /** CP 盖章的 ChatRun id：token/done 与 tool 事件的 camel `runId` 都是它。 */
    RUN_ID = "run-cp-bl229",
    /** Agent 的 LangChain 回调 id：只出现在 tool 事件的 snake `run_id` 上。 */
    AGENT_TOOL_RUN_ID = "lc-tool-1";

async function prepare(page: Page): Promise<void> {
    await setupMockAuth(page);
    // `202` 必须回一个**已知**的 ChatRun id，SSE 侧才能用同一个值对齐（真实 CP 的行为）。
    // 注册在 setupMockAuth 之后：Playwright 后注册的路由优先。
    await page.route("**/api/v1/chat", async (route) => {
        const body = route.request().postDataJSON() as { sessionId?: string } | null;
        await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({
                origin: "user_submission",
                status: "accepted",
                sessionId: body?.sessionId ?? SESSION_ID,
                runId: RUN_ID,
                messageId: randomUUID(),
            }),
        });
    });
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "BL-229 tool run" }] });
    await setupMockParticipants(page, SESSION_ID);
    await setupMockProviderBinding(page, SESSION_ID);
    await installContextEventStream(page);
    await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
    await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
        timeout: 15_000,
    });
    await page.getByTestId("chat-input").fill("跑个命令再总结");
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByText("跑个命令再总结"), "user bubble rendered").toBeVisible({
        timeout: 15_000,
    });
}

test.describe("BL-229 带工具 run 的 composer 解锁", () => {
    test("done 后发送键回来、停止键消失、工具卡与正文同一条 assistant 行", async ({
        page,
    }, testInfo) => {
        await prepare(page);

        await pushContextEvent(page, "tool_call", {
            tool: "run_command",
            arguments: { command: "dir" },
            run_id: AGENT_TOOL_RUN_ID,
            runId: RUN_ID,
            toolCallId: AGENT_TOOL_RUN_ID,
        });
        await expect(page.getByTestId("tool-card-toggle").first(), "tool card renders").toBeVisible(
            { timeout: 15_000 },
        );
        await expect(page.getByTestId("chat-stop-button"), "run is active").toBeVisible();

        await pushContextEvent(page, "tool_result", {
            tool: "run_command",
            result: "a.txt\nb.txt",
            run_id: AGENT_TOOL_RUN_ID,
            runId: RUN_ID,
            toolCallId: AGENT_TOOL_RUN_ID,
        });
        await pushContextEvent(page, "token", {
            content: "命令跑完了，目录里有两个文件。",
            runId: RUN_ID,
        });
        await expect(page.getByText("命令跑完了"), "reply text rendered").toBeVisible({
            timeout: 15_000,
        });

        await pushContextEvent(page, "done", { outcome: "success", runId: RUN_ID });

        // ① composer 解锁（BL-229 的主症状：孤儿活 scope ⇒ 停在停止键）
        await expect(page.getByTestId("chat-send-button"), "send button is back").toBeVisible({
            timeout: 15_000,
        });
        await expect(page.getByTestId("chat-stop-button"), "stop button is gone").toHaveCount(0);
        // 「可用」= 草稿非空时发送键 enabled（空输入框按产品规则本来就 disabled，见
        // InputArea.sendDisabled），所以先填一句再断言。
        await page.getByTestId("chat-input").fill("再问一句");
        await expect(
            page.getByTestId("chat-send-button"),
            "send button accepts input",
        ).toBeEnabled();

        // ② 工具卡与正文同一条 assistant 消息行（修复前两个气泡各占一条）
        const toolRows = page.locator(
            '[data-testid="message-item"]:has([data-testid="tool-card-toggle"])',
        );
        await expect(toolRows, "exactly one row carries the tool card").toHaveCount(1);
        await expect(toolRows.first(), "that row also carries the reply text").toContainText(
            "命令跑完了",
        );

        const evidenceDir = process.env.BL229_EVIDENCE_DIR;
        if (evidenceDir) {
            await page.screenshot({
                path: `${evidenceDir}/bl229-composer-unlocked.png`,
                fullPage: true,
            });
        }
        await testInfo.attach("composer-unlocked", {
            body: Buffer.from(
                JSON.stringify({
                    sessionId: SESSION_ID,
                    runId: RUN_ID,
                    agentToolRunId: AGENT_TOOL_RUN_ID,
                    assistantRows: await page.locator('[data-testid="message-item"]').count(),
                    toolRows: await toolRows.count(),
                }),
                "utf8",
            ),
            contentType: "application/json",
        });
    });
});
