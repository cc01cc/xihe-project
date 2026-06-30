package com.cc01cc.p.xihe.cp.config;

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

    private TenantContext() {}
}
