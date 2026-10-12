import { expect, test } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

const SESSION_ID = "budget-exhausted-session";

/**
 * PLAN-0492 T3.1/T3.2: a budget-exhausted run surfaces the localized reason
 * (dimension from the CP's `budgetDimension=<dim>` error detail) plus the
 * takeover hint, and the session stays resumable from the same input.
 *
 * `holdOpen` keeps the mocked `/api/v1/events` stream open after the first
 * POST so the transport stays connected; the second POST then streams a normal
 * done (the error is one-shot), proving the takeover path.
 */
test.describe("Run budget exhaustion surface", () => {
    test("shows the localized turns reason and keeps the resume entry open", async ({ page }) => {
        await setupMockAuth(page, {
            sse: {
                tokens: ["Working ", "on ", "it..."],
                errorAfterTokens: {
                    code: "RUN_BUDGET_EXHAUSTED",
                    detail: "budgetDimension=turns",
                    dimension: "turns",
                    retryable: false,
                    outcome: "error",
                },
                holdOpen: true,
            },
        });
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "Budget" }],
        });

        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
        const input = page.locator('[data-testid="chat-input"]');
        await expect(input).toBeVisible({ timeout: 5000 });
        await input.fill("keep looping until the budget stops you");
        await input.press("Enter");

        const error = page.locator('[data-testid="message-error"]');
        await expect(error).toBeVisible({ timeout: 5000 });
        await expect(error).toContainText("RUN_BUDGET_EXHAUSTED");
        await expect(error).toContainText("budgetDimension=turns");
        await expect(error).toContainText("本次运行已达到轮数上限");
        await expect(page.locator('[data-testid="message-budget-exhausted-hint"]')).toContainText(
            "可在下方输入框继续发送，接续本次会话",
        );
        await expect(page.locator('[data-testid="message-retry-button"]')).toHaveCount(0);

        // Takeover entry: the same input accepts a follow-up message and the
        // session returns to a normal (non-error) stream.
        await expect(input).toBeEnabled();
        await input.fill("resume after the budget");
        await input.press("Enter");
        await expect(page.locator("text=resume after the budget")).toBeVisible({ timeout: 5000 });
        await expect(page.locator("text=Working on it...").first()).toBeVisible({ timeout: 10000 });

        await page.screenshot({ path: "test-results/run-budget-exhausted.png", fullPage: true });
    });

    test("keeps the exhaustion surface readable on a mobile viewport", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await setupMockAuth(page, {
            sse: {
                tokens: ["partial"],
                errorAfterTokens: {
                    code: "RUN_BUDGET_EXHAUSTED",
                    detail: "budgetDimension=elapsed",
                    dimension: "elapsed",
                    retryable: false,
                    outcome: "error",
                },
                holdOpen: true,
            },
        });
        await setupMockSessions(page, {
            sessions: [{ id: SESSION_ID, title: "Budget" }],
        });

        await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
        const input = page.locator('[data-testid="chat-input"]');
        await expect(input).toBeVisible({ timeout: 5000 });
        await input.fill("long running task");
        await input.press("Enter");

        const error = page.locator('[data-testid="message-error"]');
        await expect(error).toBeVisible({ timeout: 5000 });
        await expect(error).toContainText("本次运行已达到累计耗时上限");
        const hint = page.locator('[data-testid="message-budget-exhausted-hint"]');
        await expect(hint).toBeVisible();

        const errorBox = await error.boundingBox();
        expect(errorBox).not.toBeNull();
        expect(errorBox!.x + errorBox!.width).toBeLessThanOrEqual(390 + 1);

        await page.screenshot({
            path: "test-results/run-budget-exhausted-mobile.png",
            fullPage: true,
        });
    });
});
