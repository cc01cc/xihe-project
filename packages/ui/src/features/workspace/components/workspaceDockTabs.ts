import type { DockTabId } from "../../../composables/useWorkspaceLayout";
import { SESSION_CONFIG_VIEW, paneTabSessionId, paneTabView } from "../lib/panelTabs";

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
    /**
     * `D-1777`/`D-1778`（task-65 A 段）：`files` = **目录树的面板身份**。
     *
     * <p>为什么树要有一个面板 id 而不是留在"固定列"：用户 2026-11-17 明言「两栏各自是一个容器」
     * 且「中栏有的组件右栏也都有」⇒ 可判形式是「任意面板都能投进任一容器」。树若不做面板，
     * 它就是唯一投不进去的东西，等价性只有它这一处破口（`D-1778`）。</p>
     */
    files: "workspace.panelFiles",
    changes: "workspace.panelChanges",
    monitor: "workspace.panelMonitor",
    members: "workspace.panelMembers",
    agents: "workspace.panelAgents",
    delegation: "workspace.panelDelegation",
};

/**
 * task-138：`session-config` 容器页签的 i18n key。
 *
 * <p>task-6（`D1453` / N-6 选 A）之后它是**会话设置唯一的面板页签**：旧的静态 `context`
 * 页签（与 `workspace.panelContext`）已退役，两者本体本就是同一份 `SessionContextPanel`。
 * 名字仍单独一条而**不是**复用旧 key ——`panelContext` 已随页签删除（i18n 无残留），
 * 产品文案也一直分称「会话设置」（页签内标题）/「会话配置」（页签标签）。</p>
 */
export const SESSION_CONFIG_LABEL_KEY = "workspace.panelSessionConfig";

/**
 * 页签 id → 已本地化标签（task-138 第三形态 `pane:<container>:<view>[:<sid>]`）。
 *
 * <p><b>为什么不能直接查 `DOCK_TAB_LABEL_KEYS[id]`</b>：那张表按**面板身份**建键，而 pane id
 * 带容器与会话后缀 ⇒ 直接查是 `undefined`，`t(undefined)` 会把页签渲染成空标签。</p>
 *
 * <p><b>口径</b>：静态 view 按 view 取标签（**容器不参与**，同一组件在两栏同名）；`session-config`
 * 额外拼上会话 id 前 8 位，否则同一容器里两份会话配置页签完全同名、用户无法分辨。非法/未知 id
 * 原样回显 —— 宁可露出 id，也不要渲染空标签。</p>
 */
export function dockTabLabel(id: string, translate: (key: string) => string): string {
    const view = paneTabView(id);
    if (view === null) {
        const key = (DOCK_TAB_LABEL_KEYS as Record<string, string | undefined>)[id];
        return key === undefined ? id : translate(key);
    }
    if (view === SESSION_CONFIG_VIEW) {
        const base = translate(SESSION_CONFIG_LABEL_KEY);
        const sessionId = paneTabSessionId(id);
        return sessionId === null ? base : `${base} · ${sessionId.slice(0, 8)}`;
    }
    const key = (DOCK_TAB_LABEL_KEYS as Record<string, string | undefined>)[view];
    return key === undefined ? view : translate(key);
}
