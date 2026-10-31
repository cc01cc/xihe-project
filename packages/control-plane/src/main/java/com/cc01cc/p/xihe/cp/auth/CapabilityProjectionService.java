package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
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
    private final WorkspaceUserRepository workspaceUsers;
    private final WorkspaceRepository workspaces;

    public CapabilityProjectionService(AuthzContext authzContext,
                                       AuthorizationGrantRepository grants,
                                       WorkspaceUserRepository workspaceUsers,
                                       WorkspaceRepository workspaces) {
        this.authzContext = authzContext;
        this.grants = grants;
        this.workspaceUsers = workspaceUsers;
        this.workspaces = workspaces;
    }

    /** One materialized atom as exposed to the caller (resource {@code "*"} when wildcard). */
    public record AtomView(String actionClass, String resource) {
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
        if (capabilities.workspaceAdminAll() || capabilities.isInstanceAdmin()) {
            for (WorkspaceUser membership : workspaceUsers.findByIdUserId(userId)) {
                UUID workspaceId = membership.getId() == null ? null
                        : membership.getId().getWorkspaceId();
                if (workspaceId != null) {
                    adminWorkspaces.add(workspaceId);
                }
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

        Map<UUID, WorkspaceUser> memberships = new LinkedHashMap<>();
        for (WorkspaceUser membership : workspaceUsers.findByIdUserId(userId)) {
            UUID workspaceId = membership.getId() == null ? null : membership.getId().getWorkspaceId();
            if (workspaceId != null) {
                memberships.putIfAbsent(workspaceId, membership);
            }
        }

        List<WorkspacePermissions> workspaceViews = new ArrayList<>();
        for (Map.Entry<UUID, WorkspaceUser> entry : memberships.entrySet()) {
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
            WorkspaceUser membership = entry.getValue();
            workspaceViews.add(new WorkspacePermissions(workspaceId.toString(),
                    membership.getRole() == null ? null : membership.getRole().canonicalName(),
                    authzContext.canWorkspaceAdmin(userId, workspaceId),
                    atoms(workspaceRows)));
        }
        workspaceViews.sort(Comparator.comparing(WorkspacePermissions::workspaceId));
        return new SelfPermissions(userId.toString(), instanceCapabilities(userId), instanceAtoms,
                workspaceViews);
    }

    private static List<AtomView> atoms(List<AuthorizationGrant> rows) {
        List<AtomView> atoms = new ArrayList<>();
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
            atoms.add(new AtomView(actionClass, resource == null ? "*" : resource));
        }
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
