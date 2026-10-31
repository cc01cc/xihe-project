package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.auth.AuthUserLockService;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.service.SessionLockService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
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
 *   <li>{@link #ensureUserDefault(User)} / {@link #resyncUserDefault(User)} bind the user's
 *       instance tier role ({@code users.role} → {@code ADMIN} / {@code USER}; {@code SUPER_ADMIN}
 *       once V88 migrates the tier) and let {@link RoleGrantMaterializer} write the atom rows;</li>
 *   <li>{@link #ensureAgentSessionDefault(Session)} keeps its frozen-snapshot semantics
 *       (PLAN-0580 #13: a Session's permission snapshot does not follow later role changes) and
 *       uses {@code source='agent_default'} — the materializer never touches that source
 *       (round-2 P1-1).</li>
 * </ul>
 *
 * <p>Until V88 copies {@code users.role} into bindings, the tier binding is derived from the
 * column here. That bridge is the only remaining reader of {@code users.role} in the grant path
 * and disappears with T2.1.</p>
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
    private final RoleGrantMaterializer materializer;
    private final AuthUserLockService userLock;
    private final SessionLockService sessionLock;
    private final AuditLogger auditLogger;
    private final ObjectMapper objectMapper;
    private final DbLockTimeout dbLockTimeout;

    public GrantDefaultService(AuthorizationGrantRepository grantRepository,
                               AccessRoleRepository roleRepository,
                               AccessRoleBindingRepository bindingRepository,
                               RoleGrantMaterializer materializer,
                               AuthUserLockService userLock,
                               SessionLockService sessionLock,
                               AuditLogger auditLogger,
                               ObjectMapper objectMapper,
                               DbLockTimeout dbLockTimeout) {
        this.grantRepository = grantRepository;
        this.roleRepository = roleRepository;
        this.bindingRepository = bindingRepository;
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
     * PLAN-0580 #6/#13: re-derives the user's role atoms in the same transaction as a role change.
     * The tier binding is moved to the new role and the materialized rows are reconciled in place
     * (unchanged atoms keep their row id so the audit chain stays intact).
     */
    @Transactional
    public void resyncUserDefault(User user) {
        requirePersistedUser(user);
        dbLockTimeout.apply();
        User lockedUser = userLock.lockAndFind(user.getId())
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        ensureInstanceTierBinding(lockedUser);
        materializer.materializeSubject(SUBJECT_USER, lockedUser.getId(), lockedUser.getId(), null);
    }

    /** Locks the user row, then decides whether the instance tier binding must be (re)written. */
    @Transactional
    public void ensureInstanceTierBinding(User user) {
        if (user == null || user.getId() == null || user.getRole() == null) {
            throw new IllegalArgumentException("A persisted user and role are required for default grants");
        }
        Map<String, AccessRole> tierRoles = roleRepository
                .findByNameIn(SystemAccessRoleCatalog.INSTANCE_TIER_ROLES).stream()
                .collect(Collectors.toMap(AccessRole::getName, Function.identity()));
        AccessRole target = tierRoles.get(SystemAccessRoleCatalog.instanceTierRoleName(user.getRole()));
        if (target == null) {
            throw new IllegalStateException("System role catalog is incomplete: "
                    + SystemAccessRoleCatalog.instanceTierRoleName(user.getRole())
                    + " is missing (V87 must have been applied)");
        }
        List<AccessRoleBinding> tierBindings = bindingRepository
                .findBySubjectTypeAndSubjectIdAndScopeType(SUBJECT_USER, user.getId(),
                        AccessScope.INSTANCE)
                .stream()
                .filter(binding -> tierRoles.values().stream()
                        .anyMatch(role -> role.getId().equals(binding.getRoleId())))
                .toList();
        if (tierBindings.isEmpty()) {
            bindingRepository.save(new AccessRoleBinding(target.getId(), SUBJECT_USER, user.getId(),
                    AccessScope.INSTANCE, null, user.getId()));
            return;
        }
        AccessRoleBinding primary = tierBindings.get(0);
        boolean alreadyTarget = primary.getRoleId().equals(target.getId());
        if (!alreadyTarget) {
            primary.setRoleId(target.getId());
            bindingRepository.save(primary);
        }
        if (tierBindings.size() > 1) {
            // One instance tier binding per user; drop duplicates left by earlier runs.
            bindingRepository.deleteAll(tierBindings.subList(1, tierBindings.size()));
        }
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
        if (user == null || user.getId() == null || user.getRole() == null) {
            throw new IllegalArgumentException("A persisted user and role are required for default grants");
        }
    }

    /** Kept for the tier mapping assertions in tests; the mapping itself lives in the catalog. */
    public static String tierRoleName(UserRole role) {
        return SystemAccessRoleCatalog.instanceTierRoleName(role);
    }
}
