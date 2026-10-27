package com.cc01cc.p.xihe.cp.entity;

/**
 * PLAN-0559: workspace access roles. {@code ADMIN}/{@code MEMBER} are legacy
 * stored values and canonicalize to EDITOR so existing rows keep working; the
 * member-management plan (BL-114) will own their migration/renaming.
 */
public enum WorkspaceRole {
    OWNER,
    EDITOR,
    ADMIN,
    MEMBER,
    VIEWER;

    /** Canonical role exposed through TenantContext / access decisions. */
    public String canonicalName() {
        return switch (this) {
            case OWNER -> "OWNER";
            case VIEWER -> "VIEWER";
            case EDITOR, ADMIN, MEMBER -> "EDITOR";
        };
    }

    public static boolean canWrite(String role) {
        return "OWNER".equals(role) || "EDITOR".equals(role) || "ADMIN".equals(role) || "MEMBER".equals(role);
    }

    public static boolean canManage(String role) {
        return "OWNER".equals(role);
    }
}
