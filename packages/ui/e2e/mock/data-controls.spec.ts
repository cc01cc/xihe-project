import { test, expect } from "@playwright/test";
import { expectPlatformScreenshot } from "../helpers/visual";

test.describe("Data Controls", () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem("xihe-token", "mock-token");
            // PLAN-0602: `xihe-language` persists as a RAW string and is applied on boot
            // (`initLanguage` → `applyLocale`), so `"en"` really does render English. The
            // assertions below read the zh-Hans copy, so the fixture must request zh-CN; seeding
            // a locale other than the copy under test is what made this spec red.
            localStorage.setItem("xihe-language", "zh-CN");
        });
    });

    test("renders export and import buttons", async ({ page }) => {
        await page.route("**/api/v1/**", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({}),
            }),
        );
        await page.route("**/api/v1/events**", (route) =>
            route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: "retry: 5000\n\n",
            }),
        );
        await page.goto("/settings/data", { waitUntil: "load" });
        await page.waitForTimeout(1000);
        await expect(page.locator('button:has-text("导出设置")')).toBeVisible();
        await expect(page.locator('button:has-text("导出聊天")')).toBeVisible();
        await expect(page.locator('button:has-text("导入")')).toBeVisible();
        await expectPlatformScreenshot(page, "data-controls-buttons.png");
    });
});
