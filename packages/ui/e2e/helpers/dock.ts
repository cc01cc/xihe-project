import { expect, type Locator, type Page } from "@playwright/test";

/**
 * task-137（D-1907 图标簇收敛）：桌面六个 `workspace-toolbar-*` 面板图标已下线，
 * 唯一入口收敛为「主列行尾开合图标 `workspace-dock-toggle` → 右栏页签行 `+` → 选面板类型」。
 *
 * 这个帮助器把「打开某个面板」收敛成一步，返回时右栏可见且目标页签已选中：
 * - dock 已收起（`aria-pressed === "false"`）⇒ 先点开合图标展开；
 * - 目标类型的页签已在行上 ⇒ 只选中它（页签点击无 toggle 副作用）；
 * - 页签不在行上 ⇒ 点右栏 `+`，在菜单里选该类型（`dock-reopen-item-<id>`，8 类型恒可用）。
 */

/** dock 面板类型 = `WorkspaceDock.vue` 右页签行「+」菜单的 8 个可选类型。 */
export type DockPanelId =
    | "files"
    | "code"
    | "changes"
    | "monitor"
    | "members"
    | "context"
    | "agents"
    | "delegation";

/** 默认等待预算：与各 spec 的 EXPECT_TIMEOUT_MS 同档。 */
const DEFAULT_TIMEOUT_MS = 15_000;
/** 主列行尾的开合图标（唯一入口；`aria-pressed` = 右栏展开态）。 */
export function dockToggle(page: Page): Locator {
    return page.getByTestId("workspace-dock-toggle");
}

/** 右栏根节点（`WorkspaceDock.vue` 的 `<aside>`）；收起时整列不渲染 ⇒ 计数为 0。 */
export function dockRoot(page: Page): Locator {
    return page.getByTestId("workspace-aux-panel");
}

/** 右栏页签行里的页签芯片（`dock-tab-<id>`，只做选中，无 toggle 副作用）。 */
export function dockTab(page: Page, id: DockPanelId | string): Locator {
    return page.getByTestId(`dock-tab-${id}`);
}

/** 右栏页签行「+」：唯一的新建页签 / 选类型入口（菜单项 = `dock-reopen-item-*`）。 */
export function dockPlus(page: Page): Locator {
    return page.getByTestId("workspace-container-plus-right");
}

/** 右栏是否展开（读开合图标的 `aria-pressed`；图标本身恒存在）。 */
export async function isDockOpen(page: Page): Promise<boolean> {
    return (await dockToggle(page).getAttribute("aria-pressed")) === "true";
}

/** 展开右栏（已展开则不动）。 */
export async function expandDock(page: Page): Promise<void> {
    if (!(await isDockOpen(page))) await dockToggle(page).click();
    await expect(dockRoot(page)).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
}

/**
 * 收起右栏（已收起则不动）。用于原先「再点一次面板图标把面板关掉」的复原段：
 * 新口径下收起 = 点开合图标，而不是点面板类型。
 */
export async function collapseDock(page: Page): Promise<void> {
    if (await isDockOpen(page)) await dockToggle(page).click();
    await expect(dockRoot(page)).toHaveCount(0);
}

/**
 * 打开（或聚焦）指定类型的右栏页签：已开则只激活，未开则走 `+` → 菜单项。
 * 幂等：面板已可见且已是活动页签时**不点任何东西**。
 */
export async function openDockPanel(
    page: Page,
    id: DockPanelId,
    options: { timeoutMs?: number } = {},
): Promise<void> {
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    await expandDock(page);
    const tab = dockTab(page, id);
    if ((await tab.count()) > 0) {
        if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click({ timeout });
    } else {
        await dockPlus(page).click({ timeout });
        const item = page.getByTestId(`dock-reopen-item-${id}`);
        await expect(item, `右栏「+」菜单里应能新建 ${id} 面板`).toBeVisible({ timeout });
        await item.click({ timeout });
    }
    await expect(tab, `${id} 页签应出现在右栏页签行`).toBeVisible({ timeout });
    await expect(tab, `${id} 页签应成为活动页签`).toHaveAttribute("aria-selected", "true", {
        timeout,
    });
}

/** 关闭指定页签（点它自己的关闭按钮）；页签本来不在行上则不动。 */
export async function closeDockPanel(page: Page, id: DockPanelId | string): Promise<void> {
    const close = page.getByTestId(`dock-tab-close-${id}`);
    if ((await close.count()) > 0) await close.first().click();
    await expect(close).toHaveCount(0);
}
