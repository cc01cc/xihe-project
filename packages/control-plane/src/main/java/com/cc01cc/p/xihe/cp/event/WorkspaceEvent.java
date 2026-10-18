package com.cc01cc.p.xihe.cp.event;

/**
 * Workspace-scoped event envelope. File contents and directory listings never
 * cross this boundary; clients use the sequence to decide when to refresh via
 * the authoritative HTTP workspace APIs.
 *
 * <p>{@code rootId} (PLAN-0502 seam A) attributes the relative {@code path} to a
 * root. In the single-root model it equals {@code workspaceId}; multi-root
 * carries the per-root key without a contract change.
 */
public record WorkspaceEvent(
        String workspaceId,
        String rootId,
        long sequence,
        String kind,
        String path,
        String changeType,
        String source,
        String reason,
        String status) {
}
