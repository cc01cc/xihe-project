import { expect, test } from "./helpers/mock-test";
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
            // PLAN-0752 M4：`/settings/data` 是「有 atom」页（`WRITE_INSTANCE_CONTENT`，导出另需实例管理员）。
            // 去看 `DataControlsView` 的 `canUseInstanceData`：零能力 ⇒ 整页只渲染 403 卡片、
            // 导出/导入按钮不挂载。本 spec 不带 `setupMockAuth`（它自己 stub 全部 `/api/v1/**`），
            // 所以在这里直接种一个带实例管理员能力的能力投影。
            localStorage.setItem(
                "xihe-user",
                JSON.stringify({
                    id: "user-1",
                    email: "test@xihe.local",
                    name: "Test User",
                    capabilities: { isInstanceAdmin: true },
                }),
            );
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
