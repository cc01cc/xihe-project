package com.cc01cc.p.xihe.cp.config;

import org.springframework.http.HttpStatus;

import java.util.UUID;

public final class TenantContext {

    private static final ThreadLocal<String> currentUserId = new ThreadLocal<>();
    private static final ThreadLocal<String> currentWorkspaceId = new ThreadLocal<>();
    private static final ThreadLocal<String> currentWorkspacePath = new ThreadLocal<>();
    private static final ThreadLocal<String> currentUserRole = new ThreadLocal<>();
    private static final ThreadLocal<String> currentWorkspaceRole = new ThreadLocal<>();

    public static void setUserId(String userId) {
        currentUserId.set(userId);
    }

    public static String getUserId() {
        return currentUserId.get();
    }

    public static void setWorkspaceId(String workspaceId) {
        currentWorkspaceId.set(workspaceId);
    }

    public static String getWorkspaceId() {
        return currentWorkspaceId.get();
    }

    public static void setWorkspacePath(String path) {
        currentWorkspacePath.set(path);
    }

    public static String getWorkspacePath() {
        return currentWorkspacePath.get();
    }

    public static void setUserRole(String role) {
        currentUserRole.set(role);
    }

    public static String getUserRole() {
        return currentUserRole.get();
    }

    public static void setWorkspaceRole(String role) {
        currentWorkspaceRole.set(role);
    }

    public static String getWorkspaceRole() {
        return currentWorkspaceRole.get();
    }

    public static void clear() {
        currentUserId.remove();
        currentWorkspaceId.remove();
        currentWorkspacePath.remove();
        currentUserRole.remove();
        currentWorkspaceRole.remove();
    }

    /**
     * PLAN-0559: normalize an explicit workspace id from a header/query value.
     * Blank means "not provided"; malformed values are a client error, never a
     * 500 from {@link UUID#fromString(String)}.
     */
    public static String normalizeWorkspaceId(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.trim()).toString();
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_WORKSPACE_ID",
                    "X-Workspace-Id must be a UUID");
        }
    }

    /**
     * PLAN-0559: reject explicit workspace ids that do not match the effective
     * request context instead of letting a query/header silently override it.
     */
    public static void requireWorkspaceMatches(String value) {
        if (value == null || value.isBlank()) {
            return;
        }
        String normalized;
        try {
            normalized = UUID.fromString(value.trim()).toString();
        } catch (IllegalArgumentException e) {
            // Let the caller keep its own malformed-id error shape (e.g.
            // INVALID_REQUEST vs INVALID_WORKSPACE_ID for the tenant header).
            return;
        }
        if (!normalized.equalsIgnoreCase(currentWorkspaceId.get())) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "WORKSPACE_FORBIDDEN",
                    "Workspace access denied");
        }
    }

    private TenantContext() {}
}
