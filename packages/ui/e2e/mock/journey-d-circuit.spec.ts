import { expect, test } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { installContextEventStream, pushContextEvent } from "./helpers/context-events";

const SESSION_ID = "journey-d-circuit-mock";

test.describe("PLAN-0378 B: Journey D circuit surface", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Circuit" }] });
        await installContextEventStream(page);
    });

    test("shows the auto-compaction circuit warning toast", async ({ page }) => {
        await page.goto(`/chat/${SESSION_ID}`);
        await expect(page.locator('[data-testid="chat-input"]')).toBeVisible();
        await pushContextEvent(page, "context_compaction_circuit", {
            state: "open",
            reason: "no improvement",
        });

        const toast = page.getByText("自动压缩已暂停（上下文未见改善）");
        await expect(toast).toBeVisible();
        await expect(toast).toBeInViewport();
    });
});
