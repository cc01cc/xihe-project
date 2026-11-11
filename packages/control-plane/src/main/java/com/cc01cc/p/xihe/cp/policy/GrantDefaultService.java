package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.auth.AuthUserLockService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.InstanceOwner;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserStatus;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.InstanceOwnerRepository;
import com.cc01cc.p.xihe.cp.service.SessionLockService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * PLAN-0610 T1.5: replaces the hard-coded default permission sets with role materialization.
 *
 * <p>Before this wave the class owned two literal action lists ({@code USER_ACTIONS} /
 * {@code ADMIN_ACTIONS}) and wrote one {@code source='default'} row. Now:</p>
 *
 * <ul>
 *   <li>{@link #ensureUserDefault(User)} binds a freshly created account to the {@code USER}
 *       instance tier and lets {@link RoleGrantMaterializer} write the atom rows; an existing tier
 *       binding is never rewritten here — since PLAN-0610 W4a a tier change is a binding write
 *       ({@code PUT /api/v1/bindings}) or an ownership transfer, never a column update;</li>
 *   <li>{@link #ensureAgentSessionDefault(Session)} keeps its frozen-snapshot semantics
 *       (PLAN-0580 #13: a Session's permission snapshot does not follow later role changes) and
 *       uses {@code source='agent_default'} — the materializer never touches that source
 *       (round-2 P1-1).</li>
 * </ul>
 *
 * <p>PLAN-0610 W4a removed the last {@code users.role} bridge: the column is not mapped any more,
 * so the instance tier is read from {@code role_bindings} only (V88 backfilled it, V89 drops the
 * column).</p>
 */
@Service
public class GrantDefaultService {

    private static final Logger logger = LoggerFactory.getLogger(GrantDefaultService.class);

    /** Frozen Session/principal permission snapshot. Never reconciled by the materializer. */
    public static final String SOURCE_AGENT_DEFAULT = "agent_default";

    private static final String SUBJECT_USER = "user";
    private static final String SUBJECT_AGENT = "agent";
    private static final String READ_STATE_READ = "read";

    private final AuthorizationGrantRepository grantRepository;
    private final AccessRoleRepository roleRepository;
    private final AccessRoleBindingRepository bindingRepository;
    private final InstanceOwnerRepository instanceOwnerRepository;
    private final RoleGrantMaterializer materializer;
    private final AuthUserLockService userLock;
    private final SessionLockService sessionLock;
    private final AuditLogger auditLogger;
    private final ObjectMapper objectMapper;
    private final DbLockTimeout dbLockTimeout;

    public GrantDefaultService(AuthorizationGrantRepository grantRepository,
                               AccessRoleRepository roleRepository,
                               AccessRoleBindingRepository bindingRepository,
                               InstanceOwnerRepository instanceOwnerRepository,
                               RoleGrantMaterializer materializer,
                               AuthUserLockService userLock,
                               SessionLockService sessionLock,
                               AuditLogger auditLogger,
                               ObjectMapper objectMapper,
                               DbLockTimeout dbLockTimeout) {
        this.grantRepository = grantRepository;
        this.roleRepository = roleRepository;
        this.bindingRepository = bindingRepository;
        this.instanceOwnerRepository = instanceOwnerRepository;
        this.materializer = materializer;
        this.userLock = userLock;
        this.sessionLock = sessionLock;
        this.auditLogger = auditLogger;
        this.objectMapper = objectMapper;
        this.dbLockTimeout = dbLockTimeout;
    }

    /** Idempotent: binds the user's instance tier role (when missing/stale) and materializes it. */
    @Transactional
    public void ensureUserDefault(User user) {
        requirePersistedUser(user);
        dbLockTimeout.apply();
        User lockedUser = userLock.lockAndFind(user.getId())
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        ensureInstanceTierBinding(lockedUser);
        materializer.materializeSubject(SUBJECT_USER, lockedUser.getId(), lockedUser.getId(), null);
    }

    /**
     * Ensures a persisted account has exactly one instance tier binding, defaulting to {@code USER}.
     *
     * <p>PLAN-0610 W4a: the {@code users.role} bridge is gone, so this method <b>never moves</b> an
     * existing tier — the binding is the truth (V88 backfilled it; W3-2a made it writable). It only
     * fills the gap left by an account created before the binding existed, and collapses duplicate
     * tiers left by earlier runs. Elevation/demotion stays a binding write or an ownership transfer,
     * both of which own their audit/epoch semantics (W3-2a, I4/#29).</p>
     */
    @Transactional
    public void ensureInstanceTierBinding(User user) {
        requirePersistedUser(user);
        Map<String, AccessRole> tierRoles = roleRepository
                .findByNameIn(SystemAccessRoleCatalog.INSTANCE_TIER_ROLES).stream()
                .collect(Collectors.toMap(AccessRole::getName, Function.identity()));
        List<AccessRoleBinding> tierBindings = tierBindings(user.getId(), tierRoles);
        if (!tierBindings.isEmpty()) {
            if (tierBindings.size() > 1) {
                // One instance tier binding per user; drop duplicates left by earlier runs.
                bindingRepository.deleteAll(tierBindings.subList(1, tierBindings.size()));
            }
            return;
        }
        AccessRole defaultTier = tierRoles.get(SystemAccessRoleCatalog.USER);
        if (defaultTier == null) {
            throw new IllegalStateException("System role catalog is incomplete: "
                    + SystemAccessRoleCatalog.USER + " is missing (V87 must have been applied)");
        }
        bindingRepository.save(new AccessRoleBinding(defaultTier.getId(), SUBJECT_USER, user.getId(),
                AccessScope.INSTANCE, null, user.getId()));
    }

    /**
     * PLAN-0610 T1.9 / invariant I1: seed the instance-level {@code SUPER_ADMIN} binding so a fresh
     * database starts with a super administrator instead of a plain ADMIN.
     *
     * <p>Idempotent: an existing SUPER_ADMIN binding is left untouched. Otherwise the lower tier
     * binding (ADMIN/USER) is replaced, so a subject never accumulates two instance tiers. The
     * materialization in the same transaction keeps «绑定并集 == 物化行集» (T1.10) true.</p>
     *
     * <p><b>PLAN-0610 W1c (round-3 P1-3) — no privilege resurrection.</b> Seeding is a
     * <em>bootstrap</em> action, so it now runs only when all of the following hold:</p>
     *
     * <ol>
     *   <li>the target account is usable ({@code ACTIVE}, not soft-deleted) — a DISABLED or deleted
     *       account never receives a fresh privilege (it could not log in to use it, and an operator
     *       disabled it on purpose);</li>
     *   <li>the instance has <b>no</b> usable {@code SUPER_ADMIN} holder at instance scope — a
     *       second super administrator is never minted by a restart (this also stops the old
     *       "downgraded admin is re-promoted on every boot" behaviour when another holder exists);</li>
     *   <li>the target still is (or the pointer is empty so it is about to become) the instance
     *       owner — the pre-V88 bridge keeps «owner MUST hold SUPER_ADMIN» (I5) and stops seeding a
     *       second account after ownership moved elsewhere.</li>
     * </ol>
     *
     * <p>Residual case, deliberate: if the only usable super administrator is moved to a lower tier,
     * the next bootstrap re-seeds it. That is I1 repair, not escalation — the write path that may
     * produce such a state must refuse it ({@code 409 LAST_SUPER_ADMIN}, W3); a downgrade that
     * reached the database therefore came from a bypass, and restoring the invariant is the safer
     * end state.</p>
     */
    @Transactional
    public void ensureInstanceSuperAdmin(User user) {
        requirePersistedUser(user);
        dbLockTimeout.apply();
        User lockedUser = userLock.lockAndFind(user.getId())
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        AccessRole superAdmin = roleRepository.findByName(SystemAccessRoleCatalog.SUPER_ADMIN)
                .orElseThrow(() -> new IllegalStateException(
                        "System role SUPER_ADMIN is missing (V87 must have been applied)"));
        Map<String, AccessRole> tierRoles = roleRepository
                .findByNameIn(SystemAccessRoleCatalog.INSTANCE_TIER_ROLES).stream()
                .collect(Collectors.toMap(AccessRole::getName, Function.identity()));
        List<AccessRoleBinding> tierBindings = tierBindings(lockedUser.getId(), tierRoles);
        boolean alreadySuperAdmin = tierBindings.stream()
                .anyMatch(binding -> superAdmin.getId().equals(binding.getRoleId()));
        if (alreadySuperAdmin) {
            materializer.materializeSubject(SUBJECT_USER, lockedUser.getId(), lockedUser.getId(), null);
            return;
        }
        if (!lockedUser.isUsable()) {
            logger.info("[POLICY] event=super_admin_binding_seed_skipped reason=account_not_active userId={}"
                    + " status={} deleted={}", lockedUser.getId(), lockedUser.getStatus(),
                    lockedUser.getDeletedAt() != null);
            return;
        }
        long usableSuperAdmins = bindingRepository.countActiveUserBindingsForRole(
                superAdmin.getId(), UserStatus.ACTIVE);
        if (usableSuperAdmins > 0) {
            logger.info("[POLICY] event=super_admin_binding_seed_skipped"
                            + " reason=instance_has_active_super_admin userId={} holders={}",
                    lockedUser.getId(), usableSuperAdmins);
            return;
        }
        if (!isInstanceOwnerOrUnowned(lockedUser.getId())) {
            logger.info("[POLICY] event=super_admin_binding_seed_skipped reason=not_instance_owner userId={}",
                    lockedUser.getId());
            return;
        }
        bindingRepository.deleteAll(tierBindings);
        bindingRepository.save(new AccessRoleBinding(superAdmin.getId(), SUBJECT_USER,
                lockedUser.getId(), AccessScope.INSTANCE, null, lockedUser.getId()));
        auditLogger.recordDurableChange(lockedUser.getId().toString(), null,
                "authorization_super_admin_binding_seeded", "user", lockedUser.getId().toString(),
                "role=" + SystemAccessRoleCatalog.SUPER_ADMIN + " scope=instance");
        logger.info("[POLICY] event=super_admin_binding_seeded userId={}", lockedUser.getId());
        materializer.materializeSubject(SUBJECT_USER, lockedUser.getId(), lockedUser.getId(), null);
    }

    /**
     * T4.3: true when the subject holds an instance-scope {@code ADMIN} or {@code SUPER_ADMIN}
     * binding.
     *
     * <p>This is the capability judgement that replaces the legacy {@code users.role == ADMIN}
     * read in {@code InstanceOwnershipService#transfer} (design §3.6, W3 "users.role 读点清零").
     * It reads the <b>binding rows</b> instead of {@link AuthzContext} on purpose: capability atoms
     * are never materialized into {@code grants} (decision #23), so a binding is the only authority
     * fact, and this path must not depend on a cache that another transaction may have filled
     * before the current (uncommitted) state.</p>
     */
    @Transactional(readOnly = true)
    public boolean holdsInstanceAdminCapability(UUID subjectId) {
        if (subjectId == null) {
            return false;
        }
        Set<UUID> adminTierRoleIds = adminTierRoleIds();
        if (adminTierRoleIds.isEmpty()) {
            return false;
        }
        return bindingRepository
                .findBySubjectTypeAndSubjectIdAndScopeType(SUBJECT_USER, subjectId,
                        AccessScope.INSTANCE)
                .stream()
                .anyMatch(binding -> adminTierRoleIds.contains(binding.getRoleId()));
    }

    /**
     * T4.3 (I5): move the instance {@code SUPER_ADMIN} binding from the outgoing owner to the
     * incoming one and leave the outgoing owner on the {@code ADMIN} tier, in the caller's
     * transaction (design §3.6, contract §4 「the previous owner stays ADMIN」).
     *
     * <p>Why this lives here: {@code instance_owner} + {@code users} + {@code role_bindings} +
     * {@code grants} must move together, and this service already owns every write of the
     * instance tier binding ({@link #ensureInstanceSuperAdmin(User)},
     * {@link #ensureInstanceTierBinding(User)}). The caller
     * ({@code InstanceOwnershipService#transfer}) holds the {@code instance_owner} singleton lock
     * first, so the frozen lock order {@code instance_owner → users} is preserved: this method only
     * takes the two user row locks, in ascending id order (round-4 P1-1 ABBA rule), and then writes
     * bindings, reconciles {@code source='role'} atoms and bumps both epochs.</p>
     *
     * <p>Guard: the post-state must still hold at least one ACTIVE super administrator (I5). The
     * incoming owner is ACTIVE (checked by the caller) so the count is 1 by construction; the
     * assertion only fires on a corrupt pre-state and rolls the whole transfer back instead of
     * committing a zero-super-admin instance.</p>
     */
    @Transactional
    public void transferInstanceSuperAdmin(UUID fromUserId, UUID toUserId, UUID actorUserId) {
        if (fromUserId == null || toUserId == null) {
            throw new IllegalArgumentException("The outgoing and incoming owner ids are required");
        }
        applyInstanceTierHandover(fromUserId, toUserId, actorUserId);
    }

    /**
     * Emergency variant of {@link #transferInstanceSuperAdmin} (PLAN-0767 M1-5, spec §6 door 2):
     * the {@code instance_owner} pointer is empty, so there is no outgoing owner to demote, lock or
     * rematerialize. Everything else runs through the same core — ascending user locks, the
     * write-then-count {@code LAST_SUPER_ADMIN} guard and the durable authorization audit — so the
     * two public faces cannot drift apart. The caller ({@code InstanceOwnershipService}) owns the
     * pointer write and the {@code instance_owner_emergency_transferred} audit row.
     */
    @Transactional
    public void assignInstanceSuperAdminWhenUnowned(UUID toUserId, UUID actorUserId) {
        if (toUserId == null) {
            throw new IllegalArgumentException("The incoming owner id is required");
        }
        applyInstanceTierHandover(null, toUserId, actorUserId);
    }

    /**
     * Single core for both faces. {@code fromUserId == null} means "unowned instance": no demotion,
     * no lock on a former owner and no rematerialization of it; the incoming account is promoted and
     * rematerialized exactly as on the transfer path.
     */
    private void applyInstanceTierHandover(UUID fromUserId, UUID toUserId, UUID actorUserId) {
        dbLockTimeout.apply();
        List<UUID> orderedSubjects = new ArrayList<>(fromUserId == null
                ? new LinkedHashSet<>(List.of(toUserId))
                : new LinkedHashSet<>(List.of(fromUserId, toUserId)));
        orderedSubjects.sort(UUID::compareTo);
        for (UUID subjectId : orderedSubjects) {
            userLock.lockAndFind(subjectId)
                    .orElseThrow(() -> new IllegalArgumentException("User not found: " + subjectId));
        }
        AccessRole superAdmin = roleRepository.findByName(SystemAccessRoleCatalog.SUPER_ADMIN)
                .orElseThrow(() -> new IllegalStateException(
                        "System role SUPER_ADMIN is missing (V87 must have been applied)"));
        AccessRole admin = roleRepository.findByName(SystemAccessRoleCatalog.ADMIN)
                .orElseThrow(() -> new IllegalStateException(
                        "System role ADMIN is missing (V87 must have been applied)"));

        boolean handover = fromUserId != null && !fromUserId.equals(toUserId);
        Set<UUID> tierRoleIds = roleRepository
                .findByNameIn(SystemAccessRoleCatalog.INSTANCE_TIER_ROLES)
                .stream()
                .map(AccessRole::getId)
                .collect(Collectors.toSet());
        if (handover) {
            replaceInstanceTierBinding(fromUserId, admin, tierRoleIds, actorUserId);
        }
        replaceInstanceTierBinding(toUserId, superAdmin, tierRoleIds, actorUserId);

        if (fromUserId != null) {
            materializer.materializeSubjectWithEpochBump(SUBJECT_USER, fromUserId, actorUserId, null);
        }
        if (handover || fromUserId == null) {
            materializer.materializeSubjectWithEpochBump(SUBJECT_USER, toUserId, actorUserId, null);
        }
        String fromDetail = fromUserId == null ? "<none>" : fromUserId.toString();
        if (fromUserId == null) {
            auditLogger.recordDurableChange(actorUserId == null ? null : actorUserId.toString(), null,
                    "authorization_instance_super_admin_assigned", "user", toUserId.toString(),
                    "role=" + SystemAccessRoleCatalog.SUPER_ADMIN + " scope=instance from=<none> to="
                            + toUserId);
        } else {
            auditLogger.recordDurableChange(actorUserId == null ? null : actorUserId.toString(), null,
                    "authorization_instance_super_admin_transferred", "user", toUserId.toString(),
                    "role=" + SystemAccessRoleCatalog.SUPER_ADMIN + " scope=instance from=" + fromUserId
                            + " to=" + toUserId);
        }

        long activeSuperAdmins = bindingRepository.countActiveUserBindingsForRole(
                superAdmin.getId(), UserStatus.ACTIVE);
        if (activeSuperAdmins < 1) {
            throw new CpApiException(HttpStatus.CONFLICT, "LAST_SUPER_ADMIN",
                    "The instance must keep at least one usable SUPER_ADMIN");
        }
        if (fromUserId == null) {
            logger.info("[POLICY] event=instance_super_admin_assigned from={} to={} activeHolders={}",
                    fromDetail, toUserId, activeSuperAdmins);
        } else {
            logger.info("[POLICY] event=instance_super_admin_transferred from={} to={} activeHolders={}",
                    fromUserId, toUserId, activeSuperAdmins);
        }
    }

    /** Replaces the subject's instance tier binding with {@code role} (one tier row per user). */
    private void replaceInstanceTierBinding(UUID subjectId, AccessRole role, Set<UUID> tierRoleIds,
                                            UUID actorUserId) {
        List<AccessRoleBinding> existing = bindingRepository
                .findBySubjectTypeAndSubjectIdAndScopeType(SUBJECT_USER, subjectId,
                        AccessScope.INSTANCE)
                .stream()
                .filter(binding -> tierRoleIds.contains(binding.getRoleId()))
                .toList();
        bindingRepository.deleteAll(existing);
        // Hibernate flushes inserts before deletes inside one action queue, so the replacement row
        // must not be queued while the old one is still pending (uq_role_bindings would fire).
        bindingRepository.flush();
        bindingRepository.save(new AccessRoleBinding(role.getId(), SUBJECT_USER, subjectId,
                AccessScope.INSTANCE, null, actorUserId));
    }

    /**
     * True when {@code userId} holds the {@code instance_owner} pointer, or when no pointer exists
     * yet (a fresh instance: the caller assigns ownership in the same bootstrap transaction).
     */
    private boolean isInstanceOwnerOrUnowned(UUID userId) {
        return instanceOwnerRepository.findById(InstanceOwner.SINGLETON_ID)
                .map(owner -> owner.getOwnerUserId() == null || owner.getOwnerUserId().equals(userId))
                .orElse(true);
    }

    private List<AccessRoleBinding> tierBindings(UUID userId, Map<String, AccessRole> tierRoles) {
        return bindingRepository
                .findBySubjectTypeAndSubjectIdAndScopeType(SUBJECT_USER, userId,
                        AccessScope.INSTANCE)
                .stream()
                .filter(binding -> tierRoles.values().stream()
                        .anyMatch(role -> role.getId().equals(binding.getRoleId())))
                .toList();
    }

    private static boolean isSuperAdmin(AccessRoleBinding binding, Map<String, AccessRole> tierRoles) {
        AccessRole superAdmin = tierRoles.get(SystemAccessRoleCatalog.SUPER_ADMIN);
        return superAdmin != null && superAdmin.getId().equals(binding.getRoleId());
    }

    /**
     * PLAN-0580 #13: the Session-level snapshot stays frozen after a later role change (V5.1
     * asserts exactly this). {@code source='agent_default'} keeps it out of the materializer's
     * reconciliation scope (round-2 P1-1).
     */
    @Transactional
    public void ensureAgentSessionDefault(Session session) {
        if (session == null || session.getId() == null || session.getUserId() == null) {
            throw new IllegalArgumentException("A persisted root Session is required for default grants");
        }
        dbLockTimeout.apply();
        Session lockedSession = sessionLock.lockAndFind(session.getId())
                .orElseThrow(() -> new IllegalArgumentException("Session not found"));
        if (lockedSession.getKind() != null) {
            throw new IllegalArgumentException("Derived Sessions require an explicit narrowed grant snapshot");
        }
        UUID userId = UUID.fromString(lockedSession.getUserId());
        User user = userLock.lockAndFind(userId)
                .orElseThrow(() -> new IllegalArgumentException("Session owner not found"));
        if (grantRepository.existsBySubjectTypeAndSubjectIdAndSource(SUBJECT_AGENT,
                lockedSession.getId(), SOURCE_AGENT_DEFAULT)) {
            return;
        }
        ArrayNode permissions = instanceRoleAtoms(user.getId());
        if (permissions.isEmpty()) {
            ensureInstanceTierBinding(user);
            materializer.materializeSubject(SUBJECT_USER, user.getId(), user.getId(), null);
            permissions = instanceRoleAtoms(user.getId());
        }
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(SUBJECT_AGENT);
        grant.setSubjectId(lockedSession.getId());
        grant.setPermissions(permissions);
        grant.setSource(SOURCE_AGENT_DEFAULT);
        grant.setScopeType(AccessScope.INSTANCE);
        grant.setReadState(READ_STATE_READ);
        AuthorizationGrant saved = grantRepository.save(grant);
        auditLogger.recordDurableChange(user.getId().toString(), lockedSession.getWorkspaceId(),
                "authorization_agent_default_grant_created", "grant", saved.getId().toString(),
                "source=" + SOURCE_AGENT_DEFAULT + " subjectType=" + SUBJECT_AGENT
                        + " sessionId=" + lockedSession.getId());
        logger.info("[POLICY] event=agent_default_grant_created sessionId={} atoms={}",
                lockedSession.getId(), permissions.size());
    }

    /**
     * PLAN-0470 (decision #15): session-scoped agent grants cleanup owned by Policy; participates in
     * the caller's Session deletion transaction.
     */
    @Transactional
    public void deleteSessionAgentGrants(UUID sessionId) {
        grantRepository.deleteBySubjectTypeAndSubjectId(SUBJECT_AGENT, sessionId);
    }

    /**
     * PLAN-0470 (decision #22): the agent-principal spawn/template grant write is owned by Policy;
     * the Principal service computes the covered permission set and hands it over. Joins the
     * caller's transaction. A legacy {@code source="default"} request from the minting path is
     * stored as the frozen {@code agent_default} snapshot (round-2 P1-1): the materializer must
     * never own it.
     */
    @Transactional
    public void createAgentPrincipalGrant(UUID principalId, UUID granterId, String source,
                                          String roleName, String templateName,
                                          JsonNode permissions) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(GrantPrincipalPathResolver.AGENT_PRINCIPAL);
        grant.setSubjectId(principalId);
        grant.setGranterType(GrantPrincipalPathResolver.USER);
        grant.setGranterId(granterId);
        grant.setSource(SOURCE_AGENT_DEFAULT.equals(source) || "default".equals(source)
                ? SOURCE_AGENT_DEFAULT
                : source);
        grant.setRoleName(roleName);
        grant.setTemplateName(templateName);
        grant.setScopeType(AccessScope.INSTANCE);
        grant.setReadState(READ_STATE_READ);
        grant.setPermissions(permissions);
        grantRepository.saveAndFlush(grant);
    }

    /** Union of the user's instance-scope {@code source='role'} atoms, frozen into one array. */
    private ArrayNode instanceRoleAtoms(UUID userId) {
        ArrayNode permissions = objectMapper.createArrayNode();
        List<AuthorizationGrant> rows = grantRepository.findScopedGrants(SUBJECT_USER, userId,
                List.of(RoleGrantMaterializer.SOURCE_ROLE), null);
        java.util.Set<String> seen = new java.util.LinkedHashSet<>();
        for (AuthorizationGrant row : rows) {
            for (JsonNode atom : row.getPermissions()) {
                ObjectNode copy = objectMapper.createObjectNode();
                copy.put("actionClass", atom.get("actionClass").asText());
                JsonNode resource = atom.get("resource");
                if (resource != null && !PermissionAtomCatalog.WILDCARD.equals(resource.asText())) {
                    copy.put("resource", resource.asText());
                }
                if (seen.add(copy.toString())) {
                    permissions.add(copy);
                }
            }
        }
        return permissions;
    }

    private static void requirePersistedUser(User user) {
        if (user == null || user.getId() == null) {
            throw new IllegalArgumentException("A persisted user is required for default grants");
        }
    }

    /**
     * PLAN-0610 W4a: number of ACTIVE, non-deleted accounts holding an instance {@code ADMIN} or
     * {@code SUPER_ADMIN} tier binding. This is the "usable administrator" count the last-admin
     * guard needs now that {@code users.role} is gone (R2-9: a capability/binding fact, never a
     * column).
     */
    @Transactional(readOnly = true)
    public long countActiveInstanceAdmins() {
        Set<UUID> adminTierRoleIds = adminTierRoleIds();
        if (adminTierRoleIds.isEmpty()) {
            return 0;
        }
        return bindingRepository.countActiveUsersWithInstanceRoles(adminTierRoleIds,
                UserStatus.ACTIVE);
    }

    private Set<UUID> adminTierRoleIds() {
        return roleRepository
                .findByNameIn(List.of(SystemAccessRoleCatalog.SUPER_ADMIN,
                        SystemAccessRoleCatalog.ADMIN))
                .stream()
                .map(AccessRole::getId)
                .collect(Collectors.toSet());
    }
}
