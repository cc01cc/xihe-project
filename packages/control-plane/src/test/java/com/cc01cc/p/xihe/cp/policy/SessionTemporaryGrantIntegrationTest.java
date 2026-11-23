package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
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

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-124 / DSD-1509 ② — session-scoped temporary capability tokens (the only explicit exception to
 * "every level of the intersection must hold the atom").
 *
 * <p>Six acceptance readings, one test each:</p>
 * <ol>
 *   <li>no token ⇒ no execution ({@link #noTemporaryGrantMeansNoExecution});</li>
 *   <li>live token ⇒ execution ({@link #aLiveTokenIsWhatCarriesExecution});</li>
 *   <li>expired token ⇒ denied, evaluated in SQL, no scheduler
 *       ({@link #anExpiredTokenStopsCountingWithoutAScheduler});</li>
 *   <li>a token never travels to another session ({@link #aTokenNeverTravelsToAnotherSession});</li>
 *   <li>the token does not widen the action classes it did not carry
 *       ({@link #theTokenDoesNotWidenTheActionClassesItDidNotCarry});</li>
 *   <li>revocation is effective on the very next decision
 *       ({@link #revokingTakesEffectOnTheVeryNextDecision}).</li>
 * </ol>
 *
 * <p>Three gate readings back the write face: creator + {@code session:permission:configure}
 * ({@link #issuingNeedsTheCreatorAndTheConfigureAtom}), the TTL window
 * ({@link #ttlOutsideTheWindowIsRefused}) and the subset gate
 * ({@link #capabilityAtomsAndForeignAtomsAreRefused}).</p>
 */
class SessionTemporaryGrantIntegrationTest extends AbstractReusableIntegrationTest {

    @Autowired
    private GrantAuthorizationService grantAuthorizationService;

    @Autowired
    private SessionTemporaryGrantService temporaryGrantService;

    @Autowired
    private SessionTemporaryGrantStore temporaryGrantStore;

    /** B 类夹具单一来源（BL-326）：生产注册路径就是 ensureUserDefault（本夹具需要人类持有 exec）。 */
    @Autowired
    private GrantDefaultService grantDefaultService;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AuthzContext authzContext;

    private String userId;
    private UUID workspaceId;
    private UUID principalId;
    private final List<UUID> sessionIds = new ArrayList<>();
    private final List<UUID> grantIds = new ArrayList<>();
    private final List<WorkspaceAgentId> workspaceAgentIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        // session_temporary_grants has ON DELETE CASCADE from sessions, so deleting the sessions is
        // also the cleanup of every token these tests issued.
        sessionIds.forEach(sessionRepository::deleteById);
        grantRepository.deleteAllById(grantIds);
        workspaceAgentRepository.deleteAllById(workspaceAgentIds);
        if (principalId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId));
            agentPrincipalRepository.deleteById(principalId);
        }
        if (workspaceId != null) {
            workspaceFixture.unbindWorkspace(workspaceId);
            workspaceRepository.deleteById(workspaceId);
        }
        if (userId != null) {
            userRepository.deleteById(UUID.fromString(userId));
        }
        sessionIds.clear();
        grantIds.clear();
        workspaceAgentIds.clear();
    }

    // ── 1. no grant ⇒ no execution ───────────────────────────────────────────────────────────────

    @Test
    void noTemporaryGrantMeansNoExecution() {
        Session session = newFixture(atoms(ToolFaceRegistry.ACTION_READ, ToolFaceRegistry.ACTION_WRITE,
                ToolFaceRegistry.ACTION_DELETE));

        assertFalse(allows(session, ToolFaceRegistry.ACTION_EXEC),
                "DSD-1500 R2 removed exec from AGENT_USER and WS_EDITOR; without a token the agent "
                        + "must not execute");
        assertTrue(allows(session, ToolFaceRegistry.ACTION_READ),
                "the same session must still read, otherwise the denial above could be a broken path "
                        + "rather than a missing atom");
        assertTrue(temporaryGrantService.list(userId, workspaceId.toString(), session.getId().toString())
                .isEmpty());
    }

    // ── 2. live grant ⇒ execution ────────────────────────────────────────────────────────────────

    @Test
    void aLiveTokenIsWhatCarriesExecution() {
        Session session = newFixture(atoms(ToolFaceRegistry.ACTION_READ));
        assertFalse(allows(session, ToolFaceRegistry.ACTION_EXEC));

        SessionTemporaryGrant token = issue(session, ToolFaceRegistry.ACTION_EXEC);

        assertTrue(token.liveAt(Instant.now()));
        assertTrue(allows(session, ToolFaceRegistry.ACTION_EXEC),
                "a live token is the explicit exception: exec becomes reachable even though no level "
                        + "of the intersection holds it");
        assertEquals(1, temporaryGrantService.list(userId, workspaceId.toString(),
                session.getId().toString()).size());
    }

    // ── 3. expired grant ⇒ denied, no scheduler ──────────────────────────────────────────────────

    @Test
    void anExpiredTokenStopsCountingWithoutAScheduler() {
        Session session = newFixture(atoms(ToolFaceRegistry.ACTION_READ));
        Instant now = Instant.now();
        SessionTemporaryGrant expired = new SessionTemporaryGrant(UUID.randomUUID(), session.getId(),
                workspaceId, principalId,
                List.of(new GrantIntersectionEvaluator.PermissionAtom(ToolFaceRegistry.ACTION_EXEC, "*")),
                UUID.fromString(userId), now.minusSeconds(120), now.minusSeconds(60), null, null);
        temporaryGrantStore.insert(expired);

        assertFalse(allows(session, ToolFaceRegistry.ACTION_EXEC),
                "expiry is a SQL predicate (expires_at > now); nothing scans and deletes rows");
        assertTrue(temporaryGrantStore.listLive(session.getId(), now).isEmpty());
        assertTrue(temporaryGrantStore
                .findLive(session.getId(), principalId, workspaceId, now).isEmpty());
    }

    // ── 4. cross-session isolation (G3 leaf-only) ────────────────────────────────────────────────

    @Test
    void aTokenNeverTravelsToAnotherSession() {
        Session granted = newFixture(atoms(ToolFaceRegistry.ACTION_READ));
        Session sibling = newSession(atoms(ToolFaceRegistry.ACTION_READ));
        issue(granted, ToolFaceRegistry.ACTION_EXEC);

        assertTrue(allows(granted, ToolFaceRegistry.ACTION_EXEC));
        assertFalse(allows(sibling, ToolFaceRegistry.ACTION_EXEC),
                "the token is keyed by the leaf session: a sibling of the same agent principal in the "
                        + "same workspace must not inherit it");
        assertTrue(temporaryGrantStore.listLive(sibling.getId(), Instant.now()).isEmpty());
    }

    // ── 5. no widening for the action classes the token did not carry ────────────────────────────

    @Test
    void theTokenDoesNotWidenTheActionClassesItDidNotCarry() {
        Session session = newFixture(atoms(ToolFaceRegistry.ACTION_READ));
        issue(session, ToolFaceRegistry.ACTION_EXEC);

        assertTrue(allows(session, ToolFaceRegistry.ACTION_EXEC));
        assertTrue(allows(session, ToolFaceRegistry.ACTION_READ));
        assertFalse(allows(session, ToolFaceRegistry.ACTION_WRITE),
                "the token listed exec only: write still has to be held by every level of the "
                        + "intersection, and no level holds it here");
        assertFalse(allows(session, ToolFaceRegistry.ACTION_NETWORK),
                "an action class the token did not list stays denied");
    }

    // ── 6. revocation is effective immediately ──────────────────────────────────────────────────

    @Test
    void revokingTakesEffectOnTheVeryNextDecision() {
        Session session = newFixture(atoms(ToolFaceRegistry.ACTION_READ));
        SessionTemporaryGrant token = issue(session, ToolFaceRegistry.ACTION_EXEC);
        assertTrue(allows(session, ToolFaceRegistry.ACTION_EXEC));

        temporaryGrantService.revoke(userId, workspaceId.toString(), session.getId().toString(),
                token.id().toString());

        assertFalse(allows(session, ToolFaceRegistry.ACTION_EXEC),
                "the decision reads the row on every request, so revocation needs no cache expiry");
        assertTrue(temporaryGrantService.list(userId, workspaceId.toString(),
                session.getId().toString()).isEmpty());
        CpApiException second = assertThrows(CpApiException.class,
                () -> temporaryGrantService.revoke(userId, workspaceId.toString(),
                        session.getId().toString(), token.id().toString()));
        assertEquals("TEMPORARY_GRANT_NOT_FOUND", second.getCode());
    }

    // ── gates ───────────────────────────────────────────────────────────────────────────────────

    @Test
    void issuingNeedsTheCreatorAndTheConfigureAtom() {
        Session session = newFixture(atoms(ToolFaceRegistry.ACTION_READ));

        // Same creator, but the workspace role is downgraded to VIEWER: WS_VIEWER carries read plus
        // USE_WORKSPACE_RUNTIME only. WS_EDITOR is NOT enough here — since task-108 / D-1908 rev3
        // (V178) the editor seed also carries session:permission:configure ("give first, ask later"),
        // so downgrading to EDITOR would leave the gate satisfied and the assertion would pass for the
        // wrong reason.
        workspaceFixture.unbindWorkspaceRole(workspaceId, UUID.fromString(userId));
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId, WorkspaceRole.VIEWER);
        authzContext.invalidateAll();

        CpApiException forbidden = assertThrows(CpApiException.class,
                () -> issue(session, ToolFaceRegistry.ACTION_EXEC));
        assertEquals(403, forbidden.getStatus().value());
        assertEquals("FORBIDDEN", forbidden.getCode());
        assertTrue(forbidden.getMessage().contains("session:permission:configure"),
                "the message must name the missing atom, got: " + forbidden.getMessage());

        // A user who cannot even read the session gets the ordinary session-not-found 404, not a hint
        // that a temporary-grant face exists.
        User stranger = userRepository.save(new User("temp-grant-stranger-" + UUID.randomUUID()
                + "@test.com", "hash", "Temp grant stranger"));
        try {
            CpApiException notFound = assertThrows(CpApiException.class,
                    () -> temporaryGrantService.issue(stranger.getId().toString(),
                            workspaceId.toString(), session.getId().toString(),
                            atoms(ToolFaceRegistry.ACTION_EXEC), null));
            assertEquals(404, notFound.getStatus().value());
            assertEquals("SESSION_NOT_FOUND", notFound.getCode());
        } finally {
            userRepository.deleteById(stranger.getId());
        }
    }

    @Test
    void ttlOutsideTheWindowIsRefused() {
        Session session = newFixture(atoms(ToolFaceRegistry.ACTION_READ));

        for (int ttl : new int[] {59, 28_801}) {
            CpApiException refused = assertThrows(CpApiException.class,
                    () -> temporaryGrantService.issue(userId, workspaceId.toString(),
                            session.getId().toString(), atoms(ToolFaceRegistry.ACTION_EXEC), ttl));
            assertEquals(400, refused.getStatus().value());
            assertTrue(refused.getMessage().contains("between 60 and 28800"),
                    "ttl=" + ttl + " must report the window, got: " + refused.getMessage());
        }
        assertTrue(temporaryGrantStore.listLive(session.getId(), Instant.now()).isEmpty(),
                "a refused issue must not leave a row behind");
    }

    @Test
    void capabilityAtomsAndForeignAtomsAreRefused() {
        Session session = newFixture(atoms(ToolFaceRegistry.ACTION_READ));

        CpApiException capability = assertThrows(CpApiException.class,
                () -> temporaryGrantService.issue(userId, workspaceId.toString(),
                        session.getId().toString(), atoms(PermissionAtomCatalog.CAP_INSTANCE_ADMIN), null));
        assertEquals(400, capability.getStatus().value());
        assertTrue(capability.getMessage().contains("capability atom"),
                "got: " + capability.getMessage());

        // The caller holds read/exec only (USER default set has no MANAGE_ROLES) ⇒ the subset gate must
        // refuse instead of quietly minting an atom the issuer does not hold.
        CpApiException escalation = assertThrows(CpApiException.class,
                () -> issue(session, ToolFaceRegistry.ACTION_MANAGE_ROLES));
        assertEquals(403, escalation.getStatus().value());
        assertEquals("PRIVILEGE_ESCALATION", escalation.getCode());
        assertTrue(escalation.getMessage().contains("Cannot grant an atom the caller does not hold"));
        assertTrue(temporaryGrantStore.listLive(session.getId(), Instant.now()).isEmpty());
    }

    // ── fixture ─────────────────────────────────────────────────────────────────────────────────

    /**
     * OWNER user (instance USER role ⇒ holds exec, workspace OWNER role ⇒ holds
     * {@code session:permission:configure}), an agent principal whose instance grants and Workspace
     * binding cap are both {@code cap}, and one session whose snapshot is the same {@code cap}.
     */
    private Session newFixture(ArrayNode cap) {
        User user = userRepository.save(new User("temp-grant-" + UUID.randomUUID() + "@test.com",
                "hash", "Temp grant test"));
        userId = user.getId().toString();
        grantDefaultService.ensureUserDefault(user);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Temp grant test", userId);
        workspaceId = workspace.getId();
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId, WorkspaceRole.OWNER);

        AgentPrincipal principal = TestAgentPrincipals.newUserAgentPrincipal();
        principal.setName("Temp grant agent");
        principal.setCreatedByUserId(userId);
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        principalId = agentPrincipalRepository.saveAndFlush(principal).getId();
        bindPrincipal(cap);
        addGrant(principalId, cap);
        authzContext.invalidateAll();
        return newSession(cap);
    }

    private Session newSession(ArrayNode cap) {
        Session session = new Session(workspaceId.toString(), userId, "Temp grant session");
        session.setId(UUID.randomUUID());
        session.setAgentPermissionsSnapshot(cap);
        Session saved = sessionRepository.save(session);
        bindPrimaryParticipant(saved.getId().toString(), principalId.toString());
        sessionIds.add(saved.getId());
        return saved;
    }

    private void bindPrincipal(ArrayNode cap) {
        WorkspaceAgent binding = workspaceAgentRepository.saveAndFlush(
                new WorkspaceAgent(principalId.toString(), workspaceId.toString(), cap));
        workspaceAgentIds.add(binding.getId());
    }

    private void addGrant(UUID subjectId, ArrayNode permissions) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(GrantPrincipalPathResolver.AGENT_PRINCIPAL);
        grant.setSubjectId(subjectId);
        grant.setSource(GrantSources.ASSIGNED);
        grant.setPermissions(permissions);
        grantIds.add(grantRepository.save(grant).getId());
    }

    private SessionTemporaryGrant issue(Session session, String... actionClasses) {
        return temporaryGrantService.issue(userId, workspaceId.toString(), session.getId().toString(),
                atoms(actionClasses), null);
    }

    private boolean allows(Session session, String actionClass) {
        return grantAuthorizationService.allows(new PolicyRequest("run_command",
                List.of(actionClass), List.of("*"), ToolShape.OPAQUE, userId, workspaceId.toString(),
                session.getId().toString()));
    }

    private ArrayNode atoms(String... actionClasses) {
        ArrayNode permissions = objectMapper.createArrayNode();
        for (String actionClass : actionClasses) {
            ObjectNode atom = objectMapper.createObjectNode();
            atom.put("actionClass", actionClass);
            permissions.add(atom);
        }
        return permissions;
    }
}
