package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0610 T1.5: materializes 「主体 × 作用域」 role bindings into {@code grants(source='role')}.
 *
 * <p>Replaces {@code GrantDefaultService}'s hard-coded default sets: the atom set of a subject is
 * now the <b>union of the permissions of every role bound to it, per scope</b>, and the result is
 * written as one {@code grants} row per atom carrying the same {@code scope_type/scope_id} as the
 * binding (design #14). Evaluation then stays a one-hop read
 * ({@code AuthorizationGrantRepository#findScopedGrants}).</p>
 *
 * <p>Invariants enforced here:</p>
 *
 * <ul>
 *   <li><b>Capability atoms are never materialized</b> (design #23): they are filtered out and
 *       resolved at authentication time by {@link AuthzContext}.</li>
 *   <li><b>Scope compatibility is validated, not dropped</b> (decision #12): an atom whose
 *       {@code scope_class} does not fit the binding scope fails with
 *       {@code 400 ROLE_SCOPE_MISMATCH}; a corrupt row can never be silently ignored.</li>
 *   <li><b>Atom shape is validated</b> through
 *       {@link GrantIntersectionEvaluator.PermissionAtom}, so an unknown action class or a
 *       non-canonical credential resource fails closed instead of poisoning every evaluation.</li>
 *   <li><b>One row per atom</b> (round-2 P1-2), guarded by {@code uq_grants_role_atom}.</li>
 *   <li>Only {@code source='role'} rows of this subject are reconciled — {@code spawn},
 *       {@code template}, {@code credential_binding} and the frozen {@code agent_default}
 *       snapshot are owner-written and never touched (P1-1).</li>
 * </ul>
 *
 * <p>Single transaction: the binding write, the materialization and the caller's
 * {@code users.token_version} bump commit or roll back together (I4). Row locks are the caller's
 * responsibility ({@code AuthUserLockService} for a user subject); the unique index is the last
 * line of defence against a concurrent duplicate.</p>
 */
@Service
public class RoleGrantMaterializer {

    private static final Logger logger = LoggerFactory.getLogger(RoleGrantMaterializer.class);

    public static final String SOURCE_ROLE = "role";

    private static final String READ_STATE_READ = "read";

    /** Counts of one reconciliation run; a no-op run returns all zeros and writes no audit row. */
    public record Result(int created, int deleted, int scopes) {

        public boolean changed() {
            return created > 0 || deleted > 0;
        }
    }

    private final AccessRoleBindingRepository bindingRepository;
    private final AccessRolePermissionRepository permissionRepository;
    private final AuthorizationGrantRepository grantRepository;
    private final GrantIntersectionEvaluator evaluator;
    private final AuthzContext authzContext;
    private final AuditLogger auditLogger;
    private final ObjectMapper objectMapper;

    public RoleGrantMaterializer(AccessRoleBindingRepository bindingRepository,
                                 AccessRolePermissionRepository permissionRepository,
                                 AuthorizationGrantRepository grantRepository,
                                 GrantIntersectionEvaluator evaluator,
                                 AuthzContext authzContext,
                                 AuditLogger auditLogger,
                                 ObjectMapper objectMapper) {
        this.bindingRepository = bindingRepository;
        this.permissionRepository = permissionRepository;
        this.grantRepository = grantRepository;
        this.evaluator = evaluator;
        this.authzContext = authzContext;
        this.auditLogger = auditLogger;
        this.objectMapper = objectMapper;
    }

    /** Recomputes the subject's {@code source='role'} rows for every bound scope. */
    @Transactional
    public Result materializeSubject(String subjectType, UUID subjectId, UUID actorUserId,
                                     String auditWorkspaceId) {
        if (subjectType == null || subjectId == null) {
            throw new IllegalArgumentException("subjectType and subjectId are required");
        }
        List<AccessRoleBinding> bindings = bindingRepository
                .findBySubjectTypeAndSubjectId(subjectType, subjectId);

        Set<UUID> roleIds = new LinkedHashSet<>();
        Map<AccessScope, Set<UUID>> rolesByScope = new LinkedHashMap<>();
        for (AccessRoleBinding binding : bindings) {
            AccessScope scope = bindingScope(binding);
            roleIds.add(binding.getRoleId());
            rolesByScope.computeIfAbsent(scope, ignored -> new LinkedHashSet<>())
                    .add(binding.getRoleId());
        }

        Map<UUID, List<AccessRolePermission>> permissionsByRole = new HashMap<>();
        if (!roleIds.isEmpty()) {
            for (AccessRolePermission permission : permissionRepository.findByIdRoleIdIn(roleIds)) {
                permissionsByRole.computeIfAbsent(permission.roleId(), ignored -> new ArrayList<>())
                        .add(permission);
            }
        }

        Map<AccessScope, Set<GrantIntersectionEvaluator.PermissionAtom>> desired = new LinkedHashMap<>();
        for (Map.Entry<AccessScope, Set<UUID>> entry : rolesByScope.entrySet()) {
            Set<GrantIntersectionEvaluator.PermissionAtom> atoms = new LinkedHashSet<>();
            for (UUID roleId : entry.getValue()) {
                for (AccessRolePermission permission : permissionsByRole.getOrDefault(roleId, List.of())) {
                    GrantIntersectionEvaluator.PermissionAtom atom =
                            materializableAtom(permission, entry.getKey());
                    if (atom != null) {
                        atoms.add(atom);
                    }
                }
            }
            desired.put(entry.getKey(), atoms);
        }

        Result result = reconcile(subjectType, subjectId, desired, actorUserId, auditWorkspaceId);
        if (AuthzContext.SUBJECT_USER.equals(subjectType)) {
            authzContext.invalidate(subjectId);
        }
        return result;
    }

    /** Re-materializes every subject bound to one role (role permission change, W3). */
    @Transactional
    public int materializeRole(UUID roleId, UUID actorUserId, String auditWorkspaceId) {
        if (roleId == null) {
            throw new IllegalArgumentException("roleId is required");
        }
        int materialized = 0;
        Set<String> seen = new HashSet<>();
        for (AccessRoleBinding binding : bindingRepository.findByRoleId(roleId)) {
            String key = binding.getSubjectType() + "|" + binding.getSubjectId();
            if (!seen.add(key)) {
                continue;
            }
            materializeSubject(binding.getSubjectType(), binding.getSubjectId(), actorUserId,
                    auditWorkspaceId);
            materialized++;
        }
        return materialized;
    }

    /** Drops every {@code source='role'} row of a subject (subject deletion / binding wipe). */
    @Transactional
    public int clearSubject(String subjectType, UUID subjectId) {
        List<AuthorizationGrant> existing = grantRepository
                .findBySubjectTypeAndSubjectIdAndSource(subjectType, subjectId, SOURCE_ROLE);
        if (!existing.isEmpty()) {
            grantRepository.deleteAll(existing);
        }
        if (AuthzContext.SUBJECT_USER.equals(subjectType)) {
            authzContext.invalidate(subjectId);
        }
        return existing.size();
    }

    private Result reconcile(String subjectType, UUID subjectId,
                             Map<AccessScope, Set<GrantIntersectionEvaluator.PermissionAtom>> desired,
                             UUID actorUserId, String auditWorkspaceId) {
        Map<AccessScope, Map<GrantIntersectionEvaluator.PermissionAtom, AuthorizationGrant>> existing =
                new HashMap<>();
        List<AuthorizationGrant> malformed = new ArrayList<>();
        for (AuthorizationGrant grant : grantRepository.findBySubjectTypeAndSubjectIdAndSource(
                subjectType, subjectId, SOURCE_ROLE)) {
            AccessScope scope = grantScope(grant);
            Set<GrantIntersectionEvaluator.PermissionAtom> atoms = evaluator.parse(grant.getPermissions());
            if (atoms.size() != 1) {
                // A materialized row carries exactly one atom; anything else cannot be matched
                // against the desired set, so it is dropped and rewritten.
                malformed.add(grant);
                continue;
            }
            existing.computeIfAbsent(scope, ignored -> new HashMap<>())
                    .put(atoms.iterator().next(), grant);
        }

        List<AuthorizationGrant> toDelete = new ArrayList<>(malformed);
        List<AuthorizationGrant> toCreate = new ArrayList<>();
        Set<AccessScope> scopes = new LinkedHashSet<>();
        scopes.addAll(desired.keySet());
        scopes.addAll(existing.keySet());
        for (AccessScope scope : scopes) {
            Map<GrantIntersectionEvaluator.PermissionAtom, AuthorizationGrant> current =
                    existing.getOrDefault(scope, Map.of());
            Set<GrantIntersectionEvaluator.PermissionAtom> wanted =
                    desired.getOrDefault(scope, Set.of());
            for (Map.Entry<GrantIntersectionEvaluator.PermissionAtom, AuthorizationGrant> row
                    : current.entrySet()) {
                if (!wanted.contains(row.getKey())) {
                    toDelete.add(row.getValue());
                }
            }
            for (GrantIntersectionEvaluator.PermissionAtom atom : wanted) {
                if (!current.containsKey(atom)) {
                    toCreate.add(newGrant(subjectType, subjectId, scope, atom, actorUserId));
                }
            }
        }

        if (!toDelete.isEmpty()) {
            grantRepository.deleteAll(toDelete);
        }
        if (!toCreate.isEmpty()) {
            grantRepository.saveAll(toCreate);
        }
        Result result = new Result(toCreate.size(), toDelete.size(), scopes.size());
        if (result.changed()) {
            auditLogger.recordDurableChange(
                    actorUserId == null ? null : actorUserId.toString(), auditWorkspaceId,
                    "authorization_role_grant_materialized", "grant", subjectId.toString(),
                    "subjectType=" + subjectType + " created=" + result.created()
                            + " deleted=" + result.deleted() + " scopes=" + result.scopes());
            logger.info("[POLICY] event=role_grant_materialized subjectType={} subjectId={}"
                            + " created={} deleted={} scopes={}",
                    subjectType, subjectId, result.created(), result.deleted(), result.scopes());
        }
        return result;
    }

    /**
     * Converts one {@code role_permissions} row into an atom that may be stored in
     * {@code grants.permissions}, or {@code null} when the atom must not be materialized
     * (capability atoms, per design #23).
     */
    private GrantIntersectionEvaluator.PermissionAtom materializableAtom(
            AccessRolePermission permission, AccessScope scope) {
        String actionClass = permission.actionClass();
        if (PermissionAtomCatalog.isCapabilityAtom(actionClass)) {
            return null;
        }
        if (!PermissionAtomCatalog.isActionAtom(actionClass)) {
            throw new IllegalStateException("Unknown permission atom in role_permissions: " + actionClass);
        }
        PermissionAtomCatalog.requireScopeCompatible(actionClass, scope.type());
        String resourcePattern = permission.resourcePattern();
        String resource = ToolFaceRegistry.isCredentialActionClass(actionClass)
                ? resourcePattern
                : (resourcePattern == null || PermissionAtomCatalog.WILDCARD.equals(resourcePattern)
                        ? null
                        : resourcePattern);
        // Validates the vocabulary and the canonical credential resource shape (fail-closed).
        return new GrantIntersectionEvaluator.PermissionAtom(actionClass, resource);
    }

    private AuthorizationGrant newGrant(String subjectType, UUID subjectId, AccessScope scope,
                                        GrantIntersectionEvaluator.PermissionAtom atom,
                                        UUID actorUserId) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(subjectType);
        grant.setSubjectId(subjectId);
        if (actorUserId != null) {
            grant.setGranterType(AuthzContext.SUBJECT_USER);
            grant.setGranterId(actorUserId);
        }
        grant.setSource(SOURCE_ROLE);
        grant.setScopeType(scope.type());
        grant.setScopeId(scope.isInstance() ? null : scope.id());
        grant.setReadState(READ_STATE_READ);
        grant.setPermissions(atomArray(atom));
        return grant;
    }

    private ArrayNode atomArray(GrantIntersectionEvaluator.PermissionAtom atom) {
        ArrayNode permissions = objectMapper.createArrayNode();
        ObjectNode node = objectMapper.createObjectNode();
        node.put("actionClass", atom.actionClass());
        if (!PermissionAtomCatalog.WILDCARD.equals(atom.resource())) {
            node.put("resource", atom.resource());
        }
        permissions.add(node);
        return permissions;
    }

    private static AccessScope bindingScope(AccessRoleBinding binding) {
        if (AccessScope.INSTANCE.equals(binding.getScopeType())) {
            return AccessScope.instance();
        }
        if (AccessScope.WORKSPACE.equals(binding.getScopeType()) && binding.getScopeId() != null) {
            return AccessScope.workspace(binding.getScopeId());
        }
        throw new IllegalStateException("role_bindings row has an invalid scope: " + binding.getId());
    }

    private static AccessScope grantScope(AuthorizationGrant grant) {
        if (AccessScope.INSTANCE.equals(grant.getScopeType())) {
            return AccessScope.instance();
        }
        if (AccessScope.WORKSPACE.equals(grant.getScopeType()) && grant.getScopeId() != null) {
            return AccessScope.workspace(grant.getScopeId());
        }
        throw new IllegalStateException("grants row has an invalid scope: " + grant.getId());
    }
}
