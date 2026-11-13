package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.WorkspaceMembershipService;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0610 W3-2b: the single capability projection used by {@code /auth/me}, the auth responses and
 * the admin user views, plus the self-service effective-permission summary of
 * {@code GET /api/v1/me/permissions}.
 *
 * <p>Two sources only, never {@code users.role}:</p>
 * <ul>
 *   <li>{@link AuthzContext} — capability atoms ({@code instance:super}/{@code instance:admin}/
 *       {@code workspace:admin}) resolved from role bindings, including the instance-admin
 *       "every workspace" implication of decision #15;</li>
 *   <li>materialized {@code grants} rows restricted to {@link GrantSources#EVALUATION_SOURCES},
 *       exactly the set the authorization gate reads.</li>
 * </ul>
 */
@Service
public class CapabilityProjectionService {

    private final AuthzContext authzContext;
    private final AuthorizationGrantRepository grants;
    private final WorkspaceMembershipService memberships;
    private final WorkspaceRepository workspaces;

    public CapabilityProjectionService(AuthzContext authzContext,
                                       AuthorizationGrantRepository grants,
                                       WorkspaceMembershipService memberships,
                                       WorkspaceRepository workspaces) {
        this.authzContext = authzContext;
        this.grants = grants;
        this.memberships = memberships;
        this.workspaces = workspaces;
    }

    /**
     * One effective atom as exposed to the caller (resource {@code "*"} when wildcard).
     *
     * <p>task-415 (RBAC P1-1): {@code sources} is the hit-source audit — every materialized grant row
     * that yields this atom. Atoms are grouped by {@code (actionClass, resource)}; before task-415 the
     * projection emitted one entry per row, so the same atom could be listed twice.</p>
     */
    public record AtomView(String actionClass, String resource, List<AtomSource> sources) {
    }

    /**
     * task-415: where one effective atom came from. {@code source} is the grant provenance
     * ({@code role} / {@code spawn} / {@code template} / {@code credential_binding} /
     * {@code agent_default}), {@code roleName} the bound role for {@code source=role}, and
     * {@code grantId} addresses the durable row so an audit can follow it.
     */
    public record AtomSource(String source, String roleName, String scopeType, String scopeId,
                             String grantId) {
    }

    /** Effective permissions inside one workspace, with the workspace's own role string. */
    public record WorkspacePermissions(String workspaceId, String workspaceRole,
                                       boolean workspaceAdmin, List<AtomView> permissions) {
    }

    /** {@code GET /api/v1/me/permissions} body: instance scope first, then every membership. */
    public record SelfPermissions(String userId, List<String> instanceCapabilities,
                                  List<AtomView> instancePermissions,
                                  List<WorkspacePermissions> workspaces) {
    }

    /** Capability summary for a subject (the wire replacement of the legacy {@code role}). */
    public CapabilitiesView capabilitiesFor(UUID userId) {
        if (userId == null) {
            return CapabilitiesView.NONE;
        }
        AuthzContext.Capabilities capabilities = authzContext.capabilitiesFor(userId);
        Set<UUID> adminWorkspaces = new LinkedHashSet<>();
        // PLAN-0651 T4.2 / C1 (Lead ruling 2026-11-05): the instance-admin fallback is gone; "admin of
        // every workspace" is now exactly the instance-bound `workspace:admin` capability
        // (workspaceAdminAll). The V114 seeds give ADMIN/SUPER_ADMIN that capability, so the built-in
        // matrix is unchanged; a custom role holding `instance:admin` without `workspace:admin` is
        // deliberately not covered (R9-5, pending D51-11).
        if (capabilities.workspaceAdminAll()) {
            // PLAN-0610 W4b: memberships are role bindings now (workspace_users is gone).
            for (WorkspaceMembershipService.WorkspaceRoleRef ref
                    : memberships.workspaceRolesOf(userId)) {
                adminWorkspaces.add(ref.workspaceId());
            }
        } else {
            adminWorkspaces.addAll(capabilities.workspaceAdminWorkspaces());
        }
        List<String> workspaceAdminOf = adminWorkspaces.stream()
                .map(UUID::toString)
                .sorted()
                .toList();
        return new CapabilitiesView(capabilities.isInstanceAdmin(), capabilities.isInstanceSuper(),
                workspaceAdminOf);
    }

    /** Effective capability atoms of the subject at instance scope (sorted). */
    public List<String> instanceCapabilities(UUID userId) {
        if (userId == null) {
            return List.of();
        }
        AuthzContext.Capabilities capabilities = authzContext.capabilitiesFor(userId);
        return capabilities.authorities().stream()
                .map(CapabilityProjectionService::atomOfAuthority)
                .filter(atom -> atom != null)
                .sorted()
                .toList();
    }

    /**
     * Full self-service summary: instance atoms + per-workspace atoms/capabilities.
     *
     * <p>Workspaces come from the caller's memberships (active, not deleted). An instance-admin /
     * instance-scoped {@code workspace:admin} holder is reported as {@code workspaceAdmin} for every
     * membership (decision #15 semantics: they administer every workspace).</p>
     */
    @Transactional(readOnly = true)
    public SelfPermissions permissionsFor(UUID userId) {
        if (userId == null) {
            return new SelfPermissions(null, List.of(), List.of(), List.of());
        }
        List<AtomView> instanceAtoms = atoms(grants.findScopedGrants(
                AuthzContext.SUBJECT_USER, userId, GrantSources.EVALUATION_SOURCES, null));

        List<WorkspacePermissions> workspaceViews = new ArrayList<>();
        for (WorkspaceMembershipService.WorkspaceRoleRef ref : memberships.workspaceRolesOf(userId)) {
            Map.Entry<UUID, WorkspaceMembershipService.WorkspaceRoleRef> entry =
                    Map.entry(ref.workspaceId(), ref);
            UUID workspaceId = entry.getKey();
            Workspace workspace = workspaces.findById(workspaceId).orElse(null);
            if (workspace == null || workspace.getDeletedAt() != null) {
                continue;
            }
            List<AuthorizationGrant> workspaceRows = grants.findScopedGrants(
                            AuthzContext.SUBJECT_USER, userId, GrantSources.EVALUATION_SOURCES,
                            workspaceId).stream()
                    .filter(row -> "workspace".equals(row.getScopeType()))
                    .toList();
            workspaceViews.add(new WorkspacePermissions(workspaceId.toString(),
                    entry.getValue().role().canonicalName(),
                    authzContext.canWorkspaceAdmin(userId, workspaceId),
                    atoms(workspaceRows)));
        }
        workspaceViews.sort(Comparator.comparing(WorkspacePermissions::workspaceId));
        return new SelfPermissions(userId.toString(), instanceCapabilities(userId), instanceAtoms,
                workspaceViews);
    }

    private static List<AtomView> atoms(List<AuthorizationGrant> rows) {
        // task-415: group by (actionClass, resource) and keep every contributing grant as a source.
        // The grouping is what makes the audit readable ("this atom comes from WS_OWNER and from a
        // credential binding"), and it also removes the duplicate entries the per-row projection
        // produced when two sources granted the same atom.
        Map<String, AtomView> grouped = new LinkedHashMap<>();
        for (AuthorizationGrant row : rows) {
            JsonNode permissions = row.getPermissions();
            if (permissions == null || !permissions.isArray() || permissions.isEmpty()) {
                continue;
            }
            JsonNode atom = permissions.get(0);
            String actionClass = atom.path("actionClass").asText(null);
            if (actionClass == null || actionClass.isBlank()) {
                continue;
            }
            String resource = atom.path("resource").asText(null);
            String effectiveResource = resource == null ? "*" : resource;
            AtomSource source = new AtomSource(row.getSource(), row.getRoleName(), row.getScopeType(),
                    row.getScopeId() == null ? null : row.getScopeId().toString(),
                    row.getId() == null ? null : row.getId().toString());
            String key = actionClass + '\u0000' + effectiveResource;
            AtomView existing = grouped.get(key);
            if (existing == null) {
                grouped.put(key, new AtomView(actionClass, effectiveResource, List.of(source)));
            } else {
                List<AtomSource> merged = new ArrayList<>(existing.sources());
                merged.add(source);
                grouped.put(key, new AtomView(actionClass, effectiveResource, List.copyOf(merged)));
            }
        }
        List<AtomView> atoms = new ArrayList<>(grouped.values());
        atoms.sort(Comparator.comparing(AtomView::actionClass).thenComparing(AtomView::resource));
        return atoms;
    }

    private static String atomOfAuthority(String authority) {
        if (authority == null || !authority.startsWith(PermissionAtomCatalog.AUTHORITY_PREFIX)) {
            return null;
        }
        return authority.substring(PermissionAtomCatalog.AUTHORITY_PREFIX.length());
    }
}
