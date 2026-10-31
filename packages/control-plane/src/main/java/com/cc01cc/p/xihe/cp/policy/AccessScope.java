package com.cc01cc.p.xihe.cp.policy;

import java.util.UUID;

/**
 * PLAN-0610 作用域引用：{@code instance} 或 {@code workspace:<uuid>}。
 *
 * <p>Scopes are explicit and do not inherit (design #11). The same record is used for the
 * <em>request</em> scope, for a <em>binding</em> scope and for a materialized grant row, so the
 * "does this row participate in this request" question has one implementation
 * ({@link #includes(AccessScope)}) instead of a string comparison per call site.</p>
 */
public record AccessScope(String type, UUID id) {

    public static final String INSTANCE = "instance";
    public static final String WORKSPACE = "workspace";

    public static final AccessScope INSTANCE_SCOPE = new AccessScope(INSTANCE, null);

    public AccessScope {
        if (!INSTANCE.equals(type) && !WORKSPACE.equals(type)) {
            throw new IllegalArgumentException("Unknown scope type: " + type);
        }
        if (INSTANCE.equals(type) && id != null) {
            throw new IllegalArgumentException("Instance scope must not carry a scope id");
        }
        if (WORKSPACE.equals(type) && id == null) {
            throw new IllegalArgumentException("Workspace scope requires a workspace id");
        }
    }

    public static AccessScope instance() {
        return INSTANCE_SCOPE;
    }

    public static AccessScope workspace(UUID workspaceId) {
        return new AccessScope(WORKSPACE, workspaceId);
    }

    /** The request scope of a workspace-scoped request; {@code null} workspace means instance. */
    public static AccessScope forWorkspace(String workspaceId) {
        return workspaceId == null || workspaceId.isBlank()
                ? INSTANCE_SCOPE
                : workspace(UUID.fromString(workspaceId));
    }

    public boolean isInstance() {
        return INSTANCE.equals(type);
    }

    /**
     * True when a row bound to {@code rowScope} participates in a request made in this scope:
     * instance rows always participate; a workspace row only for the exact same workspace.
     */
    public boolean includes(AccessScope rowScope) {
        if (rowScope == null) {
            return false;
        }
        if (rowScope.isInstance()) {
            return true;
        }
        return !isInstance() && id.equals(rowScope.id());
    }

    @Override
    public String toString() {
        return isInstance() ? INSTANCE : WORKSPACE + ":" + id;
    }
}
