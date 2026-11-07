package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0673 V4.2 (③) — one decision, three independent ceilings.
 *
 * <p>{@code GrantAuthorizationService.allows} intersects <b>every</b> principal on the path: the
 * agent principal's own grant rows, the workspace binding snapshot (the BL-287 {@code cap}) and each
 * Session's frozen {@code agent_permissions_snapshot} (including the spawn ancestors). The individual
 * pieces are covered elsewhere ({@code SetWorkspaceCapGateIntegrationTest} for the cap,
 * {@code AgentDelegatorGrantIntegrationTest} for snapshot freezing), but no single case showed that
 * each of the three can be the <b>deciding</b> denial while the other two still allow.</p>
 *
 * <p>Fixture atoms are chosen so the three layers disagree (real role bindings + real
 * {@code setWorkspaceCap}, not hand-written grant rows):</p>
 *
 * <pre>
 *   principal grants (instance role)  {read, write, spawn_agent}   (+ the AGENT_USER defaults)
 *   workspace cap (snapshot)          {read, write, spawn_agent}   — never `network`
 *   spawn-child session snapshot      {read, network, spawn_agent} — never `write`
 * </pre>
 *
 * <p>Then: {@code read} is allowed by all three; {@code write} is refused by the session layer;
 * {@code network} is refused by the workspace cap; and {@code spawn_agent} — carried by the cap and
 * the session but <b>revoked</b> from the principal — is refused by the principal layer. Each denial
 * is paired with an assertion that the other two layers still contain the atom, so no assertion is
 * vacuous.</p>
 */
class GrantIntersectionThreeWayTest extends AbstractIntegrationTest {

    private static final String READ = ToolFaceRegistry.ACTION_READ;
    private static final String WRITE = ToolFaceRegistry.ACTION_WRITE;
    private static final String NETWORK = ToolFaceRegistry.ACTION_NETWORK;
    private static final String SPAWN_AGENT = ToolFaceRegistry.ACTION_SPAWN_AGENT;

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRolePermissionRepository permissionRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private GrantAuthorizationService grantAuthorizationService;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private String userId;
    private UUID ownerId;
    private UUID workspaceId;
    private UUID principalId;

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void theDecisionIsTheIntersectionOfPrincipalGrantWorkspaceCapAndSessionSnapshot() throws Exception {
        User owner = newUser("3way");
        ownerId = owner.getId();
        userId = owner.getId().toString();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Three-way ws", userId);
        workspaceId = workspace.getId();
        // Real authority, real path: the operator must hold what it hands out, so the fixture promotes
        // it to the instance super administrator (the delegation the product itself expects).
        bindInstanceSystemRole(owner.getId(), SystemAccessRoleCatalog.SUPER_ADMIN);

        AgentPrincipal principal = agentPrincipalService.createPrincipal(userId, "ThreeWayAgent",
                null, emptyTemplateSnapshot());
        principalId = principal.getId();

        // ① principal grant layer — a real instance-scope role binding, materialized.
        AccessRole spawnRole = newRole("THREEWAY_SPAWN", List.of(SPAWN_AGENT));
        bindRole(spawnRole.getId(), "agent_principal", principalId, AccessScope.instance());

        // ② workspace cap layer — the real write path (BL-287): `network` is deliberately left out
        // even though the principal itself holds it through its default role.
        JsonNode cap = atoms(READ, WRITE, SPAWN_AGENT);
        agentPrincipalService.setWorkspaceCap(userId, workspaceId, principalId, cap);

        // ③ session snapshot layer — the frozen per-Session cap; the spawn child refuses `write`.
        ArrayNode rootCap = atoms(READ, WRITE, NETWORK, SPAWN_AGENT);
        ArrayNode childCap = atoms(READ, NETWORK, SPAWN_AGENT);
        Session root = saveSession(rootCap);
        ChatRun parentRun = saveRun(root);
        Session child = saveSpawnChild(root, parentRun, childCap);

        // The three layers really disagree (non-vacuity precondition).
        assertTrue(principalAtoms().contains(SPAWN_AGENT), "principal grant carries spawn_agent");
        assertTrue(capAtoms().contains(SPAWN_AGENT), "workspace cap carries spawn_agent");
        assertTrue(snapshot(child).contains(SPAWN_AGENT), "child session snapshot carries spawn_agent");
        assertFalse(capAtoms().contains(NETWORK), "workspace cap excludes network");
        assertFalse(snapshot(child).contains(WRITE), "child session snapshot excludes write");

        assertTrue(allows(child, READ), "all three layers allow read");
        assertFalse(allows(child, WRITE),
                "the session snapshot is the deciding denial for write (grant + cap allow it)");
        assertFalse(allows(child, NETWORK),
                "the workspace cap is the deciding denial for network (grant + session allow it)");

        // ④ principal layer: revoke the spawn_agent grant. The cap row and the session snapshots stay
        // untouched, so only the principal layer still refuses.
        bindingRepository.deleteAll(bindingRepository
                .findBySubjectTypeAndSubjectIdAndScopeType("agent_principal", principalId,
                        AccessScope.INSTANCE));
        bindingRepository.flush();
        materializer.materializeSubject("agent_principal", principalId, owner.getId(), null);
        assertFalse(principalAtoms().contains(SPAWN_AGENT), "the revocation removed the grant");
        assertTrue(capAtoms().contains(SPAWN_AGENT), "the cap snapshot still carries spawn_agent");
        assertTrue(snapshot(child).contains(SPAWN_AGENT), "the session snapshot is frozen with it");
        assertFalse(allows(child, SPAWN_AGENT),
                "the principal grant is the deciding denial once it is revoked");
        assertTrue(allows(child, READ), "read is still allowed — only the revoked atom is denied");
    }

    // ── decision helper ─────────────────────────────────────────────────────

    private boolean allows(Session session, String actionClass) {
        return grantAuthorizationService.allows(new PolicyRequest("write_file",
                List.of(actionClass), List.of("src/main.java"), ToolShape.STRUCTURED,
                userId, workspaceId.toString(), session.getId().toString()));
    }

    // ── layer readers (the same tables the decision reads) ──────────────────

    private List<String> principalAtoms() {
        return jdbcTemplate.queryForList("SELECT a->>'actionClass' FROM grants g,"
                        + " jsonb_array_elements(g.permissions) a WHERE g.subject_type = 'agent_principal'"
                        + " AND g.subject_id = ? AND g.scope_type = 'instance'",
                String.class, principalId);
    }

    private List<String> capAtoms() {
        return jdbcTemplate.queryForList("SELECT a->>'actionClass' FROM workspace_agents w,"
                        + " jsonb_array_elements(w.permissions_snapshot) a"
                        + " WHERE w.principal_id = ? AND w.workspace_id = ?",
                String.class, principalId, workspaceId);
    }

    private List<String> snapshot(Session session) {
        return sessionRepository.findById(session.getId()).orElseThrow()
                .getAgentPermissionsSnapshot().findValuesAsText("actionClass");
    }

    // ── fixtures ────────────────────────────────────────────────────────────

    private User newUser(String prefix) {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        return userRepository.saveAndFlush(new User(
                prefix + "-" + suffix + "@test.local", "hash", prefix, prefix + suffix));
    }

    private AccessRole newRole(String prefix, List<String> atoms) {
        String name = prefix + "_" + UUID.randomUUID().toString().replace("-", "")
                .substring(0, 8).toUpperCase();
        AccessRole role = accessRoleRepository.saveAndFlush(new AccessRole(
                UUID.randomUUID(), name, name, null, false));
        for (String atom : atoms) {
            PermissionAtomCatalog.Atom ref = PermissionAtomCatalog.atom(atom);
            permissionRepository.saveAndFlush(
                    new AccessRolePermission(role.getId(), ref.name(), ref.canonicalResource()));
        }
        return role;
    }

    private void bindRole(UUID roleId, String subjectType, UUID subjectId, AccessScope scope) {
        bindingRepository.saveAndFlush(new AccessRoleBinding(roleId, subjectType, subjectId,
                scope.type(), scope.id(), ownerId));
        materializer.materializeSubject(subjectType, subjectId, ownerId, null);
    }

    private void bindInstanceSystemRole(UUID subjectId, String roleName) {
        UUID roleId = accessRoleRepository.findByName(roleName).orElseThrow().getId();
        bindRole(roleId, "user", subjectId, AccessScope.instance());
    }

    private Session saveSession(ArrayNode permissionsSnapshot) {
        Session session = new Session(workspaceId.toString(), userId, "Three-way root agent");
        session.setId(UUID.randomUUID());
        session.setAgentPermissionsSnapshot(permissionsSnapshot);
        Session saved = sessionRepository.saveAndFlush(session);
        bindPrimaryParticipant(saved.getId().toString(), principalId.toString());
        return saved;
    }

    private ChatRun saveRun(Session session) {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), session.getId().toString(), userId,
                workspaceId.toString(), "three-way-run", "three-way-hash", "provider", "model",
                "workspace", "running");
        return chatRunRepository.saveAndFlush(run);
    }

    private Session saveSpawnChild(Session parent, ChatRun parentRun, ArrayNode permissionsSnapshot) {
        Session child = new Session(workspaceId.toString(), userId, "Three-way spawn agent");
        child.setId(UUID.randomUUID());
        child.setSpawnedFromSessionId(parent.getId());
        child.setSpawnedFromRunId(parentRun.getId());
        child.setSpawnedAt(Instant.now());
        child.setKind(Session.KIND_SPAWN);
        child.setAgentPermissionsSnapshot(permissionsSnapshot);
        Session saved = sessionRepository.saveAndFlush(child);
        bindPrimaryParticipant(saved.getId().toString(), principalId.toString());
        return saved;
    }

    private ArrayNode atoms(String... actionClasses) {
        ArrayNode permissions = objectMapper.createArrayNode();
        for (String actionClass : actionClasses) {
            ObjectNode atom = objectMapper.createObjectNode();
            atom.put("actionClass", actionClass);
            atom.put("resource", "*");
            permissions.add(atom);
        }
        return permissions;
    }

    /** The creation snapshot the service accepts: an object whose {@code permissions} is an array. */
    private ObjectNode emptyTemplateSnapshot() {
        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        return snapshot;
    }
}