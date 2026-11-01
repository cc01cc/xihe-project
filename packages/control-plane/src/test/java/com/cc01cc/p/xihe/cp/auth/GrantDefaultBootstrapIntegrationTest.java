package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.AuditLog;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.files.ChatAttachmentService;
import com.cc01cc.p.xihe.cp.files.dto.BatchUploadResult;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.cc01cc.p.xihe.cp.service.ImportService;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.mock.web.MockMultipartFile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0610 W1a: the bootstrap paths of {@link GrantDefaultService}, re-based on role
 * materialization.
 *
 * <p>What changed versus PLAN-0470/PLAN-0580 and what is still frozen:</p>
 *
 * <ul>
 *   <li>the user set is materialized as one {@code source='role'} row per atom (V87
 *       {@code uq_grants_role_atom}) instead of one {@code source='default'} row;</li>
 *   <li>the Session/principal default snapshot moved to {@code source='agent_default'} and is
 *       still written once, frozen, and never reconciled by the materializer (round-2 P1-1);</li>
 *   <li>a Session is still created without an Agent snapshot (PLAN-0374 T2.7) and the snapshot
 *       only appears through an explicit {@code ensureAgentSessionDefault} call;</li>
 *   <li>exactly one audit row per materialization change and one per Agent snapshot — the
 *       concurrent-ensure case still yields one of each.</li>
 * </ul>
 */
class GrantDefaultBootstrapIntegrationTest extends AbstractIntegrationTest {

    /**
     * spec §4.1 USER row: the five allow classes. PLAN-0622 D8 appended exactly one atom —
     * {@code CREATE_OWN_AGENT} (an ordinary account may create its <b>own</b> PERSONAL agent) —
     * so the expectation is expressed as "the five plus that one", never as a bare literal count.
     */
    private static final List<String> USER_ALLOW_ATOMS = List.of(
            ToolFaceRegistry.ACTION_READ, ToolFaceRegistry.ACTION_WRITE,
            ToolFaceRegistry.ACTION_DELETE, ToolFaceRegistry.ACTION_EXEC,
            ToolFaceRegistry.ACTION_NETWORK);

    /** D8: the user-tier atom that lets an account create its own PERSONAL agent principal. */
    private static final String OWN_AGENT_ATOM = ToolFaceRegistry.ACTION_OWN_AGENT;

    private static final Set<String> USER_DEFAULT_ATOMS = userDefaultAtoms();

    private static Set<String> userDefaultAtoms() {
        Set<String> atoms = new LinkedHashSet<>(USER_ALLOW_ATOMS);
        atoms.add(OWN_AGENT_ATOM);
        return Set.copyOf(atoms);
    }

    @Autowired
    private WorkspaceFixture workspaceFixture;

    private static final String MATERIALIZED_ACTION = "authorization_role_grant_materialized";
    private static final String AGENT_DEFAULT_ACTION = "authorization_agent_default_grant_created";

    @Autowired
    private AuthService authService;

    @Autowired
    private com.cc01cc.p.xihe.cp.service.WorkspaceService workspaceService;

    @Autowired
    private GrantDefaultService grantDefaultService;

    @Autowired
    private ImportService importService;

    @Autowired
    private com.cc01cc.p.xihe.cp.service.SessionService sessionService;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private MessageRepository messageRepository;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private ChatAttachmentService chatAttachmentService;

    @Autowired
    private AuditLogRepository auditLogRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private GrantAuthorizationService grantAuthorizationService;

    @Autowired
    private PolicyEngine policyEngine;

    private String userId;
    private String workspaceId;
    private String sessionId;
    private UUID foreignWorkspaceId;
    private final List<UUID> grantIds = new ArrayList<>();
    private final List<UUID> auditIds = new ArrayList<>();
    private final List<UUID> importedSessionIds = new ArrayList<>();

    @Autowired
    private org.springframework.transaction.support.TransactionTemplate cleanTransaction;

    @AfterEach
    void cleanFixtures() {
        cleanTransaction.executeWithoutResult(status -> cleanup());
    }

    private void cleanup() {
        if (sessionId != null) {
            chatAttachmentService.deleteSessionAttachments(sessionId);
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    "agent", UUID.fromString(sessionId)));
            sessionRepository.deleteById(UUID.fromString(sessionId));
        }
        for (UUID importedSessionId : importedSessionIds) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("agent", importedSessionId));
            sessionRepository.deleteById(importedSessionId);
        }
        if (userId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    "user", UUID.fromString(userId)));
            auditLogRepository.findByUserIdOrderByCreatedAtDesc(userId).stream()
                    .filter(row -> MATERIALIZED_ACTION.equals(row.getAction()))
                    .map(AuditLog::getId)
                    .forEach(auditLogRepository::deleteById);
        }
        grantRepository.deleteAllById(grantIds);
        auditLogRepository.deleteAllById(auditIds);
        if (workspaceId != null) {
            workspaceRepository.deleteById(UUID.fromString(workspaceId));
        }
        if (foreignWorkspaceId != null) {
            workspaceRepository.deleteById(foreignWorkspaceId);
            foreignWorkspaceId = null;
        }
        if (userId != null) {
            userRepository.deleteById(UUID.fromString(userId));
        }
    }

    /** PLAN-0470 #25: reproduces the AuthController register orchestration for fixtures. */
    private AuthResponse register(RegisterRequest request) {
        User user = authService.registerUser(request);
        return authService.issueTokens(user, workspaceFixture.createOwnedWorkspace("Fixture Workspace", user.getId().toString()).getId().toString());
    }

    @Test
    void userAndRootSessionCreationMaterializeAuditedDefaultGrantsIdempotently() {
        AuthResponse registered = register(new RegisterRequest(
                "grant-default-" + UUID.randomUUID() + "@test.com", "grant-test-password", "Grant test"));
        userId = registered.getUser().getId();
        workspaceId = registered.getWorkspaceId();
        User user = userRepository.findById(UUID.fromString(userId)).orElseThrow();
        User seededAdmin = userRepository.findByEmail("admin@xihe.local").orElseThrow();

        // PLAN-0610 W1b T1.9: DataSeeder seeds the SUPER_ADMIN instance binding (invariant I1), so
        // the bootstrap admin materializes every action atom of the vocabulary — 16 after PLAN-0622
        // D8 appended CREATE_OWN_AGENT — instead of ADMIN's nine.
        Set<String> seededAdminAtoms = roleAtoms("user", seededAdmin.getId());
        List<AuthorizationGrant> seededAdminRows = roleRows("user", seededAdmin.getId());
        assertEquals(new LinkedHashSet<>(PermissionAtomCatalog.actionAtoms()), seededAdminAtoms,
                "the seeded admin owns SUPER_ADMIN: every action atom of the vocabulary, "
                        + "not a hard-coded count");
        assertTrue(seededAdminAtoms.contains(OWN_AGENT_ATOM),
                "PLAN-0622 D8: CREATE_OWN_AGENT is an action atom, so SUPER_ADMIN carries it");
        assertEquals(PermissionAtomCatalog.actionAtoms().size(), seededAdminRows.size(),
                "one materialized row per action atom; capability atoms are never rows");

        Session session = sessionService.create(userId, workspaceId, "Grant test Session", null, null);
        sessionId = session.getId().toString();

        Set<String> userAtoms = roleAtoms("user", user.getId());
        assertEquals(USER_DEFAULT_ATOMS, userAtoms,
                "PLAN-0622 D8: the USER default is the five allow classes plus CREATE_OWN_AGENT "
                        + "(an account may create its own PERSONAL agent); credential atoms stay out");
        assertTrue(userAtoms.containsAll(USER_ALLOW_ATOMS),
                "D8 appended exactly one atom: the five allow classes are still materialized");
        assertEquals(USER_DEFAULT_ATOMS.size(), roleRows("user", user.getId()).size(),
                "one instance-tier row per USER atom (six after D8)");
        assertEquals(0, grantRepository.findBySubjectTypeAndSubjectId("agent", session.getId()).size(),
                "Session creation no longer materializes a Session-subject Agent default (PLAN-0374 T2.7)");
        assertEquals("read", roleRows("user", user.getId()).get(0).getReadState());

        roleRows("user", user.getId()).forEach(row -> grantIds.add(row.getId()));
        List<AuditLog> auditRows = auditRows(userId, MATERIALIZED_ACTION);
        int auditsBeforeSecondEnsure = auditRows.size();
        assertEquals(2, auditRows.size(),
                "one audit row per materialization *change*, not one per atom: the USER tier on "
                        + "registration and the workspace-owner binding written by the default "
                        + "workspace creation (PLAN-0610 W3-3); the Agent snapshot only appears via "
                        + "an explicit ensure (PLAN-0374 T2.7)");
        auditRows.forEach(row -> auditIds.add(row.getId()));

        grantDefaultService.ensureUserDefault(user);
        grantDefaultService.ensureAgentSessionDefault(session);
        AuthorizationGrant agentDefault = grantRepository.findBySubjectTypeAndSubjectId(
                        "agent", session.getId()).stream()
                .filter(grant -> GrantSources.AGENT_DEFAULT.equals(grant.getSource()))
                .findFirst()
                .orElseThrow();
        grantIds.add(agentDefault.getId());
        assertEquals("read", agentDefault.getReadState());
        assertEquals(USER_DEFAULT_ATOMS.size(), agentDefault.getPermissions().size(),
                "round-2 P1-1: the frozen Agent snapshot keeps the whole USER atom array in one row "
                        + "(six after D8, not five)");
        assertEquals("instance", agentDefault.getScopeType());
        assertEquals(1L, grantRepository.countBySubjectTypeAndSubjectIdAndSource(
                "agent", session.getId(), GrantSources.AGENT_DEFAULT));
        assertEquals((long) USER_DEFAULT_ATOMS.size(), roleRows("user", user.getId()).size(),
                "one instance-tier row per USER atom (the WS_OWNER workspace rows are a different tier)");
        assertEquals(auditsBeforeSecondEnsure, auditRows(userId, MATERIALIZED_ACTION).size(),
                "a second ensureUserDefault with an unchanged set writes no further audit row");
        assertEquals(1, auditRows(userId, AGENT_DEFAULT_ACTION).size());
    }

    /** design #15: registration materializes the USER minimal set, scoped to the registrant's own resources. */
    @Test
    void registeredUserDefaultGrantIsMinimalAndEvaluatorScopesItToOwnWorkspaceOnly() {
        AuthResponse registered = register(
                new RegisterRequest("grant-minimal-" + UUID.randomUUID() + "@test.com",
                        "grant-test-password", "Minimal set test"));
        userId = registered.getUser().getId();
        workspaceId = registered.getWorkspaceId();

        Set<String> userAtoms = roleAtoms("user", UUID.fromString(userId));
        assertEquals(USER_DEFAULT_ATOMS, userAtoms,
                "the materialized USER set carries the five allow classes plus CREATE_OWN_AGENT (D8)");
        roleRows("user", UUID.fromString(userId)).forEach(row -> grantIds.add(row.getId()));

        // PLAN-0622 D8 scope contract: CREATE_OWN_AGENT is a *user-tier* capability (create your
        // OWN agent), not a workspace-instance management atom. It is therefore instance-bindable
        // only — a workspace-scoped binding would mean "create agents for the workspace" — and the
        // USER set still does not carry the tier-creation atoms.
        PermissionAtomCatalog.Atom ownAgentAtom = PermissionAtomCatalog.atom(OWN_AGENT_ATOM);
        assertEquals("instance", ownAgentAtom.scopeClass(),
                "D8: CREATE_OWN_AGENT is declared with scope_class=instance (user tier), not 'both'");
        assertFalse(ownAgentAtom.bindableIn(AccessScope.WORKSPACE),
                "D8: a workspace binding of CREATE_OWN_AGENT is rejected (ROLE_SCOPE_MISMATCH)");
        for (String tierCreation : List.of(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS,
                ToolFaceRegistry.ACTION_CREATE_ACCOUNT)) {
            assertFalse(userAtoms.contains(tierCreation),
                    "D8 does not widen tier creation: " + tierCreation
                            + " still needs its own atom (WORKSPACE/INSTANCE-scope principals)");
        }

        for (String actionClass : USER_ALLOW_ATOMS) {
            assertTrue(grantAuthorizationService.allowsUserOnly(
                            request(actionClass, "notes/today.md")),
                    "the minimal set covers " + actionClass + " on the registrant's own workspace");
        }
        assertTrue(grantAuthorizationService.allowsUserOnly(request(OWN_AGENT_ATOM, "*")),
                "D8: CREATE_OWN_AGENT evaluates allow for the registrant (own PERSONAL agent)");
        assertFalse(grantAuthorizationService.allowsUserOnly(
                        request("credential_use", "credential:" + UUID.randomUUID())),
                "credential is outside the minimal set (zero over-privilege, PLAN-0496 atoms)");

        User foreignOwner = userRepository.save(new User("foreign-" + UUID.randomUUID() + "@test.com",
                "hash", "Foreign owner"));
        Workspace foreignWorkspace = workspaceFixture.createOwnedWorkspace("Foreign",
                foreignOwner.getId().toString());
        foreignWorkspaceId = foreignWorkspace.getId();
        assertFalse(grantAuthorizationService.allowsUserOnly(new PolicyRequest(
                        "read_file", List.of("read"), List.of("src/main.java"), ToolShape.STRUCTURED,
                        userId, foreignWorkspace.getId().toString(), null)),
                "the materialized rows stay confined to workspaces where the registrant is a member");

        assertTrue(policyEngine.allowsByGrant(PolicyContext.EMPTY, "read_file",
                        "{\"params\":{\"arguments\":{\"path\":\"notes/today.md\"}}}",
                        null, userId, workspaceId, true),
                "a workspace-relative read inside the registrant's own workspace passes the gate");
        assertFalse(policyEngine.allowsByGrant(PolicyContext.EMPTY, "write_file",
                        "{\"params\":{\"arguments\":{\"path\":\"C:\\\\outside\\\\secret\"}}}",
                        null, userId, workspaceId, true),
                "the HardGuard L0 floor keeps the minimal set off absolute host paths");
    }

    @Test
    void attachmentUploadCreatesRootSessionWithoutAgentSnapshot() throws IOException {
        AuthResponse registered = register(new RegisterRequest(
                "grant-attachment-" + UUID.randomUUID() + "@test.com", "grant-test-password",
                "Attachment grant test"));
        userId = registered.getUser().getId();
        workspaceId = registered.getWorkspaceId();
        sessionId = UUID.randomUUID().toString();

        BatchUploadResult upload = chatAttachmentService.upload(sessionId,
                List.of(new MockMultipartFile("files", "attachment.txt", "text/plain",
                        "test content".getBytes(StandardCharsets.UTF_8))),
                userId, workspaceId);

        assertEquals(1, upload.getSuccess().size());
        Session session = sessionRepository.findById(UUID.fromString(sessionId)).orElseThrow();
        assertNull(session.getKind(), "attachment upload creates a root Session");
        assertEquals(0L, grantRepository.countBySubjectTypeAndSubjectIdAndSource(
                "agent", session.getId(), GrantSources.AGENT_DEFAULT),
                "attachment placeholder stays principal-null with no Agent snapshot (PLAN-0374 T2.7)");
        grantRepository.findAll().stream()
                .filter(grant -> ("user".equals(grant.getSubjectType())
                        && UUID.fromString(userId).equals(grant.getSubjectId())
                        || "agent".equals(grant.getSubjectType()) && session.getId().equals(grant.getSubjectId()))
                        && GrantSources.EVALUATION_SOURCES.contains(grant.getSource()))
                .map(AuthorizationGrant::getId)
                .forEach(grantIds::add);
        auditRows(userId, MATERIALIZED_ACTION).forEach(row -> auditIds.add(row.getId()));
    }

    @Test
    void importCommitsSuccessfulChatsAndRollsBackOnlyFailedChat() {
        AuthResponse registered = register(new RegisterRequest(
                "grant-import-" + UUID.randomUUID() + "@test.com", "grant-test-password", "Import grant test"));
        userId = registered.getUser().getId();
        workspaceId = registered.getWorkspaceId();
        UUID goodSessionId = UUID.randomUUID();
        UUID badSessionId = UUID.randomUUID();
        UUID laterSessionId = UUID.randomUUID();
        importedSessionIds.add(goodSessionId);
        importedSessionIds.add(badSessionId);
        importedSessionIds.add(laterSessionId);
        String json = """
                {"chats":[
                  {"id":"%s","title":"Good","createdAt":"2024-01-01T00:00:00Z","messages":[]},
                  {"id":"%s","title":"Bad","createdAt":"2024-01-01T00:00:00Z","messages":[
                    {"role":"user","content":"saved before later failure","createdAt":"2024-01-01T00:00:00Z"},
                    {"role":"unknown","content":"bad role","createdAt":"2024-01-01T00:00:00Z"}
                  ]},
                  {"id":"%s","title":"Later","createdAt":"2024-01-01T00:00:00Z","messages":[]}
                ]}
                """.formatted(goodSessionId, badSessionId, laterSessionId);

        ImportService.ImportResult result = importService.importChats(json, userId, workspaceId);

        assertEquals(2, result.getImported());
        assertEquals(0, result.getSkipped());
        assertNotNull(result.getLastError());
        assertEquals(goodSessionId, sessionRepository.findById(goodSessionId).orElseThrow().getId());
        assertFalse(sessionRepository.findById(badSessionId).isPresent(),
                "failed chat Session must roll back with its message insert");
        assertEquals(0, messageRepository.findBySessionIdOrderByCreatedAtAsc(badSessionId.toString()).size(),
                "messages saved before a later message failure must roll back");
        assertTrue(sessionRepository.findById(laterSessionId).isPresent(),
                "a failed chat must not prevent later chats from importing");
        for (UUID session : List.of(goodSessionId, badSessionId, laterSessionId)) {
            assertEquals(0L, grantRepository.countBySubjectTypeAndSubjectIdAndSource(
                    "agent", session, GrantSources.AGENT_DEFAULT),
                    "imported Sessions stay principal-null with no Agent snapshot (PLAN-0374 T2.7)");
        }
    }

    @Test
    void concurrentDefaultEnsureCreatesOneMaterializationAndOneAudit() throws Exception {
        AuthResponse registered = register(new RegisterRequest(
                "grant-concurrent-" + UUID.randomUUID() + "@test.com", "grant-test-password",
                "Concurrent grant test"));
        userId = registered.getUser().getId();
        workspaceId = registered.getWorkspaceId();
        Session session = new Session(workspaceId, userId, "Concurrent default grant Session");
        session.setId(UUID.randomUUID());
        session = sessionRepository.saveAndFlush(session);
        sessionId = session.getId().toString();
        User user = userRepository.findById(UUID.fromString(userId)).orElseThrow();
        grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", user.getId()));
        // The registration materialization already wrote one audit row; the concurrent block is
        // measured on its own delta.
        auditRows(userId, MATERIALIZED_ACTION).forEach(row -> auditLogRepository.deleteById(row.getId()));
        int materializationAuditsBefore = auditRows(userId, MATERIALIZED_ACTION).size();
        CountDownLatch start = new CountDownLatch(1);

        try (ExecutorService executor = Executors.newFixedThreadPool(4)) {
            Session target = session;
            var firstSessionEnsure = executor.submit(() -> {
                start.await();
                grantDefaultService.ensureAgentSessionDefault(target);
                return null;
            });
            var secondSessionEnsure = executor.submit(() -> {
                start.await();
                grantDefaultService.ensureAgentSessionDefault(target);
                return null;
            });
            var firstUserEnsure = executor.submit(() -> {
                start.await();
                grantDefaultService.ensureUserDefault(user);
                return null;
            });
            var secondUserEnsure = executor.submit(() -> {
                start.await();
                grantDefaultService.ensureUserDefault(user);
                return null;
            });
            start.countDown();
            firstSessionEnsure.get(10, TimeUnit.SECONDS);
            secondSessionEnsure.get(10, TimeUnit.SECONDS);
            firstUserEnsure.get(10, TimeUnit.SECONDS);
            secondUserEnsure.get(10, TimeUnit.SECONDS);
        }

        assertEquals(1L, grantRepository.countBySubjectTypeAndSubjectIdAndSource(
                "agent", session.getId(), GrantSources.AGENT_DEFAULT),
                "concurrent ensures keep exactly one frozen Agent snapshot");
        assertEquals((long) USER_DEFAULT_ATOMS.size(), roleRows("user", user.getId()).size(),
                "concurrent ensures keep exactly one instance-tier row per atom (uq_grants_role_atom); "
                        + "six after PLAN-0622 D8 added CREATE_OWN_AGENT");
        assertTrue(roleAtoms("user", user.getId()).contains(OWN_AGENT_ATOM),
                "the extra row is the CREATE_OWN_AGENT atom, not a duplicated base atom");
        // The grants were wiped above, so the first ensure re-creates the instance set (one audit
        // row); the concurrent second ensure changes nothing (no further row).
        assertEquals(materializationAuditsBefore + 1, auditRows(userId, MATERIALIZED_ACTION).size(),
                "the re-materialization audits once and the concurrent second ensure nothing");
        assertEquals(1, auditRows(userId, AGENT_DEFAULT_ACTION).size());
    }

    // ---------------------------------------------------------------- helpers

    /**
     * The subject's <b>instance-tier</b> materialized rows. PLAN-0610 W3-3 binds the workspace creator
     * to {@code WS_OWNER}, which materializes workspace-scope rows for the same subject; the default
     * set assertions are about the instance tier, so the workspace scope is filtered out here.
     */
    private List<AuthorizationGrant> roleRows(String subjectType, UUID subjectId) {
        return grantRepository.findBySubjectTypeAndSubjectIdAndSource(subjectType, subjectId,
                        GrantSources.ROLE).stream()
                .filter(grant -> "instance".equals(grant.getScopeType()))
                .toList();
    }

    private Set<String> roleAtoms(String subjectType, UUID subjectId) {
        Set<String> atoms = new LinkedHashSet<>();
        for (AuthorizationGrant grant : roleRows(subjectType, subjectId)) {
            grant.getPermissions().forEach(atom -> atoms.add(atom.get("actionClass").asText()));
        }
        return atoms;
    }

    private List<AuditLog> auditRows(String actorUserId, String action) {
        return auditLogRepository.findByUserIdOrderByCreatedAtDesc(actorUserId).stream()
                .filter(row -> action.equals(row.getAction()))
                .toList();
    }

    private PolicyRequest request(String actionClass, String resource) {
        return new PolicyRequest("probe_tool", List.of(actionClass), List.of(resource),
                ToolShape.STRUCTURED, userId, workspaceId, null);
    }
}


