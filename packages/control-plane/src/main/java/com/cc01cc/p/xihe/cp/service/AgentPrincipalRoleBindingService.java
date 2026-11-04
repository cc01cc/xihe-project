package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomLabels;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * PLAN-0667 M1: the agent-principal <b>role binding</b> surface.
 *
 * <p>Why a service of its own instead of widening {@code BindingAdminService}: the user binding
 * surface (PLAN-0610) is a full-replacement set operation with owner/last-super-admin invariants
 * that say nothing about an agent principal. This surface is a small row-level CRUD whose whole
 * contract is "one binding in, one materialization out", so the two are kept apart (design D1(b);
 * {@code BindingController} stays user-only and unchanged).</p>
 *
 * <p>Invariants enforced here, not in the controller:</p>
 * <ol>
 *   <li><b>Forbidden atoms</b> — a role carrying any atom of
 *       {@link PermissionAtomCatalog#agentPrincipalForbiddenAtoms()} is refused with
 *       {@code 409 AGENT_PRINCIPAL_FORBIDDEN_ATOMS}; the detail lists atom <em>names</em> only
 *       (never resources). The list is consumed from the catalog, never copied (T0.4).</li>
 *   <li><b>Seed roles are immutable</b> — deleting a binding whose role has {@code is_system=true}
 *       answers {@code 409 ROLE_BINDING_IMMUTABLE}, because such a binding is part of the agent's
 *       baseline capability.</li>
 *   <li><b>No duplicate rows</b> — the same (role, principal, scope) answers
 *       {@code 409 ROLE_BINDING_EXISTS} before the unique key would surface as a 500.</li>
 *   <li><b>Immediate effect</b> — every write calls {@link RoleGrantMaterializer#materializeSubject}
 *       <b>in the same transaction</b>, so the agent's next session already evaluates the new
 *       grants. This is the property M4 checks on the real stack; it is asserted here first
 *       (integration test), because "materialization latency" is exactly the kind of bug that only
 *       shows up hours later otherwise.</li>
 * </ol>
 */
@Service
public class AgentPrincipalRoleBindingService {

    private static final Logger logger = LoggerFactory.getLogger(AgentPrincipalRoleBindingService.class);

    static final String RESOURCE_TYPE = "role_binding";
    static final String AUDIT_BIND = "agent_principal_role_bind";
    static final String AUDIT_UNBIND = "agent_principal_role_unbind";
    /**
     * The list never dumps the whole permission surface: {@code atoms} carries at most this many
     * localized labels while {@code atomCount} carries the real size (Lead ruling 2026-11-05: the UI
     * shows the first three plus "共 N 个"; the panel must not become a permission catalogue).
     */
    static final int ATOM_SUMMARY_LIMIT = 12;

    private final AccessRoleBindingRepository bindings;
    private final AccessRoleRepository roles;
    private final AccessRolePermissionRepository permissions;
    private final AgentPrincipalRepository principals;
    private final WorkspaceRepository workspaces;
    private final RoleGrantMaterializer materializer;
    private final AuditLogger audit;

    public AgentPrincipalRoleBindingService(AccessRoleBindingRepository bindings,
                                            AccessRoleRepository roles,
                                            AccessRolePermissionRepository permissions,
                                            AgentPrincipalRepository principals,
                                            WorkspaceRepository workspaces,
                                            RoleGrantMaterializer materializer,
                                            AuditLogger audit) {
        this.bindings = bindings;
        this.roles = roles;
        this.permissions = permissions;
        this.principals = principals;
        this.workspaces = workspaces;
        this.materializer = materializer;
        this.audit = audit;
    }

    /**
     * One binding as the API shows it.
     *
     * <p>{@code atoms} are <b>localized short labels</b> (from {@link PermissionAtomLabels}) of the
     * role's derived atoms, capped at {@link #ATOM_SUMMARY_LIMIT}; {@code atomCount} is the real
     * distinct count. Both are needed: labels alone would let the list grow into a full permission
     * dump, a count alone would tell the user nothing about what the role can do.</p>
     */
    public record AgentRoleBindingView(UUID bindingId, UUID principalId, UUID roleId, String name,
                                       String displayName, String description, String scopeType,
                                       UUID scopeId, String scopeName, boolean isSystem, int atomCount,
                                       List<String> atoms, UUID grantedBy, Instant grantedAt) {
    }

    @Transactional(readOnly = true)
    public List<AgentRoleBindingView> list(UUID principalId, String locale) {
        return viewOf(bindings.findBySubjectTypeAndSubjectId(
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId), locale);
    }

    /**
     * Bind one role to one agent principal and materialize the subject in the same transaction.
     *
     * @param auditWorkspaceId authorization/audit context (may be {@code null} for an instance-scope
     *                         call); it is never part of the binding key — the binding carries its own
     *                         {@code scope_type}/{@code scope_id}.
     */
    @Transactional
    public AgentRoleBindingView bind(UUID principalId, UUID roleId, String scopeType, UUID scopeId,
                                     UUID actorUserId, String auditWorkspaceId, String locale) {
        AccessRole role = roles.findById(roleId).orElseThrow(() -> new CpApiException(
                HttpStatus.NOT_FOUND, "ROLE_NOT_FOUND", "Role not found"));
        AccessScope scope = requireScope(scopeType, scopeId);
        requireBindableAtoms(roleId);
        requirePrincipal(principalId);
        boolean duplicate = bindings.findBySubjectTypeAndSubjectId(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId).stream()
                .anyMatch(row -> roleId.equals(row.getRoleId())
                        && scope.type().equals(row.getScopeType())
                        && Objects.equals(scope.id(), row.getScopeId()));
        if (duplicate) {
            throw new CpApiException(HttpStatus.CONFLICT, "ROLE_BINDING_EXISTS",
                    "this agent principal already has that role binding in that scope");
        }
        AccessRoleBinding row = new AccessRoleBinding(roleId,
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId, scope.type(), scope.id(), actorUserId);
        row.setId(UUID.randomUUID());
        row.setGrantedAt(Instant.now());
        AccessRoleBinding saved = bindings.saveAndFlush(row);

        materializer.materializeSubject(GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId,
                actorUserId, auditWorkspaceId);
        audit.recordDurableChange(actorUserId.toString(), auditWorkspaceId, AUDIT_BIND, RESOURCE_TYPE,
                saved.getId().toString(), auditDetail(roleId, saved.getId(), principalId, "bound"));
        logger.info("[POLICY] event=agent_principal_role_bind principalId={} roleId={} scope={}:{} actor={}",
                principalId, roleId, scope.type(), scope.id(), actorUserId);
        return viewOf(saved, role, locale);
    }

    /**
     * Unbind one row. The caller's workspace right is resolved <b>from the row's own scope</b>
     * ({@code canManageWorkspace}), because a blanket "manages every workspace" flag passed from the
     * controller would let any workspace manager delete another workspace's binding.
     */
    @Transactional
    public void unbind(UUID principalId, UUID bindingId, UUID actorUserId, String auditWorkspaceId,
                       boolean instanceTier, java.util.function.Predicate<UUID> canManageWorkspace) {
        AccessRoleBinding row = bindings.findById(bindingId)
                .filter(candidate -> GrantPrincipalPathResolver.AGENT_PRINCIPAL.equals(
                        candidate.getSubjectType()))
                .filter(candidate -> principalId.equals(candidate.getSubjectId()))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "ROLE_BINDING_NOT_FOUND",
                        "Role binding not found"));
        if (AccessScope.WORKSPACE.equals(row.getScopeType()) && !instanceTier
                && (row.getScopeId() == null || !canManageWorkspace.test(row.getScopeId()))) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "MANAGE_WORKSPACE_AGENTS is required in this binding's workspace");
        }
        AccessRole role = roles.findById(row.getRoleId()).orElseThrow(() -> new CpApiException(
                HttpStatus.NOT_FOUND, "ROLE_NOT_FOUND", "Role not found"));
        if (role.isSystem()) {
            throw new CpApiException(HttpStatus.CONFLICT, "ROLE_BINDING_IMMUTABLE",
                    "a seed role binding cannot be removed from an agent principal");
        }
        bindings.delete(row);
        bindings.flush();
        String rowWorkspaceId = AccessScope.WORKSPACE.equals(row.getScopeType()) && row.getScopeId() != null
                ? row.getScopeId().toString() : auditWorkspaceId;
        materializer.materializeSubject(GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId,
                actorUserId, rowWorkspaceId);
        audit.recordDurableChange(actorUserId.toString(), rowWorkspaceId, AUDIT_UNBIND, RESOURCE_TYPE,
                bindingId.toString(), auditDetail(row.getRoleId(), bindingId, principalId, "unbound"));
        logger.info("[POLICY] event=agent_principal_role_unbind principalId={} bindingId={} actor={}",
                principalId, bindingId, actorUserId);
    }

    /** The principal must exist and be enabled; a disabled/missing one answers one stable 404. */
    public AgentPrincipal requirePrincipal(UUID principalId) {
        AgentPrincipal principal = principals.findById(principalId)
                .orElseThrow(AgentPrincipalRoleBindingService::principalNotFound);
        if (principal.getDisabledAt() != null) {
            throw principalNotFound();
        }
        return principal;
    }

    /** Workspace existence check for a workspace-scoped binding (404 before any write). */
    public void requireWorkspace(UUID workspaceId) {
        if (workspaces.findById(workspaceId).isEmpty()) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND", "Workspace not found");
        }
    }

    private void requireBindableAtoms(UUID roleId) {
        List<String> forbidden = forbiddenAtomsOf(roleId);
        if (!forbidden.isEmpty()) {
            // Contract: atom NAMES only, never the resources they would open.
            throw new CpApiException(HttpStatus.CONFLICT, "AGENT_PRINCIPAL_FORBIDDEN_ATOMS",
                    "role carries atoms an agent principal may never hold: " + String.join(",", forbidden));
        }
    }

    /** The forbidden atoms of one role, in catalog order (empty when the role is bindable). */
    public List<String> forbiddenAtomsOf(UUID roleId) {
        java.util.Set<String> catalog = PermissionAtomCatalog.agentPrincipalForbiddenAtoms();
        List<String> forbidden = new ArrayList<>();
        for (AccessRolePermission permission : permissions.findByIdRoleId(roleId)) {
            String atom = permission.actionClass();
            if (atom != null && catalog.contains(atom)) {
                forbidden.add(atom);
            }
        }
        return forbidden;
    }

    private static AccessScope requireScope(String scopeType, UUID scopeId) {
        try {
            return new AccessScope(scopeType, scopeId);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "scopeType must be instance (no scopeId) or workspace (scopeId required)", e);
        }
    }

    private static CpApiException principalNotFound() {
        return new CpApiException(HttpStatus.NOT_FOUND, "AGENT_PRINCIPAL_NOT_FOUND",
                "Agent principal not found");
    }

    private List<AgentRoleBindingView> viewOf(List<AccessRoleBinding> rows, String locale) {
        if (rows.isEmpty()) {
            return List.of();
        }
        Map<UUID, AccessRole> byId = new LinkedHashMap<>();
        for (AccessRole role : roles.findAllById(rows.stream().map(AccessRoleBinding::getRoleId).toList())) {
            byId.put(role.getId(), role);
        }
        List<AgentRoleBindingView> views = new ArrayList<>(rows.size());
        for (AccessRoleBinding row : rows) {
            AccessRole role = byId.get(row.getRoleId());
            if (role != null) {
                views.add(viewOf(row, role, locale));
            }
        }
        return views;
    }

    private AgentRoleBindingView viewOf(AccessRoleBinding row, AccessRole role, String locale) {
        List<String> atomNames = new ArrayList<>();
        for (AccessRolePermission permission : permissions.findByIdRoleId(role.getId())) {
            if (permission.actionClass() != null && !atomNames.contains(permission.actionClass())) {
                atomNames.add(permission.actionClass());
            }
        }
        atomNames.sort(String::compareTo);
        int atomCount = atomNames.size();
        List<String> summary = new ArrayList<>();
        for (String atom : atomNames) {
            if (summary.size() >= ATOM_SUMMARY_LIMIT) {
                break;
            }
            summary.add(PermissionAtomLabels.label(atom, locale));
        }
        String scopeName = AccessScope.WORKSPACE.equals(row.getScopeType()) && row.getScopeId() != null
                ? workspaces.findById(row.getScopeId()).map(workspace -> workspace.getName()).orElse(null)
                : null;
        return new AgentRoleBindingView(row.getId(), row.getSubjectId(), row.getRoleId(), role.getName(),
                role.getDisplayName(), role.getDescription(), row.getScopeType(), row.getScopeId(),
                scopeName, role.isSystem(), atomCount, List.copyOf(summary), row.getGrantedBy(),
                row.getGrantedAt());
    }

    private static String auditDetail(UUID roleId, UUID bindingId, UUID principalId, String result) {
        return "{\"roleId\":\"" + roleId + "\",\"bindingId\":\"" + bindingId
                + "\",\"principalId\":\"" + principalId + "\",\"result\":\"" + result + "\"}";
    }
}