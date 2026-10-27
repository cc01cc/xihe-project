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
