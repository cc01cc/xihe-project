package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;

/**
 * PLAN-0559: single server-side classifier for workspace write/manage access.
 *
 * <p>It deliberately does not implement file/directory locks. A later lock
 * plan can acquire leases at this choke point (and the file mutation entry)
 * without changing routes or the role matrix.</p>
 */
public final class WorkspaceWriteGuard {

    public enum Requirement {
        READ,
        WRITE,
        MANAGE
    }

    private WorkspaceWriteGuard() {
    }

    public static Requirement requirement(String method, String uri) {
        String verb = method == null ? "" : method.toUpperCase();
        if ("GET".equals(verb) || "HEAD".equals(verb) || "OPTIONS".equals(verb)) {
            return Requirement.READ;
        }
        String path = normalize(uri);
        if (isOwnerOnly(verb, path)) {
            return Requirement.MANAGE;
        }
        if (isWorkspaceWrite(path)) {
            return Requirement.WRITE;
        }
        return Requirement.READ;
    }

    public static boolean allows(String canonicalRole, Requirement requirement) {
        if (requirement == Requirement.READ) {
            return canonicalRole != null;
        }
        if (requirement == Requirement.WRITE) {
            return WorkspaceRole.canWrite(canonicalRole);
        }
        return WorkspaceRole.canManage(canonicalRole);
    }

    private static boolean isOwnerOnly(String verb, String path) {
        if ("PATCH".equals(verb) || "DELETE".equals(verb)) {
            // /api/v1/workspaces/{id} (rename/delete)
            if (path.matches("^/api/v1/workspaces/[^/]+$")) {
                return true;
            }
        }
        if ("PATCH".equals(verb) && path.matches("^/api/v1/workspaces/[^/]+/execution-mode$")) {
            return true;
        }
        return "POST".equals(verb) && path.matches("^/api/v1/workspaces/[^/]+/runtime/release$");
    }

    private static boolean isWorkspaceWrite(String path) {
        return path.startsWith("/api/v1/chat/")
                || path.equals("/api/v1/chat")
                || path.matches("^/api/v1/workspaces/[^/]+/.*")
                || path.startsWith("/api/v1/workspace-imports/")
                || path.startsWith("/api/v1/policy/")
                || path.equals("/api/v1/policy")
                || path.startsWith("/api/v1/config/workspace/")
                || path.startsWith("/api/v1/agent-templates/")
                || path.equals("/api/v1/agent-templates")
                || path.equals("/api/v1/rag/ingest");
    }

    private static String normalize(String uri) {
        if (uri == null || uri.isBlank()) {
            return "/";
        }
        int query = uri.indexOf('?');
        return query >= 0 ? uri.substring(0, query) : uri;
    }
}
