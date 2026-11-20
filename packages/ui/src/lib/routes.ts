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

/**
 * task-373 / `D-1228`：独立会话（无工作区）的聊天地址。
 * 与 `workspaceSessionPath` 并列而不是复用 —— 独立会话没有 workspace 段，也不写 tab 工作区上下文。
 */
export function standaloneChatPath(sessionId: string): string {
    return `/chat/${encodeURIComponent(sessionId)}`;
}
