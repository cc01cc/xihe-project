package com.cc01cc.p.xihe.cp.auth;

import java.util.List;

/**
 * PLAN-0610 W3-2b (decision #22): the capability projection that replaces every legacy
 * {@code role} string on the wire. {@code /api/v1/auth/me}, the login/register user object and the
 * admin user views all carry this shape; the UI derives {@code isAdmin} from
 * {@link #isInstanceAdmin()} instead of comparing against {@code "ADMIN"}.
 *
 * @param isInstanceAdmin   {@code cap:instance:admin} (implies instance administration)
 * @param isInstanceSuper   {@code cap:instance:super} (the built-in SUPER_ADMIN binding)
 * @param workspaceAdminOf  workspace ids the subject administers (sorted, stable)
 */
public record CapabilitiesView(boolean isInstanceAdmin, boolean isInstanceSuper,
                               List<String> workspaceAdminOf) {

    public static final CapabilitiesView NONE = new CapabilitiesView(false, false, List.of());

    public CapabilitiesView {
        workspaceAdminOf = workspaceAdminOf == null ? List.of() : List.copyOf(workspaceAdminOf);
    }
}
