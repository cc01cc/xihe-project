import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

import { expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";
import { expectPlatformScreenshot } from "../helpers/visual";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

/**
 * 明暗切换（task-75 A：把「假绿」改成真链路）。
 *
 * **改前为什么是假绿**：用例先自己往 `<html>` 上塞 `dark` 类，再断言 `<html>` 有 `dark` 类 ——
 * 断言的是自己刚放进去的东西，与产品有没有把主题写进存储、刷新后还在不在**毫无关系**。
 * 「persists across page navigation」同样靠手动塞类"通过"。于是 BL-583（点深色→刷新回浅色）
 * 在这条 spec 下永远是绿的，缺陷藏了很久。
 *
 * **现在的判据**（只走 UI，不碰 DOM 类、不写存储）：
 * 1. 只在设置页点「深色/浅色」行改变主题；
 * 2. 断言两层：`html.dark` 出现（真来源）+ `--background` computed 值确实是暗色/浅色的 oklch；
 * 3. **reload 之后**再断言一次（这才是 BL-583 的直接回归点）；
 * 4. 存储只作**只读**校验（形态必须是裸值 `dark`，不是 JSON）；
 * 5. 本文件内负断言：源码里不得出现手加/手删 `dark` 类的调用（见最后一条用例）。
 *
 * 唯一的例外是本文件末尾那条"负断言"自身 —— 它用字符串拼接构造正则，避免匹配到自己。
 */

const APPEARANCE_PATH = "/settings/user/user-preference";
const THEME_KEY = "xihe-theme";
/** neutral 官方值：浅色 `--background`（`a2a24caf3` 的「面差」批把 1 档降到 0.97）/ 暗色。 */
const LIGHT_BACKGROUND = "oklch(0.97 0 0)";
const DARK_BACKGROUND = "oklch(0.145 0 0)";

const SOURCE = readFileSync(fileURLToPath(import.meta.url), "utf8");

async function backgroundColor(page: Page): Promise<string> {
    return page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
    );
}

async function storedTheme(page: Page): Promise<string | null> {
    return page.evaluate((key) => localStorage.getItem(key), THEME_KEY);
}

/** 打开设置 → 外观（配色方案 / 明暗面板），等控件真的可见再操作。 */
async function openAppearance(page: Page) {
    await page.goto(APPEARANCE_PATH, { waitUntil: "load" });
    await expect(page.getByTestId("settings-color-mode-dark")).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
}

test.describe("Theme Switching", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
    });

    test("default theme is light", async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem(
                "xihe-sessions",
                JSON.stringify([
                    {
                        id: "test-session",
                        title: "Test Session",
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    },
                ]),
            );
        });
        await page.goto("/workspace/workspace-1/chat/test-session");
        await expect(page.locator("textarea")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await expect(page.locator("html")).not.toHaveClass(/dark/);
        await expectPlatformScreenshot(page, "theme-default-light.png");
    });

    test("点「深色」⇒ html.dark 出现，且 --background 是暗色（真来源）", async ({ page }) => {
        await openAppearance(page);
        await expect(page.locator("html")).not.toHaveClass(/dark/);

        await page.getByTestId("settings-color-mode-dark").click();

        await expect(page.locator("html")).toHaveClass(/dark/);
        await expect.poll(() => backgroundColor(page)).toBe(DARK_BACKGROUND);
        // 只读校验：磁盘形态是规范裸值
        expect(await storedTheme(page)).toBe("dark");
    });

    test("刷新后仍深色（BL-583 回归）", async ({ page }) => {
        await openAppearance(page);
        await page.getByTestId("settings-color-mode-dark").click();
        await expect(page.locator("html")).toHaveClass(/dark/);

        await page.reload({ waitUntil: "load" });

        await expect(page.getByTestId("settings-color-mode-dark")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.locator("html")).toHaveClass(/dark/);
        await expect.poll(() => backgroundColor(page)).toBe(DARK_BACKGROUND);
        expect(await storedTheme(page)).toBe("dark");
    });

    test("切回浅色后刷新仍浅色（反向验证，防只会变黑不会变白）", async ({ page }) => {
        await openAppearance(page);
        await page.getByTestId("settings-color-mode-dark").click();
        await expect(page.locator("html")).toHaveClass(/dark/);

        await page.getByTestId("settings-color-mode-light").click();
        await expect(page.locator("html")).not.toHaveClass(/dark/);

        await page.reload({ waitUntil: "load" });

        await expect(page.getByTestId("settings-color-mode-light")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(page.locator("html")).not.toHaveClass(/dark/);
        await expect.poll(() => backgroundColor(page)).toBe(LIGHT_BACKGROUND);
        expect(await storedTheme(page)).toBe("light");
    });

    test("导航到别的路由后仍深色（跨路由，不只是刷新）", async ({ page }) => {
        await openAppearance(page);
        await page.getByTestId("settings-color-mode-dark").click();
        await expect(page.locator("html")).toHaveClass(/dark/);

        await page.goto("/settings/user/user-preference?tab=config", { waitUntil: "load" });
        await openAppearance(page);

        await expect(page.locator("html")).toHaveClass(/dark/);
        await expect.poll(() => backgroundColor(page)).toBe(DARK_BACKGROUND);
    });

    /**
     * 负断言（task-75 要求）：本 spec 不得自证 —— 源码里出现手加/手删 `dark` 类的调用即红。
     * 正则用字符串拼接，避免这一行的字面量匹配到自己。
     */
    test("负断言：本 spec 不手加/手删 dark 类", () => {
        const pattern = new RegExp(`${"classList"}\\.(add|remove|toggle)`);
        const hits = SOURCE.match(pattern) ?? [];
        expect(hits, `spec 内出现手改 <html> 类的调用：${hits.join(", ")}`).toHaveLength(0);
    });
});
