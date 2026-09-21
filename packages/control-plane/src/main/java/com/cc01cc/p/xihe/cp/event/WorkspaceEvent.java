package com.cc01cc.p.xihe.cp.event;

/**
 * Workspace-scoped event envelope. File contents and directory listings never
 * cross this boundary; clients use the sequence to decide when to refresh via
 * the authoritative HTTP workspace APIs.
 */
public record WorkspaceEvent(
        String workspaceId,
        long sequence,
        String kind,
        String path,
        String changeType,
        String source,
        String reason,
        String status) {
}
