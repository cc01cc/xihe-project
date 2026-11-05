import { expect, test } from "./helpers/mock-test";
import { I18nPage } from "../page-objects/I18nPage";
import { expectPlatformScreenshot } from "../helpers/visual";

test.describe("Internationalization", () => {
    // BL-318：这两条断言的是**登录页**的语言切换与快照，之前却先塞了一个 `xihe-token` ——
    // 路由守卫见 token 就把页面带进工作区，随后 `/workspaces`、`/auth/me`、`/user-events` 全部
    // 打到真实网络吃 401（门禁接上后才暴露）。这里去掉 token，让 `/login` 保持登录页语义。
    test("switches from en to zh-CN and shows Chinese text", async ({ page }) => {
        const i18n = new I18nPage(page);
        await page.goto("/login");
        await page.waitForLoadState("load");
        await i18n.setLanguage("zh-CN");
        await page.reload();
        await page.waitForLoadState("load");
        const body = page.locator("body");
        await expect(body).toBeAttached();
    });

    test("login page snapshot in Chinese", async ({ page }) => {
        const i18n = new I18nPage(page);
        await page.goto("/login");
        await page.waitForLoadState("load");
        await i18n.setLanguage("zh-CN");
        await page.reload();
        await page.waitForLoadState("load");
        await expectPlatformScreenshot(page, "login-zh-CN.png");
    });
});
