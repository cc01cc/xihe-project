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

    /**
     * One permission atom as the catalog exposes it (SSOT: {@link PermissionAtomCatalog}).
     *
     * <p>{@code displayName} is resolved server-side from the explicit {@code ?locale} (D51-37): the
     * wire carries one string, never a {@code {zh, en}} pair, so the UI keeps no vocabulary.</p>
     */
    public record AtomView(String name, String scopeClass, boolean capability, String resource,
                           String displayName, boolean agentPrincipalForbidden) {

        static AtomView of(PermissionAtomCatalog.Atom atom, String locale) {
            return new AtomView(atom.name(), atom.scopeClass(), atom.capability(),
                    atom.canonicalResource(), PermissionAtomLabels.label(atom.name(), locale),
                    // task-415 (RBAC P0-1): the catalog already computed this flag; the view used to
                    // drop it, so a binding UI could offer a role the CP would refuse. Projecting it
                    // lets the UI pre-disable instead of walking into AGENT_PRINCIPAL_FORBIDDEN.
                    atom.agentPrincipalForbidden());
        }
    }

    /**
     * {@code GET /api/v1/roles/catalog}: the atom vocabulary, the bindable scope types and the
     * built-in default grant sets (task-415 / RBAC P1-2).
     */
    public record CatalogView(List<AtomView> atoms, List<String> scopes,
                              List<DefaultGrantView> defaultGrants) {
    }

    /**
     * task-415 (RBAC P1-2): one built-in role's seeded default grant set, from
     * {@link SystemAccessRoleCatalog#roleSeeds()} — the code-level default, not the live DB rows
     * ({@code GET /roles} lists the rows). This is what answers "who gets a new atom by default"
     * without reading code, the default-grant half of the permission-face rule.
     */
    public record DefaultGrantView(String roleName, String displayName, String description,
                                   List<String> atoms) {
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
