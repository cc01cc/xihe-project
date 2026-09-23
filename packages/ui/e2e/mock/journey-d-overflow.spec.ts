import { expect, test } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { installContextEventStream, pushContextEvent } from "./helpers/context-events";

const SESSION_ID = "journey-d-overflow-mock";

test.describe("PLAN-0378 B: Journey D overflow surface", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Overflow" }] });
        await installContextEventStream(page);
    });

    test("shows the retry toast and official retry reply", async ({ page }) => {
        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
        await expect(page.locator('[data-testid="chat-input"]')).toBeVisible();
        await page.locator('[data-testid="chat-input"]').fill("overflow");
        await page.locator('[data-testid="chat-send-button"]').click();
        await pushContextEvent(page, "context_overflow_retry", {
            runId: "run-overflow",
            message: "retrying",
        });
        await pushContextEvent(page, "token", { content: "OVERFLOW-RETRY-OK" });
        await pushContextEvent(page, "done", { outcome: "succeeded" });

        await expect(page.getByText("上下文超限，已压缩并重试一次")).toBeVisible();
        await expect(page.getByText("OVERFLOW-RETRY-OK")).toBeVisible();
    });
});
