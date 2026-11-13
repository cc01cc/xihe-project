export function workspacePath(workspaceId: string): string {
    return `/workspace/${encodeURIComponent(workspaceId)}`;
}

export function workspaceChatPath(workspaceId: string, sessionId: string): string {
    return `${workspacePath(workspaceId)}/chat/${encodeURIComponent(sessionId)}`;
}

export function workspaceScheduledTasksPath(workspaceId: string): string {
    return `${workspacePath(workspaceId)}/scheduled-tasks`;
}

export function workspaceSettingsPath(workspaceId: string): string {
    return `${workspacePath(workspaceId)}/settings`;
}

/**
 * task-373 / `D-1228`：独立会话（无工作区）的聊天地址。
 * 与 `workspaceChatPath` 并列而不是复用 —— 独立会话没有 workspace 段，也不写 tab 工作区上下文。
 */
export function standaloneChatPath(sessionId: string): string {
    return `/chat/${encodeURIComponent(sessionId)}`;
}
