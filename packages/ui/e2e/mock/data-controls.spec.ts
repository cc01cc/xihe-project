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

    // task-376：正例的行为契约用 testid 锚（D-1225），且不带视觉门 ——
    // 上面那条视觉用例在非 linux 平台整条 skip（helpers/visual.ts:16），
    // 把 testid 断言塞进它等于在本机一条都没跑（D-1199：要证明被测路径真跑了）。
    test("mounts all four data controls when the atom is present", async ({ page }) => {
        // 能力位与原子互不蕴含（auth/CapabilityProjectionService）⇒ 测原子路径就把能力位拿掉：
        // 零能力用户 + 权威投影只带 WRITE_INSTANCE_CONTENT ⇒ 四控件应挂载。
        await page.addInitScript(() => {
            localStorage.setItem(
                "xihe-user",
                JSON.stringify({
                    id: "user-1",
                    email: "test@xihe.local",
                    name: "Test User",
                    capabilities: {},
                }),
            );
        });
        await page.route("**/api/v1/**", (route) =>
            route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
        );
        // Playwright 路由后注册者优先（LIFO）⇒ 权威投影覆盖在兜底 {} 之后。
        await page.route("**/api/v1/me/permissions**", (route) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    instancePermissions: [{ actionClass: "WRITE_INSTANCE_CONTENT" }],
                }),
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
        await expect(page.getByTestId("settings-data-export-settings")).toBeVisible();
        await expect(page.getByTestId("settings-data-export-chats")).toBeVisible();
        await expect(page.getByTestId("settings-data-import")).toBeVisible();
        // 隐藏 file input 不占可见性，只断言挂载（count 1）。
        await expect(page.getByTestId("settings-data-import-file")).toHaveCount(1);
    });

    // task-367 普查出的「真盲区」反面补钉：无 WRITE_INSTANCE_CONTENT 原子 ⇒ 四控件整块不挂载
    // （不是 disabled），门是 DataControlsView 的 `v-if=dataDenied` atom-denied 分支。
    test("unmounts all data controls without the WRITE_INSTANCE_CONTENT atom", async ({ page }) => {
        // beforeEach 种的是实例管理员；这里后写一条 init script 覆盖成零能力投影
        //（init script 按插入顺序执行，后者覆盖前者的同名键）。
        await page.addInitScript(() => {
            localStorage.setItem(
                "xihe-user",
                JSON.stringify({
                    id: "user-1",
                    email: "test@xihe.local",
                    name: "Test User",
                    capabilities: {},
                }),
            );
        });
        let retentionRequests = 0;
        await page.route("**/api/v1/**", (route) => {
            // PLAN-0752 T4.4 判据②：无权限整页 403 ⇒ 连保留期取数都不该发。
            if (route.request().url().includes("/checkpoints/retention")) retentionRequests++;
            return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        });
        await page.route("**/api/v1/events**", (route) =>
            route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
                body: "retry: 5000\n\n",
            }),
        );
        await page.goto("/settings/data", { waitUntil: "load" });
        // 三态防假 403：投影落定前只渲染标题 ⇒ 等门卡片出现再断言，不抢跑。
        await expect(page.getByTestId("settings-atom-denied")).toBeVisible();
        await expect(page.getByTestId("settings-data-export-settings")).toHaveCount(0);
        await expect(page.getByTestId("settings-data-export-chats")).toHaveCount(0);
        await expect(page.getByTestId("settings-data-import")).toHaveCount(0);
        await expect(page.getByTestId("settings-data-import-file")).toHaveCount(0);
        expect(retentionRequests).toBe(0);
    });
});
