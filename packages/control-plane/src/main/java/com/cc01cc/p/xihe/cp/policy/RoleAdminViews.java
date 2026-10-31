package com.cc01cc.p.xihe.cp.policy;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0610 W3-2a: the wire views of the access-role administration API.
 *
 * <p>They live next to the policy services (not in {@code auth/}) because the role model is owned by
 * this package; the controllers only translate HTTP. Every view is an explicit projection — the
 * entities {@code AccessRole}/{@code AccessRoleBinding} never reach the API, so an internal column
 * (for example {@code is_system}'s storage shape) cannot leak by accident.</p>
 */
public final class RoleAdminViews {

    private RoleAdminViews() {
    }

    /** One permission atom as the catalog exposes it (SSOT: {@link PermissionAtomCatalog}). */
    public record AtomView(String name, String scopeClass, boolean capability, String resource) {

        static AtomView of(PermissionAtomCatalog.Atom atom) {
            return new AtomView(atom.name(), atom.scopeClass(), atom.capability(),
                    atom.canonicalResource());
        }
    }

    /** {@code GET /api/v1/roles/catalog}: the atom vocabulary plus the bindable scope types. */
    public record CatalogView(List<AtomView> atoms, List<String> scopes) {
    }

    /** One role definition. {@code bindingCount} lets the UI disable a delete it cannot perform. */
    public record RoleView(UUID id, String name, String displayName, String description,
                           boolean system, List<AtomView> atoms, long bindingCount) {
    }

    /** One binding row as the API shows it (role name resolved, subject type pinned to user). */
    public record BindingView(UUID id, String subjectType, UUID subjectId, UUID roleId,
                              String roleName, UUID grantedBy, Instant grantedAt) {
    }

    /** {@code GET/PUT /api/v1/bindings}: the resolved scope and its complete binding set. */
    public record BindingSetView(String scopeType, UUID scopeId, List<BindingView> bindings) {
    }

    /** {@code POST /api/v1/roles} body (controller-side record keeps the parsing trivial). */
    public record RoleCreate(String name, String displayName, String description,
                             List<String> atoms) {
    }

    /** {@code PATCH /api/v1/roles/{roleId}} body; every field is optional (null = unchanged). */
    public record RoleUpdate(String name, String displayName, String description,
                             List<String> atoms) {
    }

    /** One requested binding in a {@code PUT /api/v1/bindings} full replacement. */
    public record BindingInput(String subjectType, UUID subjectId, UUID roleId) {
    }
}
