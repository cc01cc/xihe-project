package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.support.TestAgentPrincipals;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * D-1865 (task-23): a cross-principal delegation chain must be admitted, and must still be
 * ceilinged by every ancestor.
 *
 * <p>resolveAgent used to require the LEAF principal to equal every ancestor's, so the shape
 * ChatSubmissionService.createDelegation writes (parent Session carried by agent A, delegated child
 * Session carried by agent B) failed closed and surfaced as 403 AGENT_PRINCIPAL_MISSING. The chain
 * now checks user / Workspace / lineage / acyclicity, identity comes from the leaf, and the ceiling
 * stays the hop-by-hop intersection performed by GrantAuthorizationService.allows.</p>

 * <p>The fixture gives the delegated child principal the wider atom in every layer it OWNS - its
 * grant rows, its Workspace binding cap and its own frozen Session snapshot. The only layer that
 * refuses it is an ANCESTOR's snapshot, so a green denial cannot be an artefact of an
 * under-provisioned child: the same principal with the same layers but no ancestor path (a fork,
 * which is a new permission root) is allowed. That pair is the non-vacuity proof.</p>
 */
class CrossPrincipalDelegationCapIntegrationTest extends AbstractReusableIntegrationTest {

    private static final String READ = ToolFaceRegistry.ACTION_READ;
    private static final String WRITE = ToolFaceRegistry.ACTION_WRITE;
    private static final String NETWORK = ToolFaceRegistry.ACTION_NETWORK;
    private static final String DELETE = ToolFaceRegistry.ACTION_DELETE;
    private static final String TARGET = "src/main.java";

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private GrantPrincipalPathResolver principalPathResolver;
    @Autowired private GrantAuthorizationService grantAuthorizationService;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private String userId;
    private UUID workspaceId;
    private final List<UUID> grantIds = new ArrayList<>();
    private final List<UUID> principalIds = new ArrayList<>();
    private final List<WorkspaceAgentId> bindingIds = new ArrayList<>();
    private final List<UUID> runIds = new ArrayList<>();
    private final List<UUID> sessionIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        // Sessions first: session_participants (the PRIMARY identity) cascade with them, and only
        // then may the principals they reference be removed.
        sessionIds.forEach(sessionRepository::deleteById);
        runIds.forEach(chatRunRepository::deleteById);
        grantIds.forEach(grantRepository::deleteById);
        bindingIds.forEach(workspaceAgentRepository::deleteById);
        principalIds.forEach(agentPrincipalRepository::deleteById);
        if (workspaceId != null) {
            // Bindings first, then the Workspace row: users is FK-referenced by workspaces, so the
            // account cannot go while its Workspace still exists.
            workspaceFixture.unbindWorkspace(workspaceId);
            workspaceRepository.deleteById(workspaceId);
        }
        if (userId != null) {
            userRepository.deleteById(UUID.fromString(userId));
        }
        sessionIds.clear();
        runIds.clear();
        grantIds.clear();
        bindingIds.clear();
        principalIds.clear();
    }

    @Test
    void crossPrincipalChainIsAdmittedButEveryAncestorSnapshotStaysACeiling() {
        User user = userRepository.saveAndFlush(new User("xdel-" + UUID.randomUUID() + "@test.local",
                "hash", "Delegation test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Cross principal delegation", userId);
        workspaceId = workspace.getId();
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId, WorkspaceRole.OWNER);

        UUID p1 = savePrincipal("Delegating agent");
        UUID p2 = savePrincipal("Delegated agent");
        UUID p3 = savePrincipal("Sub-delegated agent");

        // Every principal's OWN layers carry the wide set; only an ancestor narrows it.
        addAgentGrant(p1, atoms(READ, WRITE));
        addAgentGrant(p2, atoms(READ, WRITE, NETWORK));
        addAgentGrant(p3, atoms(READ, WRITE, NETWORK, DELETE));
        bindWorkspaceAgent(p1, atoms(READ, WRITE, NETWORK));
        bindWorkspaceAgent(p2, atoms(READ, WRITE, NETWORK));
        bindWorkspaceAgent(p3, atoms(READ, WRITE, NETWORK, DELETE));

        Session root = saveSession(p1, null, null, null, atoms(READ, WRITE));
        ChatRun rootRun = saveRun(root);
        Session child = saveSession(p2, root.getId(), rootRun.getId(), Session.KIND_SPAWN,
                atoms(READ, WRITE, NETWORK));
        ChatRun childRun = saveRun(child);
        Session grandchild = saveSession(p3, child.getId(), childRun.getId(), Session.KIND_SPAWN,
                atoms(READ, WRITE, NETWORK, DELETE));
        Session forkSibling = saveSession(p2, root.getId(), rootRun.getId(), Session.KIND_FORK,
                atoms(READ, WRITE, NETWORK));

        // (1) The defect itself: the whole chain resolves, and the identity is the LEAF principal.
        GrantPrincipalPathResolver.AgentPath path = principalPathResolver
                .resolveAgent(userId, workspaceId.toString(), grandchild.getId().toString());
        assertEquals(p3, path.principalId(),
                "identity is the leaf's own PRIMARY, never an ancestor's");
        assertEquals(List.of(root.getId(), child.getId(), grandchild.getId()), idsOf(path),
                "every hop stays on the path, because every hop's frozen cap narrows the leaf");
        assertEquals(p2, principalPathResolver
                .resolveAgent(userId, workspaceId.toString(), child.getId().toString()).principalId());
        assertEquals(List.of(forkSibling.getId()), idsOf(principalPathResolver
                        .resolveAgent(userId, workspaceId.toString(), forkSibling.getId().toString())),
                "a fork is still a new permission root even when its source carries another principal");

        // (2) Non-vacuity: the child really does own network in all three of its own layers.
        assertTrue(grantAtoms(p2).contains(NETWORK), "P2's own grants carry network");
        assertTrue(bindingAtoms(p2).contains(NETWORK), "P2's own Workspace binding cap carries network");
        assertTrue(snapshotAtoms(forkSibling).contains(NETWORK), "P2's own Session snapshot carries network");
        assertFalse(snapshotAtoms(root).contains(NETWORK), "the root snapshot is the layer without network");

        // (3) Requirement 2: an atom the parent never held stays refused for the delegated child.
        assertTrue(allows(child, READ), "the intersection allows what every hop carries");
        assertTrue(allows(child, WRITE), "the intersection allows what every hop carries");
        assertFalse(allows(child, NETWORK),
                "D-1865 requirement 2: the leaf is admitted but never above the ancestor's frozen cap");
        assertFalse(allows(grandchild, NETWORK),
                "the ceiling still holds two hops down, across two principal changes");
        assertFalse(allows(grandchild, DELETE),
                "an atom only the deepest layer carries is refused by the root cap");
        assertTrue(allows(forkSibling, NETWORK),
                "the same principal with the same own layers but no ancestor path IS allowed, so the "
                        + "denials above are the ancestor cap deciding and not an under-provisioned leaf");

        // (4) The ceiling is re-read per decision instead of being cached at admission.
        root.setAgentPermissionsSnapshot(atoms(READ));
        sessionRepository.saveAndFlush(root);
        assertFalse(allows(child, WRITE),
                "narrowing the parent cap re-denies the next tool-boundary evaluation of the child");
        assertTrue(allows(child, READ));
        root.setAgentPermissionsSnapshot(atoms(READ, WRITE));
        sessionRepository.saveAndFlush(root);
        assertTrue(allows(child, WRITE), "and widening it back restores the intersection");
    }

    /** The zero-behaviour-change control: the chain shape every existing producer writes. */
    @Test
    void singlePrincipalChainKeepsItsPreFixAnswers() {
        User user = userRepository.saveAndFlush(new User("xdel-single-" + UUID.randomUUID()
                + "@test.local", "hash", "Delegation single test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Single principal delegation", userId);
        workspaceId = workspace.getId();
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId, WorkspaceRole.OWNER);

        UUID p1 = savePrincipal("Single agent");
        addAgentGrant(p1, atoms(READ, WRITE));
        bindWorkspaceAgent(p1, atoms(READ, WRITE, NETWORK));

        Session root = saveSession(p1, null, null, null, atoms(READ, WRITE));
        ChatRun rootRun = saveRun(root);
        Session child = saveSession(p1, root.getId(), rootRun.getId(), Session.KIND_SPAWN,
                atoms(READ, WRITE));
        ChatRun childRun = saveRun(child);
        Session grandchild = saveSession(p1, child.getId(), childRun.getId(), Session.KIND_SPAWN,
                atoms(READ, WRITE));

        GrantPrincipalPathResolver.AgentPath path = principalPathResolver
                .resolveAgent(userId, workspaceId.toString(), grandchild.getId().toString());
        assertEquals(p1, path.principalId());
        assertEquals(List.of(root.getId(), child.getId(), grandchild.getId()), idsOf(path));
        assertTrue(allows(grandchild, READ));
        assertTrue(allows(grandchild, WRITE));
        assertFalse(allows(grandchild, NETWORK),
                "the leaf grants and the binding cap still decide exactly as before the relaxation");
    }

    // -- decision helper ----------------------------------------------------------------

    private boolean allows(Session session, String actionClass) {
        return grantAuthorizationService.allows(new PolicyRequest("write_file",
                List.of(actionClass), List.of(TARGET), ToolShape.STRUCTURED,
                userId, workspaceId.toString(), session.getId().toString()));
    }

    private static List<UUID> idsOf(GrantPrincipalPathResolver.AgentPath path) {
        return path.sessionPath().stream().map(view -> view.id()).toList();
    }

    // -- layer readers (the same tables the decision reads) ------------------------------

    private List<String> grantAtoms(UUID principal) {
        return jdbcTemplate.queryForList("SELECT a->>'actionClass' FROM grants g,"
                        + " jsonb_array_elements(g.permissions) a WHERE g.subject_type = 'agent_principal'"
                        + " AND g.subject_id = ?", String.class, principal);
    }

    private List<String> bindingAtoms(UUID principal) {
        return jdbcTemplate.queryForList("SELECT a->>'actionClass' FROM workspace_agents w,"
                        + " jsonb_array_elements(w.permissions_snapshot) a"
                        + " WHERE w.principal_id = ? AND w.workspace_id = ?",
                String.class, principal, workspaceId);
    }

    private List<String> snapshotAtoms(Session session) {
        return sessionRepository.findById(session.getId()).orElseThrow()
                .getAgentPermissionsSnapshot().findValuesAsText("actionClass");
    }

    // -- fixtures -----------------------------------------------------------------------

    private UUID savePrincipal(String name) {
        AgentPrincipal principal = TestAgentPrincipals.newUserAgentPrincipal();
        principal.setName(name);
        principal.setCreatedByUserId(userId);
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        UUID id = agentPrincipalRepository.saveAndFlush(principal).getId();
        principalIds.add(id);
        return id;
    }

    private void addAgentGrant(UUID principal, ArrayNode permissions) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(GrantPrincipalPathResolver.AGENT_PRINCIPAL);
        grant.setSubjectId(principal);
        grant.setSource(GrantSources.ROLE);
        grant.setPermissions(permissions);
        grantIds.add(grantRepository.saveAndFlush(grant).getId());
    }

    private void bindWorkspaceAgent(UUID principal, ArrayNode cap) {
        WorkspaceAgent binding = workspaceAgentRepository.saveAndFlush(
                new WorkspaceAgent(principal.toString(), workspaceId.toString(), cap));
        bindingIds.add(binding.getId());
    }

    /**
     * One chain node with its OWN PRIMARY participant - the exact row shape a cross-subject
     * delegation writes (a null kind is a root).
     */
    private Session saveSession(UUID primaryPrincipalId, UUID parentSessionId, UUID parentRunId,
                                String kind, ArrayNode snapshot) {
        Session session = new Session(workspaceId.toString(), userId,
                (kind == null ? "root" : kind) + " delegated session");
        session.setId(UUID.randomUUID());
        session.setAgentPermissionsSnapshot(snapshot);
        if (kind != null) {
            session.setKind(kind);
            session.setSpawnedFromSessionId(parentSessionId);
            session.setSpawnedFromRunId(parentRunId);
            session.setSpawnedAt(Instant.now());
        }
        Session saved = sessionRepository.saveAndFlush(session);
        bindPrimaryParticipant(saved.getId().toString(), primaryPrincipalId.toString());
        sessionIds.add(saved.getId());
        return saved;
    }

    private ChatRun saveRun(Session session) {
        UUID runId = UUID.randomUUID();
        ChatRun run = chatRunRepository.saveAndFlush(new ChatRun(runId.toString(),
                session.getId().toString(), userId, workspaceId.toString(), "xdel-" + runId,
                "hash-hash", "provider", "model", "workspace", "running"));
        runIds.add(runId);
        return run;
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
}
