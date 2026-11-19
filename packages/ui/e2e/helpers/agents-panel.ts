import { expect, type Page } from "@playwright/test";

/**
 * 智能体管理面的**唯一入口**（task-174 A1 / D-1538，task-206 复核）。
 *
 * 历史：入口曾是工作区工具栏的 `workspace-toolbar-agents`（含 `-more-agents` 变体）。
 * 该条目随 ab564bad0 / D-1538 退役，面板本体迁到「成员页 -> 智能体页签」，
 * `WorkspaceMembersView.vue` 渲染**同一个** `WorkspaceAgentsPanel`（不复制状态），
 * 面板内 testid 不变（`workspace-agent-management-dialog` 等，D26-09 保持稳定名）。
 *
 * 本帮助器只走这条路：点二级导航的成员项（`workspace-nav-members`）-> 点页签
 * （`members-tab-agents`）-> 等面板可见。给 `workspaceId` 时直接深链成员页，
 * 省掉一次导航点击（用于「刷新后重进」这类场景）。
 *
 * 为什么不在工具栏点：那条入口已经不存在了，再按旧 testid 点必然超时；
 * dock 里的 `dock-tab-agents` 也不是入口（只有标签已开时才渲染）。
 */
export const AGENTS_PANEL_TIMEOUT_MS = 15000;

/** 成员页导航项（二级导航 `WorkspaceSecondaryNav.vue` 的 `workspace-nav-<id>` 规则）。 */
export function membersNavItem(page: Page) {
    return page.getByTestId("workspace-nav-members");
}

/** 成员页的「智能体」页签。 */
export function agentsTab(page: Page) {
    return page.getByTestId("members-tab-agents");
}

/** 面板本体（`WorkspaceAgentsPanel.vue` 的根 section；testid 是历史名，不是弹窗）。 */
export function agentsPanel(page: Page) {
    return page.getByTestId("workspace-agent-management-dialog");
}

export interface OpenAgentsPanelOptions {
    /** 直接深链该工作区的成员页；省略时在当前页点导航项。 */
    workspaceId?: string;
    /** 等待超时，默认 `AGENTS_PANEL_TIMEOUT_MS`。 */
    timeout?: number;
}

/** 打开智能体管理面；返回时面板已可见且「智能体」页签已选中。 */
export async function openAgentsPanel(
    page: Page,
    options: OpenAgentsPanelOptions = {},
): Promise<void> {
    const timeout = options.timeout ?? AGENTS_PANEL_TIMEOUT_MS;
    if (options.workspaceId) {
        await page.goto("/workspace/" + options.workspaceId + "/members", { waitUntil: "load" });
    } else if (!/\/members(\?|$)/.test(new URL(page.url()).pathname)) {
        const nav = membersNavItem(page);
        await expect(nav).toBeVisible({ timeout });
        await nav.click();
        await expect(page).toHaveURL(/\/workspace\/[^/]+\/members/, { timeout });
    }

    const tab = agentsTab(page);
    await expect(tab).toBeVisible({ timeout });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout });
    await expect(agentsPanel(page)).toBeVisible({ timeout });
}
