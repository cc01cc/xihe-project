import { expect, test } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { installContextEventStream, pushContextEvent } from "./helpers/context-events";

const SESSION_ID = "diagnostics-mock-session";

test.describe("PLAN-0378 B: diagnostics UI rendering", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Diagnostics" }] });
        await installContextEventStream(page);
    });

    test("renders structured diagnostics and keeps raw output collapsed", async ({ page }) => {
        await page.goto(`/chat/${SESSION_ID}`);
        await expect(page.locator('[data-testid="chat-input"]')).toBeVisible();

        await page.locator('[data-testid="chat-input"]').fill("run diagnostics");
        await page.locator('[data-testid="chat-send-button"]').click();
        await pushContextEvent(page, "tool_call", {
            tool: "run_command",
            toolCallId: "tool-1",
            run_id: "run-1",
            arguments: { command: "check" },
        });
        await pushContextEvent(page, "tool_result", {
            tool: "run_command",
            toolCallId: "tool-1",
            run_id: "run-1",
            result: "src/main.rs:12:5: error: mismatched types",
            diagnostics: {
                items: [
                    {
                        file: "src/main.rs",
                        line: 12,
                        column: 5,
                        severity: "error",
                        message: "mismatched types",
                        confidence: "high",
                    },
                ],
                total: 1,
                confidence: "high",
            },
        });
        await pushContextEvent(page, "token", { content: "DIAG-VISIBLE" });
        await pushContextEvent(page, "done", { outcome: "succeeded" });

        const block = page.locator('[data-testid="tool-diagnostics"]');
        await expect(block).toBeVisible();
        await expect(block.locator('[data-testid="diagnostic-item-0"]')).toContainText(
            "src/main.rs:12:5",
        );
        await expect(block.locator('[data-testid="diagnostic-item-0"]')).toContainText(
            "mismatched types",
        );
        const toggle = page.locator('[data-testid="raw-output-toggle"]');
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expect(page.getByText("DIAG-VISIBLE")).toBeVisible();
    });
});
