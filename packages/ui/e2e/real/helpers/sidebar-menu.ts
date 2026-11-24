import { expect, type Page } from "@playwright/test";

/**
 * 侧栏区头动作菜单触发器（task-1023 起）。
 *
 * `sidebar-new-workspace`（区头 `+`）现在**一步直达**创建弹窗，不再开菜单；导入源改由紧邻的
 * chevron 触发器 `sidebar-workspace-actions` 承载。
 */
export const SIDEBAR_ACTION_TRIGGER = "sidebar-workspace-actions";

/**
 * 展开侧栏区头动作菜单（task-149）。
 *
 * `sidebar-import-source` 在 `<DropdownMenuContent>` 内，**菜单未展开时不在 DOM** ⇒ 直接
 * `getByTestId(...).click()` 在未配置 `use.actionTimeout` 时会**无限等待**（playwright.config.ts
 * 现已设 5000ms，最快也是 5s 白等）。凡点这两项，先过本 helper。
 */
export async function openSidebarActionMenu(page: Page): Promise<void> {
    await page.getByTestId(SIDEBAR_ACTION_TRIGGER).click();
    await expect(page.getByRole("menuitem").first()).toBeVisible();
}

/**
 * 展开侧栏区头动作菜单并点其中一项（点项即收起菜单；调用方接着等新的弹层出现即可）。
 */
export async function clickSidebarActionMenuItem(page: Page, testId: string): Promise<void> {
    await openSidebarActionMenu(page);
    await page.getByTestId(testId).click();
}
