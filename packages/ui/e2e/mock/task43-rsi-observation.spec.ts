// task-43 (A+B): RSI S4/S5 observation probe in the mock lane.
// A stable, event-driven check that tool cards and assistant text land in the SAME
// assistant message row, plus a machine-readable receipt attachment. This spec never
// claims real-stack validation: it proves the UI read surface is capable of showing
// output when the SSE stream actually produces it.
import { randomUUID } from "node:crypto";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { installChatSessionEventStream, pushChatEvent } from "./helpers/context-events";
import { setupMockParticipants, setupMockProviderBinding } from "./helpers/session-matrix";
import { LONG_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "task43-rsi-observation";
const RUN_ID = "run-task43-rsi";
const ANSWER = "S5 mock 回答：项目是通用 Agent 运行时平台。";

test.describe("task-43 RSI observation receipt", () => {
    // task-76: pageFailures is destructured on purpose - the receipt below must read the
    // fixture's live three-channel accumulator instead of claiming a constant. The fixture is
    // already auto: true (helpers/mock-test.ts:57-82), so asking for it adds no page work.
    test("tool card and assistant answer render in one message row", async ({
        page,
        pageFailures,
    }, testInfo) => {
        await setupMockAuth(page);
        // WorkspaceShell mounts the git read face; stub its fixed request so the
        // page-failures gate measures only this spec's stream, not shell noise.
        await page.route("**/api/v1/workspaces/*/git-status", async (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ isRepository: true, entries: [] }),
            }),
        );
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
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "RSI observation" }] });
        await setupMockParticipants(page, SESSION_ID);
        await setupMockProviderBinding(page, SESSION_ID);
        await installChatSessionEventStream(page);

        await page.goto(`/workspace/${WORKSPACE_ID}/chat/${SESSION_ID}`);
        const composer = page.getByTestId("chat-input");
        await expect(composer, "composer mounts").toBeVisible({ timeout: LONG_TIMEOUT_MS });
        await composer.fill("只读取仓库根目录 README.md 第一段并一句话总结");
        await page.getByTestId("chat-send-button").click();
        await expect(page.getByText("只读取仓库根目录 README.md 第一段并一句话总结"), {
            message: "user bubble rendered",
        }).toBeVisible({ timeout: LONG_TIMEOUT_MS });

        const envelope = { runId: RUN_ID, participantId: "part-agent-alpha" };
        await pushChatEvent(page, "status", { ...envelope, status: "thinking" });
        await pushChatEvent(page, "tool_call", {
            ...envelope,
            tool: "read_file",
            toolCallId: "tool-task43-1",
            run_id: "lc-task43-1",
            arguments: { path: "README.md" },
        });
        const toolCard = page.getByTestId("tool-card").first();
        await expect(toolCard, "tool card renders from SSE tool_call").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(toolCard, "tool card exposes a stable toggle").toHaveAttribute(
            "data-tool-card",
            "read",
        );
        await expect(page.getByTestId("tool-card-toggle").first()).toBeVisible();
        await pushChatEvent(page, "tool_result", {
            ...envelope,
            tool: "read_file",
            toolCallId: "tool-task43-1",
            run_id: "lc-task43-1",
            status: "completed",
            result: "README first paragraph",
        });
        await pushChatEvent(page, "token", { ...envelope, content: ANSWER });
        await expect(page.getByText(ANSWER), "assistant answer renders").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await pushChatEvent(page, "done", { ...envelope, outcome: "success" });
        await pushChatEvent(page, "status", { ...envelope, status: "idle" });

        const assistantRows = page.locator(
            '[data-testid="message-item"][data-message-role="assistant"]',
        );
        await expect(assistantRows, "exactly one assistant row").toHaveCount(1, {
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(assistantRows.first(), "tool card and answer share the row").toContainText(
            ANSWER,
        );
        await expect(
            assistantRows.first().locator('[data-testid="tool-card"]'),
            "tool card is inside the assistant row",
        ).toHaveCount(1);
        await expect(page.getByTestId("message-error"), "no error box").toHaveCount(0);
        await expect(page.getByTestId("chat-send-button"), "composer unlocked").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });

        const assistantText = (await assistantRows.first().innerText()).trim();
        // task-76: pageFailures must be READ from the fixture, never written as a literal. The
        // old line was `pageFailures: 0` - always 0 regardless of reality, so the receipt claimed
        // "this gate ran and was clean" while proving nothing. These three arrays are filled by
        // collectPageFailures (helpers/page-failures.ts:30-48) and asserted empty in the auto
        // fixture teardown; reading them here makes the receipt report what was actually observed
        // up to the emit point (the authoritative verdict is still the teardown assertion).
        const pageFailureCount =
            pageFailures.consoleErrors.length +
            pageFailures.pageErrors.length +
            pageFailures.failedResponses.length;
        const checks = {
            toolCardVisible: await toolCard.isVisible(),
            assistantRendered: assistantText.includes(ANSWER),
            sameMessage:
                (await assistantRows.first().locator('[data-testid="tool-card"]').count()) === 1,
            noErrorMessage: (await page.getByTestId("message-error").count()) === 0,
            pageFailures: pageFailureCount,
        };
        // verdict is derived from the measured checks (task-76): before, it was the literal
        // "pass", i.e. a receipt that could not go red even if every check above read false.
        const allChecksPassed = Object.values(checks).every(
            (value) => value === true || value === 0,
        );
        const receipt = {
            schemaVersion: 1,
            verdict: allChecksPassed ? "pass" : "fail",
            lane: "mock",
            taskId: "task-43",
            sessionId: SESSION_ID,
            runId: RUN_ID,
            checks,
            // Reads are a snapshot at emit time; the authoritative emptiness assertion runs in
            // the auto fixture teardown (helpers/mock-test.ts:79). Named so nobody reads this
            // number as the final verdict of the gate.
            pageFailuresScope: "observed up to emit point; asserted in fixture teardown",
            counts: {
                assistantRows: await assistantRows.count(),
                toolCards: await page.getByTestId("tool-card").count(),
            },
            observedAt: new Date().toISOString(),
        };
        await testInfo.attach("task43-rsi-receipt", {
            body: Buffer.from(JSON.stringify(receipt, null, 2), "utf8"),
            contentType: "application/json",
        });
    });
});
