package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * PLAN-0610 T1.15: resolves <b>capability atoms</b> from role bindings into authorities at
 * authentication time.
 *
 * <p>Capability atoms ({@code instance:super}, {@code instance:admin}, {@code workspace:admin})
 * are never materialized into {@code grants} — {@code GrantIntersectionEvaluator.PermissionAtom}
 * rejects any actionClass outside {@link ToolFaceRegistry#builtinActionClasses()}, so a
 * capability atom inside a grant would fail every evaluation closed (M0 D6, design #23). They are
 * answered here instead:</p>
 *
 * <ul>
 *   <li>instance-scope binding → {@code cap:instance:super} / {@code cap:instance:admin}
 *       (round-2 P1-4 authority contract);</li>
 *   <li>{@code workspace:admin} bound at instance scope → "admin of every workspace"
 *       (decision #15: {@code workspace:admin} is {@code scope_class=both});</li>
 *   <li>{@code workspace:admin} bound at workspace scope → admin of that workspace only; a
 *       workspace-scoped capability never becomes a global authority.</li>
 * </ul>
 *
 * <p>The answer is cached per subject for a short TTL ({@code cp.capability-cache-ttl-ms},
 * default 30s) and invalidated synchronously by the binding/role write paths
 * ({@link #invalidate(UUID)}); a stale entry therefore cannot outlive the transaction that
 * changed it by more than one lookup.</p>
 */
@Component
public class AuthzContext {

    private static final Logger logger = LoggerFactory.getLogger(AuthzContext.class);

    /** Subject type of an authenticated account; agent principals are not authority carriers. */
    public static final String SUBJECT_USER = "user";

    private static final Capabilities EMPTY = new Capabilities(Set.of(), false, Set.of());

    /** Immutable capability snapshot for one subject. */
    public record Capabilities(Set<String> authorities, boolean workspaceAdminAll,
                               Set<UUID> workspaceAdminWorkspaces) {

        public boolean isInstanceSuper() {
            return authorities.contains(PermissionAtomCatalog.authorityOf(
                    PermissionAtomCatalog.CAP_INSTANCE_SUPER));
        }

        public boolean isInstanceAdmin() {
            return authorities.contains(PermissionAtomCatalog.authorityOf(
                    PermissionAtomCatalog.CAP_INSTANCE_ADMIN));
        }

        public boolean canWorkspaceAdmin(UUID workspaceId) {
            return workspaceAdminAll
                    || (workspaceId != null && workspaceAdminWorkspaces.contains(workspaceId));
        }

        /**
         * PLAN-0651 T1.2 (D51-30): capability-atom holding, scope-aware. This is the single place a
         * capability question is answered for the "may I grant this?" check, so
         * {@code RequesterAuthority} no longer reads the instance-administrator flag directly.
         */
        public boolean holdsCapability(String atom, UUID workspaceId) {
            return switch (atom) {
                case PermissionAtomCatalog.CAP_INSTANCE_SUPER ->
                        authorities.contains(PermissionAtomCatalog.authorityOf(
                                PermissionAtomCatalog.CAP_INSTANCE_SUPER));
                case PermissionAtomCatalog.CAP_INSTANCE_ADMIN ->
                        authorities.contains(PermissionAtomCatalog.authorityOf(
                                PermissionAtomCatalog.CAP_INSTANCE_ADMIN));
                case PermissionAtomCatalog.CAP_WORKSPACE_ADMIN -> workspaceId == null
                        ? workspaceAdminAll() : canWorkspaceAdmin(workspaceId);
                default -> false;
            };
        }
    }

    private record Cached(Capabilities capabilities, long expiresAtNanos) {
    }

    private final AccessRoleBindingRepository bindingRepository;
    private final AccessRolePermissionRepository permissionRepository;
    private final ConcurrentHashMap<UUID, Cached> cache = new ConcurrentHashMap<>();
    private final long ttlNanos;

    public AuthzContext(AccessRoleBindingRepository bindingRepository,
                        AccessRolePermissionRepository permissionRepository,
                        @Value("${cp.capability-cache-ttl-ms:30000}") long ttlMs) {
        this.bindingRepository = bindingRepository;
        this.permissionRepository = permissionRepository;
        this.ttlNanos = Math.max(0L, ttlMs) * 1_000_000L;
    }

    /** Capability snapshot for a subject, served from the short-TTL cache when fresh. */
    public Capabilities capabilitiesFor(UUID subjectId) {
        if (subjectId == null) {
            return EMPTY;
        }
        long now = System.nanoTime();
        if (ttlNanos > 0L) {
            Cached cached = cache.get(subjectId);
            if (cached != null && cached.expiresAtNanos() - now > 0L) {
                return cached.capabilities();
            }
        }
        Capabilities resolved = resolve(subjectId);
        if (ttlNanos > 0L) {
            cache.put(subjectId, new Cached(resolved, now + ttlNanos));
        }
        return resolved;
    }

    /** Authorities contributed by capability atoms; feed these into the security context. */
    public Set<String> authoritiesFor(UUID subjectId) {
        return capabilitiesFor(subjectId).authorities();
    }

    public boolean isInstanceSuper(UUID subjectId) {
        return capabilitiesFor(subjectId).isInstanceSuper();
    }

    public boolean isInstanceAdmin(UUID subjectId) {
        return capabilitiesFor(subjectId).isInstanceAdmin();
    }

    /**
     * Round-2 P1-4 / decision #15: workspace administration is a service-level question.
     *
     * <p>PLAN-0651 T1.2 (D51-30): the {@code instance:admin} bypass is gone — "an instance
     * administrator administers every workspace" is now a <b>default grant</b>
     * ({@code workspace:admin} at instance scope, seeded by V111), not a code branch. A custom role
     * that carries {@code instance:admin} without {@code workspace:admin} therefore does <b>not</b>
     * imply workspace administration; that is the accepted trade-off of D51-30 (its holders are
     * detected by the zero-gap query in the V111 header).</p>
     */
    public boolean canWorkspaceAdmin(UUID subjectId, UUID workspaceId) {
        Capabilities capabilities = capabilitiesFor(subjectId);
        return capabilities.canWorkspaceAdmin(workspaceId);
    }

    /** Current-request subject (from {@code TenantContext}); {@code false} without a subject. */
    public boolean canWorkspaceAdmin(String workspaceId) {
        UUID subjectId = currentSubjectId();
        UUID workspace = parseWorkspaceId(workspaceId);
        return subjectId != null && workspace != null && canWorkspaceAdmin(subjectId, workspace);
    }

    /** Current-request subject's instance-administration capability. */
    public boolean isInstanceAdmin() {
        UUID subjectId = currentSubjectId();
        return subjectId != null && isInstanceAdmin(subjectId);
    }

    public boolean isInstanceSuper() {
        UUID subjectId = currentSubjectId();
        return subjectId != null && isInstanceSuper(subjectId);
    }

    /** Capabilities of the current request subject; empty without one. */
    public Set<String> currentAuthorities() {
        UUID subjectId = currentSubjectId();
        return subjectId == null ? Set.of() : authoritiesFor(subjectId);
    }

    private static UUID currentSubjectId() {
        String userId = TenantContext.getUserId();
        if (userId == null || userId.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(userId);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static UUID parseWorkspaceId(String workspaceId) {
        if (workspaceId == null || workspaceId.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(workspaceId.trim());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** Called by every binding/role write in the same transaction (I4). */
    public void invalidate(UUID subjectId) {
        if (subjectId != null) {
            cache.remove(subjectId);
        }
    }

    public void invalidateAll() {
        cache.clear();
    }

    private Capabilities resolve(UUID subjectId) {
        List<AccessRoleBinding> bindings = bindingRepository
                .findBySubjectTypeAndSubjectId(SUBJECT_USER, subjectId);
        if (bindings.isEmpty()) {
            return EMPTY;
        }
        Set<UUID> roleIds = new LinkedHashSet<>();
        bindings.forEach(binding -> roleIds.add(binding.getRoleId()));
        Map<UUID, List<AccessRolePermission>> permissionsByRole = new HashMap<>();
        for (AccessRolePermission permission : permissionRepository.findByIdRoleIdIn(roleIds)) {
            permissionsByRole.computeIfAbsent(permission.roleId(), ignored -> new ArrayList<>())
                    .add(permission);
        }

        Set<String> authorities = new HashSet<>();
        Set<UUID> workspaceAdminWorkspaces = new HashSet<>();
        boolean workspaceAdminAll = false;
        for (AccessRoleBinding binding : bindings) {
            for (AccessRolePermission permission : permissionsByRole.getOrDefault(
                    binding.getRoleId(), List.of())) {
                String atom = permission.actionClass();
                if (!PermissionAtomCatalog.isCapabilityAtom(atom)) {
                    continue;
                }
                if (AccessScope.INSTANCE.equals(binding.getScopeType())) {
                    if (PermissionAtomCatalog.CAP_WORKSPACE_ADMIN.equals(atom)) {
                        workspaceAdminAll = true;
                    } else {
                        authorities.add(PermissionAtomCatalog.authorityOf(atom));
                    }
                } else if (PermissionAtomCatalog.CAP_WORKSPACE_ADMIN.equals(atom)
                        && binding.getScopeId() != null) {
                    workspaceAdminWorkspaces.add(binding.getScopeId());
                } else {
                    // An instance-level capability cannot be granted from a workspace binding
                    // (write-time validation rejects it; a corrupt row must not widen authority).
                    logger.warn("[POLICY] event=capability_scope_violation atom={} scopeType={}",
                            atom, binding.getScopeType());
                }
            }
        }
        if (authorities.isEmpty() && !workspaceAdminAll && workspaceAdminWorkspaces.isEmpty()) {
            return EMPTY;
        }
        return new Capabilities(Set.copyOf(authorities), workspaceAdminAll,
                Set.copyOf(workspaceAdminWorkspaces));
    }
}

