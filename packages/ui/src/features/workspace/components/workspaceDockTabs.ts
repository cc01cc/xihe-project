import type { DockTabId } from "../../../composables/useWorkspaceLayout";

/** A dock tab as rendered by `WorkspaceDock` (label already localized). */
export interface DockTab {
    /** Tab id; the dock stays string-generic so tests and future panels can inject. */
    id: string;
    label: string;
}

/**
 * task-44（`D-1440` / A 方案）：深链 `?agent=<pid>` 要不要去开 dock 的 `agents` 页签。
 *
 * <p><b>为什么抽成纯函数</b>：它原本只是 workbench 里的一句
 * `if (principalId === null || props.isMobile) return`，而手机视口既没有 dock、布局也从不
 * 持久化 ⇒ 那条守卫在单测里**看不见、也不会红**，等于没有判据（`D-1046`）。抽出来之后
 * 「手机不动布局」由一条纯函数用例守住：把返回值改成 `true`，它就红。</p>
 */
export function shouldOpenAgentsDockFromDeepLink(
    agentId: string | null,
    isMobile: boolean,
): boolean {
    return agentId !== null && !isMobile;
}

/** i18n key per dock panel; the workbench localizes them before passing down. */
export const DOCK_TAB_LABEL_KEYS: Record<DockTabId, string> = {
    code: "workspace.panelCode",
    changes: "workspace.panelChanges",
    monitor: "workspace.panelMonitor",
    members: "workspace.panelMembers",
    context: "workspace.panelContext",
    agents: "workspace.panelAgents",
    delegation: "workspace.panelDelegation",
};
