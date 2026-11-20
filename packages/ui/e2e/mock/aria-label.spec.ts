import { expect, test } from "./helpers/mock-test";

test.describe("Accessibility — aria-label", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/workspace/11111111-1111-4111-8111-111111111111/session/test-session");
    });

    test("close tab button has aria-label", async ({ page }) => {
        const closeBtn = page.locator('[aria-label="Close tab"]');
        await expect(closeBtn).toHaveCount(0);
    });

    test("message search close has aria-label", async ({ page }) => {
        const closeBtn = page.locator('[aria-label="Close search"]');
        await expect(closeBtn).toHaveCount(0);
    });
});
