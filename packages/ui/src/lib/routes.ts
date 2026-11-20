import type { WorkspacePageMeta } from "./workspacePages";

/**
 * 工作台模块的 **picker 入口**（旧模块 URL `/workspace`）：路由表把它声明成 redirect 记录
 * （⇒ `/workbench` 的 `workspace-home`，无 tab 上下文时渲染 `WorkspacePicker`）。
 *
 * <p><b>为什么是一处定义</b>：这个路径有两个互不相邻的消费者 —— ① 路由表的 redirect 记录；
 * ② `lib/lastLocation.ts#isExplicitPickerEntry`（task-111 / H4-c：**冷启显式进 picker 不是
 * 恢复入口**，否则上一跳会劫持用户「我要选择面」的显式意图；站内到达已由 task-145 ① 的冷启
 * 判据整体挡住）。两处各写一个字面量时，改名不会有任何红点，只会让 H4-c 判据静默失效
 * （`redirectedFrom.path` 再也对不上）。</p>
 */
export const WORKSPACE_PICKER_PATH = "/workspace";

export function workspacePath(workspaceId: string): string {
    return `/workspace/${encodeURIComponent(workspaceId)}`;
}

export function workspaceSessionPath(workspaceId: string, sessionId: string): string {
    return `${workspacePath(workspaceId)}/session/${encodeURIComponent(sessionId)}`;
}

export function workspaceScheduledTasksPath(workspaceId: string): string {
    return `${workspacePath(workspaceId)}/scheduled-tasks`;
}

export function workspaceSettingsPath(workspaceId: string): string {
    return `${workspacePath(workspaceId)}/settings`;
}

export function workspaceEnvironmentPath(workspaceId: string): string {
    return `${workspacePath(workspaceId)}/environment`;
}

export function workspaceResourcesPath(workspaceId: string): string {
    return `${workspacePath(workspaceId)}/resources`;
}

export function workspaceMembersPath(workspaceId: string): string {
    return `${workspacePath(workspaceId)}/members`;
}

/**
 * task-34 / D1472 ②：工作区**页级**地址（页 id 取自路由 `meta.workspacePage.id`）。
 *
 * <p><b>为什么这里要有一份页 id 清单</b>：上一跳（`lib/lastLocation.ts`）必须能把「停在哪一页」
 * 复原成地址，而它跑在 router 之外（router 反过来 import 它）⇒ 不能读 `router.resolve`。
 * 清单与路由表的一致性由**机器判据**兜底，不靠人记：`src/router/__tests__/lastLocationRestore.spec.ts`
 * 遍历 `router.getRoutes()` 的 `meta.workspacePage`，断言每页的
 * `router.resolve({ name, params }).path` 与本函数的输出逐字节相同 —— 改路径段或加页漏登记都会红。</p>
 *
 * <p>会话页（`/session/:id`）**不是**二级页：它的位置由 sessionId 表达，不进这份清单。</p>
 */
export const WORKSPACE_PAGE_IDS = [
    "sessions",
    "environment",
    "scheduled-tasks",
    "resources",
    "members",
    "settings",
] as const satisfies readonly WorkspacePageId[];

export type WorkspacePageId = WorkspacePageMeta["id"];

export function isWorkspacePageId(value: unknown): value is WorkspacePageId {
    return typeof value === "string" && (WORKSPACE_PAGE_IDS as readonly string[]).includes(value);
}

/** 页 id → 地址（`sessions` 就是裸工作区路径：会话列表页没有自己的路径段）。 */
export function workspacePagePath(workspaceId: string, page: WorkspacePageId): string {
    switch (page) {
        case "sessions":
            return workspacePath(workspaceId);
        case "environment":
            return workspaceEnvironmentPath(workspaceId);
        case "scheduled-tasks":
            return workspaceScheduledTasksPath(workspaceId);
        case "resources":
            return workspaceResourcesPath(workspaceId);
        case "members":
            return workspaceMembersPath(workspaceId);
        case "settings":
            return workspaceSettingsPath(workspaceId);
    }
}

/**
 * task-373 / `D-1228`：独立会话（无工作区）的聊天地址。
 * 与 `workspaceSessionPath` 并列而不是复用 —— 独立会话没有 workspace 段，也不写 tab 工作区上下文。
 */
export function standaloneChatPath(sessionId: string): string {
    return `/chat/${encodeURIComponent(sessionId)}`;
}
