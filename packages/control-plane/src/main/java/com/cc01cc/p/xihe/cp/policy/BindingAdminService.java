package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.InstanceOwner;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserStatus;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.InstanceOwnerRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0610 W3-2a: {@code GET/PUT /api/v1/bindings} (design §3.5).
 *
 * <p>The PUT is a <b>full replacement of one scope's user bindings</b>: the body is the complete
 * desired set; rows that are absent get deleted, new pairs get inserted. It is computed as a diff,
 * so sending the same body twice is a true no-op — no epoch bump, no audit row, no
 * re-materialization (the idempotency the contract promises).</p>
 *
 * <p>Write-time validation, in this order (a refusal leaves nothing behind — every check runs
 * before the first write):</p>
 *
 * <ol>
 *   <li>scope parsing: {@code scope=instance} must not carry a {@code scopeId};
 *       {@code scope=workspace} requires an existing, non-deleted workspace
 *       ({@code 404 WORKSPACE_NOT_FOUND});</li>
 *   <li>{@code MANAGE_ROLES} (the endpoint annotation) and, for workspace scope,
 *       {@code MANAGE_WORKSPACE_AGENTS} in that workspace ({@code 403 FORBIDDEN});</li>
 *   <li>subject existence ({@code 404 USER_NOT_FOUND}) and terminal state
 *       ({@code 409 USER_DELETED}), role existence ({@code 404 ROLE_NOT_FOUND});</li>
 *   <li>atom/scope compatibility ({@code 400 ROLE_SCOPE_MISMATCH}, decision #12 / #27);</li>
 *   <li>escalation: the caller must already hold every atom it hands out
 *       ({@code 403 PRIVILEGE_ESCALATION}).</li>
 * </ol>
 *
 * <p>Every affected subject is re-materialized in the same transaction through
 * {@link RoleGrantMaterializer#materializeSubjectWithEpochBump}: {@code source='role'} atoms are
 * reconciled, the capability cache is invalidated immediately and after completion (R2-20), and the
 * epoch moves once per subject whose set actually changed (I4).</p>
 *
 * <p>Lock order: {@code instance_owner} (instance mutex, the same first lock as the user/role admin
 * paths) → {@code users} rows (materializer, ascending id order). No {@code roles} row lock is
 * needed: role edits take the instance mutex too, so the two paths serialize on it.</p>
 */
@Service
public class BindingAdminService {

    private static final Logger logger = LoggerFactory.getLogger(BindingAdminService.class);

    private static final String SUBJECT_USER = AuthzContext.SUBJECT_USER;
    private static final String RESOURCE_TYPE = "role_binding";

    private final AccessRoleRepository roles;
    private final AccessRolePermissionRepository permissions;
    private final AccessRoleBindingRepository bindings;
    private final UserRepository users;
    private final WorkspaceRepository workspaces;
    private final InstanceOwnerRepository owners;
    private final RoleGrantMaterializer materializer;
    private final RequesterAuthority requester;
    private final AuditLogger audit;
    private final DbLockTimeout dbLockTimeout;

    public BindingAdminService(AccessRoleRepository roles,
                               AccessRolePermissionRepository permissions,
                               AccessRoleBindingRepository bindings,
                               UserRepository users,
                               WorkspaceRepository workspaces,
                               InstanceOwnerRepository owners,
                               RoleGrantMaterializer materializer,
                               RequesterAuthority requester,
                               AuditLogger audit,
                               DbLockTimeout dbLockTimeout) {
        this.roles = roles;
        this.permissions = permissions;
        this.bindings = bindings;
        this.users = users;
        this.workspaces = workspaces;
        this.owners = owners;
        this.materializer = materializer;
        this.requester = requester;
        this.audit = audit;
        this.dbLockTimeout = dbLockTimeout;
    }

    /** Resolves the {@code scope}/{@code scopeId} selector into a validated {@link AccessScope}. */
    @Transactional(readOnly = true)
    public AccessScope resolveScope(String scopeType, String scopeId) {
        String type = scopeType == null || scopeType.isBlank() ? AccessScope.INSTANCE
                : scopeType.trim().toLowerCase(Locale.ROOT);
        if (AccessScope.INSTANCE.equals(type)) {
            if (scopeId != null && !scopeId.isBlank()) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_SCOPE",
                        "scope=instance must not carry a scopeId");
            }
            return AccessScope.instance();
        }
        if (!AccessScope.WORKSPACE.equals(type)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_SCOPE",
                    "scope must be 'instance' or 'workspace'");
        }
        if (scopeId == null || scopeId.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_SCOPE",
                    "scope=workspace requires a scopeId");
        }
        UUID workspaceId;
        try {
            workspaceId = UUID.fromString(scopeId.trim());
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_SCOPE",
                    "scopeId must be a workspace UUID");
        }
        if (workspaces.findByIdAndDeletedAtIsNull(workspaceId).isEmpty()) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND",
                    "Workspace not found");
        }
        return AccessScope.workspace(workspaceId);
    }

    /** {@code GET /api/v1/bindings?scope=&scopeId=}: the complete binding set of one scope. */
    @Transactional(readOnly = true)
    public RoleAdminViews.BindingSetView list(String scopeType, String scopeId) {
        AccessScope scope = resolveScope(scopeType, scopeId);
        requester.requireManageRoles();
        if (!scope.isInstance()) {
            requester.requireWorkspaceBindingAuthority(scope.id());
        }
        return new RoleAdminViews.BindingSetView(scope.type(), scope.id(),
                viewOf(bindingsInScope(scope)));
    }

    /**
     * {@code PUT /api/v1/bindings?scope=&scopeId=}: replace the scope's user bindings with exactly
     * {@code requested} and return the resulting set.
     */
    @Transactional
    public RoleAdminViews.BindingSetView replace(String scopeType, String scopeId,
                                                 List<RoleAdminViews.BindingInput> requested) {
        dbLockTimeout.apply();
        AccessScope scope = resolveScope(scopeType, scopeId);
        requester.requireManageRoles();
        if (!scope.isInstance()) {
            requester.requireWorkspaceBindingAuthority(scope.id());
        }
        lockInstanceMutex();

        Map<BindingKey, UUID> desired = validateAndCollect(requested);

        List<AccessRoleBinding> existing = bindingsInScope(scope);
        Map<BindingKey, AccessRoleBinding> existingByKey = new LinkedHashMap<>();
        for (AccessRoleBinding binding : existing) {
            existingByKey.put(new BindingKey(binding.getSubjectId(), binding.getRoleId()), binding);
        }

        List<AccessRoleBinding> toDelete = existing.stream()
                .filter(binding -> !desired.containsKey(
                        new BindingKey(binding.getSubjectId(), binding.getRoleId())))
                .toList();
        List<Map.Entry<BindingKey, UUID>> toInsert = desired.entrySet().stream()
                .filter(entry -> !existingByKey.containsKey(entry.getKey()))
                .toList();

        if (toDelete.isEmpty() && toInsert.isEmpty()) {
            logger.info("[POLICY] event=role_bindings_unchanged scope={} scopeId={} count={}",
                    scope.type(), scope.id(), existing.size());
            return new RoleAdminViews.BindingSetView(scope.type(), scope.id(),
                    viewOf(bindingsInScope(scope)));
        }

        // Escalation and scope compatibility apply to what the request actually <b>grants</b> —
        // the added pairs. Re-stating a binding somebody already holds is not a grant, so a role
        // manager may keep an existing super-admin binding inside a full-set payload without being
        // able to mint one itself.
        requireGrantable(toInsert.stream().map(Map.Entry::getValue).toList(), scope);

        Set<UUID> affected = new LinkedHashSet<>();
        toDelete.forEach(binding -> affected.add(binding.getSubjectId()));
        toInsert.forEach(entry -> affected.add(entry.getKey().subjectId()));
        List<UUID> orderedAffected = new ArrayList<>(affected);
        orderedAffected.sort(UUID::compareTo);

        bindings.deleteAll(toDelete);
        for (Map.Entry<BindingKey, UUID> entry : toInsert) {
            bindings.save(new AccessRoleBinding(entry.getValue(), SUBJECT_USER,
                    entry.getKey().subjectId(), scope.type(), scope.id(), actorUuid()));
        }
        bindings.flush();
        requireInstanceStillHasASuperAdmin(scope);
        for (UUID subjectId : orderedAffected) {
            materializer.materializeSubject(SUBJECT_USER, subjectId, actorUuid(), null);
            bumpEpoch(subjectId);
        }
        String scopeIdValue = scope.isInstance() ? null : scope.id().toString();
        audit.recordDurableChange(actorId(), scopeIdValue, "role_bindings_replaced", RESOURCE_TYPE,
                scope.isInstance() ? "instance" : scope.id().toString(),
                "scope=" + scope.type() + " added=" + toInsert.size() + " removed=" + toDelete.size()
                        + " subjects=" + orderedAffected.size());
        logger.info("[POLICY] event=role_bindings_replaced scope={} scopeId={} added={} removed={}"
                        + " subjects={}", scope.type(), scope.id(), toInsert.size(), toDelete.size(),
                orderedAffected.size());
        return new RoleAdminViews.BindingSetView(scope.type(), scope.id(),
                viewOf(bindingsInScope(scope)));
    }

    // ── validation ──────────────────────────────────────────────────────────

    /**
     * Design §5 {@code 409 LAST_SUPER_ADMIN}: removing the last usable {@code SUPER_ADMIN} instance
     * binding is refused and rolls the whole replacement back (I1/I5). A full-set PUT is the only
     * place that can express "nobody is a super administrator any more", so the guard lives here
     * next to the write it forbids rather than in a caller.
     */
    private void requireInstanceStillHasASuperAdmin(AccessScope scope) {
        if (!scope.isInstance()) {
            return;
        }
        AccessRole superAdmin = roles.findByName(SystemAccessRoleCatalog.SUPER_ADMIN)
                .orElseThrow(() -> new IllegalStateException(
                        "System role SUPER_ADMIN is missing (V87 must have been applied)"));
        long holders = bindings.countActiveUserBindingsForRole(superAdmin.getId(),
                UserStatus.ACTIVE);
        if (holders < 1) {
            logger.warn("[POLICY] event=role_bindings_rejected reason=last_super_admin");
            throw new CpApiException(HttpStatus.CONFLICT, "LAST_SUPER_ADMIN",
                    "The instance must keep at least one usable SUPER_ADMIN binding");
        }
    }

    /** Structural validation: subject/role existence, subject type, terminal subject state. */
    private Map<BindingKey, UUID> validateAndCollect(List<RoleAdminViews.BindingInput> requested) {
        if (requested == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "bindings must be an array (send [] to clear the scope)");
        }
        Map<BindingKey, UUID> desired = new LinkedHashMap<>();
        Map<UUID, User> userCache = new LinkedHashMap<>();
        Map<UUID, AccessRole> roleCache = new LinkedHashMap<>();
        for (RoleAdminViews.BindingInput input : requested) {
            if (input == null || input.subjectId() == null || input.roleId() == null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_BINDING",
                        "every binding requires subjectId and roleId");
            }
            if (input.subjectType() != null && !SUBJECT_USER.equals(input.subjectType())) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_BINDING",
                        "only user subjects can be bound through this API");
            }
            AccessRole role = roleCache.computeIfAbsent(input.roleId(), roleId ->
                    roles.findById(roleId).orElseThrow(() -> new CpApiException(
                            HttpStatus.NOT_FOUND, "ROLE_NOT_FOUND", "Role not found: " + roleId)));
            User user = userCache.computeIfAbsent(input.subjectId(), userId ->
                    users.findById(userId).orElseThrow(() -> new CpApiException(
                            HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "User not found: " + userId)));
            if (user.getDeletedAt() != null) {
                throw new CpApiException(HttpStatus.CONFLICT, "USER_DELETED",
                        "A soft-deleted account cannot receive bindings");
            }
            BindingKey key = new BindingKey(user.getId(), role.getId());
            if (desired.put(key, role.getId()) != null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_BINDING",
                        "duplicate binding for subject " + user.getId());
            }
        }
        return desired;
    }

    /** Scope compatibility (400) and least-privilege (403) over the atoms actually being granted. */
    private void requireGrantable(java.util.Collection<UUID> roleIds, AccessScope scope) {
        Set<UUID> distinctRoles = new LinkedHashSet<>(roleIds);
        Set<String> atoms = new LinkedHashSet<>();
        if (!distinctRoles.isEmpty()) {
            for (AccessRolePermission permission : permissions.findByIdRoleIdIn(distinctRoles)) {
                atoms.add(permission.actionClass());
            }
        }
        for (String atom : atoms) {
            PermissionAtomCatalog.requireScopeCompatible(atom, scope.type());
        }
        requester.requireMayGrant(atoms, scope.id());
    }

    // ── read helpers ────────────────────────────────────────────────────────

    private List<AccessRoleBinding> bindingsInScope(AccessScope scope) {
        List<AccessRoleBinding> rows = scope.isInstance()
                ? bindings.findBySubjectTypeAndScopeType(SUBJECT_USER, AccessScope.INSTANCE)
                : bindings.findBySubjectTypeAndScopeTypeAndScopeId(SUBJECT_USER,
                AccessScope.WORKSPACE, scope.id());
        return rows.stream()
                .sorted(Comparator.comparing(AccessRoleBinding::getSubjectId)
                        .thenComparing(AccessRoleBinding::getRoleId))
                .toList();
    }

    private List<RoleAdminViews.BindingView> viewOf(List<AccessRoleBinding> rows) {
        if (rows.isEmpty()) {
            return List.of();
        }
        Set<UUID> roleIds = new LinkedHashSet<>();
        rows.forEach(binding -> roleIds.add(binding.getRoleId()));
        Map<UUID, String> roleNames = new LinkedHashMap<>();
        for (AccessRole role : roles.findAllById(roleIds)) {
            roleNames.put(role.getId(), role.getName());
        }
        List<RoleAdminViews.BindingView> views = new ArrayList<>(rows.size());
        for (AccessRoleBinding binding : rows) {
            views.add(new RoleAdminViews.BindingView(binding.getId(), binding.getSubjectType(),
                    binding.getSubjectId(), binding.getRoleId(),
                    roleNames.get(binding.getRoleId()), binding.getGrantedBy(),
                    binding.getGrantedAt()));
        }
        return views;
    }

    /**
     * The instance write mutex (same singleton row as {@code UserRoleService} /
     * {@code InstanceOwnershipService} / {@code RoleAdminService}), so binding writes serialize with
     * every other authorization write instead of deadlocking on {@code users} rows.
     */
    private void lockInstanceMutex() {
        owners.lockSingleton().orElseGet(() -> {
            logger.warn("instance_owner singleton row missing; binding writes proceed without the"
                    + " instance mutex (H2 profile)");
            return owners.save(new InstanceOwner());
        });
    }

    private static String actorId() {
        return TenantContext.getUserId();
    }

    private static UUID actorUuid() {
        String actor = actorId();
        return actor == null ? null : UUID.fromString(actor);
    }

    /**
     * I4: the affected subject's access tokens must die with its changed atom set. Uses
     * {@code User#bumpTokenVersion} (the single place that encodes the epoch contract) under the
     * same {@code FOR UPDATE} the materializer uses, and is called in ascending id order so two
     * concurrent binding writes cannot form an ABBA cycle (R2-19).
     *
     * <p>Note: W3-1 landed {@code RoleGrantMaterializer#materializeSubjectWithEpochBump} on develop
     * after this branch was cut; once the branches meet, this helper collapses into that call. It
     * stays local so this branch does not depend on a commit it does not contain.</p>
     */
    private void bumpEpoch(UUID subjectId) {
        users.findByIdForUpdate(subjectId).ifPresent(user -> {
            user.bumpTokenVersion();
            users.save(user);
            logger.info("[POLICY] event=role_binding_epoch_bump userId={} tokenVersion={}",
                    subjectId, user.getTokenVersion());
        });
    }

    /** Identity of one binding row (subject × role; the scope is the request's). */
    private record BindingKey(UUID subjectId, UUID roleId) {
    }
}


