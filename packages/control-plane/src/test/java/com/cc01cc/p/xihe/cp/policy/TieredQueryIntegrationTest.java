package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0407 T3.1 / verify V6 — the tiered query internal API on a real PostgreSQL chain:
 * Tier-1 stays grant-free downward, reverse/out-of-chain queries fail closed, and Tier-2 denies
 * without an explicit grant through the single evaluation kernel.
 */
class TieredQueryIntegrationTest extends AbstractIntegrationTest {

    private static final String SERVICE_TOKEN = "dev-token-not-secure";

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;

    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String userId;
    private String workspaceId;
    private String otherWorkspaceId;
    private UUID principalId;
    private final List<UUID> grantIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        if (workspaceId != null) {
            jdbcTemplate.update("DELETE FROM chat_runs WHERE CAST(workspace_id AS VARCHAR) = ?", workspaceId);
            jdbcTemplate.update("DELETE FROM sessions WHERE CAST(workspace_id AS VARCHAR) = ?", workspaceId);
        }
        if (otherWorkspaceId != null) {
            jdbcTemplate.update("DELETE FROM chat_runs WHERE CAST(workspace_id AS VARCHAR) = ?", otherWorkspaceId);
            jdbcTemplate.update("DELETE FROM sessions WHERE CAST(workspace_id AS VARCHAR) = ?", otherWorkspaceId);
        }
        grantIds.forEach(id -> grantRepository.deleteById(id));
        grantIds.clear();
        if (principalId != null && workspaceId != null
                && workspaceAgentRepository.existsById(
                        new WorkspaceAgentId(principalId, UUID.fromString(workspaceId)))) {
            workspaceAgentRepository.deleteById(new WorkspaceAgentId(principalId, UUID.fromString(workspaceId)));
        }
        if (principalId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    "agent_principal", principalId));
            agentPrincipalRepository.deleteById(principalId);
            principalId = null;
        }
        if (otherWorkspaceId != null) {
            workspaceRepository.deleteById(UUID.fromString(otherWorkspaceId));
            otherWorkspaceId = null;
        }
        if (workspaceId != null) {
            workspaceRepository.deleteById(UUID.fromString(workspaceId));
            workspaceId = null;
        }
        if (userId != null) {
            userRepository.deleteById(UUID.fromString(userId));
            userId = null;
        }
    }

    // ---------------------------------------------------------------- Tier-1

    @Test
    void tier1ReturnsExactMetadataDownwardAcrossTheChainWithoutAnyGrant() {
        ensureWorkspace(true);
        Session root = newRootSession("tier1-root");
        ChatRun rootRun = newRun(root, "running");
        Session child = newChildSession(root, rootRun, Session.KIND_SPAWN);
        ChatRun childRun = newRun(child, "streaming");
        Session grandchild = newChildSession(child, childRun, Session.KIND_SPAWN);
        ChatRun grandchildRun = newRun(grandchild, "running");

        ResponseEntity<Map> depthOne = tier1(SERVICE_TOKEN, root.getId().toString(),
                child.getId().toString());
        assertEquals(HttpStatus.OK, depthOne.getStatusCode());
        assertEquals(child.getId().toString(), depthOne.getBody().get("sessionId"));
        assertEquals(childRun.getId().toString(), depthOne.getBody().get("runId"));

        ResponseEntity<Map> depthTwo = tier1(SERVICE_TOKEN, root.getId().toString(),
                grandchild.getId().toString());
        assertEquals(HttpStatus.OK, depthTwo.getStatusCode());
        assertEquals(Set.of("sessionId", "runId", "state", "at"), depthTwo.getBody().keySet(),
                "Tier-1 must carry exactly the spec §5 fields — no content fields");
        assertEquals(grandchild.getId().toString(), depthTwo.getBody().get("sessionId"));
        assertEquals(grandchildRun.getId().toString(), depthTwo.getBody().get("runId"));
        assertEquals("running", depthTwo.getBody().get("state"));
        assertNotNull(depthTwo.getBody().get("at"));
        // no grant rows for any subject were created in this fixture: grant-free is the point
    }

    @Test
    void tier1DeniesReverseOutOfChainCrossWorkspaceAndBrokenLineage() {
        ensureWorkspace(true);
        Session root = newRootSession("tier1-rev-root");
        ChatRun rootRun = newRun(root, "running");
        Session child = newChildSession(root, rootRun, Session.KIND_SPAWN);
        newRun(child, "running");
        Session unrelated = newRootSession("tier1-rev-other");
        newRun(unrelated, "running");

        assertEquals(HttpStatus.FORBIDDEN, tier1(SERVICE_TOKEN,
                child.getId().toString(), root.getId().toString()).getStatusCode(),
                "reverse direction: a child may not query an ancestor's status");
        assertEquals(HttpStatus.FORBIDDEN, tier1(SERVICE_TOKEN,
                root.getId().toString(), unrelated.getId().toString()).getStatusCode(),
                "out-of-chain sessions are denied even inside the same workspace");

        otherWorkspaceId = workspaceRepository.save(
                new Workspace("Tier1 foreign ws", userId)).getId().toString();
        Session foreign = new Session(otherWorkspaceId, userId, "Tier1 foreign");
        foreign.setId(UUID.randomUUID());
        sessionRepository.saveAndFlush(foreign);
        assertEquals(HttpStatus.FORBIDDEN, tier1(SERVICE_TOKEN,
                root.getId().toString(), foreign.getId().toString()).getStatusCode(),
                "cross-workspace query is denied");

        Session dangling = new Session(workspaceId, userId, "Tier1 dangling");
        dangling.setId(UUID.randomUUID());
        dangling.setKind(Session.KIND_SPAWN);
        dangling.setSpawnedFromSessionId(UUID.randomUUID());
        dangling.setSpawnedFromRunId(rootRun.getId());
        dangling.setSpawnedAt(Instant.now());
        sessionRepository.saveAndFlush(dangling);
        assertEquals(HttpStatus.FORBIDDEN, tier1(SERVICE_TOKEN,
                root.getId().toString(), dangling.getId().toString()).getStatusCode(),
                "dangling provenance fails closed");

        Session cycleA = new Session(workspaceId, userId, "Tier1 cycle A");
        cycleA.setId(UUID.randomUUID());
        Session cycleB = new Session(workspaceId, userId, "Tier1 cycle B");
        cycleB.setId(UUID.randomUUID());
        sessionRepository.saveAndFlush(cycleA);
        sessionRepository.saveAndFlush(cycleB);
        ChatRun runA = newRun(cycleA, "running");
        ChatRun runB = newRun(cycleB, "running");
        cycleA.setKind(Session.KIND_SPAWN);
        cycleA.setSpawnedFromSessionId(cycleB.getId());
        cycleA.setSpawnedFromRunId(runB.getId());
        cycleA.setSpawnedAt(Instant.now());
        cycleB.setKind(Session.KIND_SPAWN);
        cycleB.setSpawnedFromSessionId(cycleA.getId());
        cycleB.setSpawnedFromRunId(runA.getId());
        cycleB.setSpawnedAt(Instant.now());
        sessionRepository.saveAndFlush(cycleA);
        sessionRepository.saveAndFlush(cycleB);
        assertEquals(HttpStatus.FORBIDDEN, tier1(SERVICE_TOKEN,
                root.getId().toString(), cycleA.getId().toString()).getStatusCode(),
                "cyclic provenance fails closed instead of looping");
    }

    @Test
    void tier1RequiresTheInternalServiceBearer() {
        ensureWorkspace(true);
        Session root = newRootSession("tier1-auth");
        ChatRun rootRun = newRun(root, "running");
        Session child = newChildSession(root, rootRun, Session.KIND_SPAWN);
        newRun(child, "running");

        assertEquals(HttpStatus.UNAUTHORIZED, tier1(null, root.getId().toString(),
                child.getId().toString()).getStatusCode());
        assertEquals(HttpStatus.UNAUTHORIZED, tier1("wrong-token", root.getId().toString(),
                child.getId().toString()).getStatusCode());
    }

    // ---------------------------------------------------------------- Tier-2

    @Test
    void tier2DeniesWithoutAnExplicitGrantEvenWhenTheChainAllows() {
        ensureWorkspace(true);
        Session root = newBoundRootSession();
        ChatRun rootRun = newRun(root, "running");
        Session child = newChildSession(root, rootRun, Session.KIND_SPAWN);
        child.setAgentPrincipalId(principalId.toString());
        child.setAgentPermissionsSnapshot(readCapNode());
        sessionRepository.saveAndFlush(child);
        newRun(child, "running");
        // binding + session caps allow read, but the principal holds no grant row at all
        ResponseEntity<Map> denied = tier2(SERVICE_TOKEN, root.getId().toString(),
                child.getId().toString());
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(),
                "Tier-2 without an explicit grant must deny (V6)");
    }

    @Test
    void tier2GrantsReadThroughTheSharedKernelButKeepsChainRules() {
        ensureWorkspace(true);
        addPrincipalReadGrant();
        Session root = newBoundRootSession();
        ChatRun rootRun = newRun(root, "running");
        Session child = newChildSession(root, rootRun, Session.KIND_SPAWN);
        child.setAgentPrincipalId(principalId.toString());
        child.setAgentPermissionsSnapshot(readCapNode());
        sessionRepository.saveAndFlush(child);
        newRun(child, "running");
        Session unrelated = newRootSession("tier2-unrelated");
        newRun(unrelated, "running");

        ResponseEntity<Map> allowed = tier2(SERVICE_TOKEN, root.getId().toString(),
                child.getId().toString());
        assertEquals(HttpStatus.OK, allowed.getStatusCode());
        assertEquals(Map.of("allowed", true), allowed.getBody());

        assertEquals(HttpStatus.FORBIDDEN, tier2(SERVICE_TOKEN, child.getId().toString(),
                root.getId().toString()).getStatusCode(),
                "same-chain reverse stays denied even with a grant");
        assertEquals(HttpStatus.FORBIDDEN, tier2(SERVICE_TOKEN, root.getId().toString(),
                unrelated.getId().toString()).getStatusCode(),
                "out-of-chain stays denied even with a grant");
    }

    @Test
    void tier2FailsClosedWhenTheRequesterSessionHasNoPrincipalPath() {
        ensureWorkspace(true);
        Session root = new Session(workspaceId, userId, "Tier2 plain root");
        root.setId(UUID.randomUUID());
        sessionRepository.saveAndFlush(root);
        ChatRun rootRun = newRun(root, "running");
        Session child = newChildSession(root, rootRun, Session.KIND_SPAWN);
        newRun(child, "running");

        assertEquals(HttpStatus.FORBIDDEN, tier2(SERVICE_TOKEN, root.getId().toString(),
                child.getId().toString()).getStatusCode(),
                "a session without an AgentPrincipal path fails closed");
    }

    // ---------------------------------------------------------------- helpers

    private ResponseEntity<Map> tier1(String bearer, String requester, String target) {
        return query("/internal/v1/queries/tier1/status", bearer, requester, target);
    }

    private ResponseEntity<Map> tier2(String bearer, String requester, String target) {
        return query("/internal/v1/queries/tier2/access", bearer, requester, target);
    }

    private ResponseEntity<Map> query(String path, String bearer, String requester, String target) {
        HttpHeaders headers = new HttpHeaders();
        headers.setAccept(List.of(MediaType.APPLICATION_JSON));
        if (bearer != null) {
            headers.setBearerAuth(bearer);
        }
        return restTemplate.exchange(url(path + "?requesterSessionId=" + requester
                        + "&targetSessionId=" + target),
                HttpMethod.GET, new HttpEntity<>(headers), Map.class);
    }

    private void ensureWorkspace(boolean withPrincipal) {
        if (userId != null) {
            return;
        }
        User user = userRepository.save(new User("tier-query-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Tier query test"));
        userId = user.getId().toString();
        workspaceId = workspaceRepository.save(
                new Workspace("Tier query test", userId)).getId().toString();
        if (withPrincipal) {
            AgentPrincipal principal = new AgentPrincipal();
            principal.setName("Tier query principal");
            principal.setCreatedByUserId(userId);
            var snapshot = objectMapper.createObjectNode();
            snapshot.set("permissions", objectMapper.createArrayNode());
            principal.setTemplateSnapshot(snapshot);
            principal = agentPrincipalRepository.saveAndFlush(principal);
            principalId = principal.getId();
            workspaceAgentRepository.saveAndFlush(
                    new WorkspaceAgent(principalId.toString(), workspaceId, readCapNode()));
        }
    }

    private Session newBoundRootSession() {
        Session root = newRootSession("tier2-bound-root");
        root.setAgentPrincipalId(principalId.toString());
        root.setAgentPermissionsSnapshot(readCapNode());
        return sessionRepository.saveAndFlush(root);
    }

    private Session newRootSession(String title) {
        Session session = new Session(workspaceId, userId, title);
        session.setId(UUID.randomUUID());
        return sessionRepository.saveAndFlush(session);
    }

    private Session newChildSession(Session parent, ChatRun parentRun, String kind) {
        Session child = new Session(workspaceId, userId,
                "tier-child-" + UUID.randomUUID().toString().substring(0, 8));
        child.setId(UUID.randomUUID());
        child.setKind(kind);
        child.setSpawnedFromSessionId(parent.getId());
        child.setSpawnedFromRunId(parentRun.getId());
        child.setSpawnedAt(Instant.now());
        return sessionRepository.saveAndFlush(child);
    }

    private ChatRun newRun(Session session, String status) {
        String runId = UUID.randomUUID().toString();
        return chatRunRepository.saveAndFlush(new ChatRun(
                runId, session.getId().toString(), userId, session.getWorkspaceId(),
                "tier-" + runId, "tier-hash", "provider", "model", "workspace", status));
    }

    private com.fasterxml.jackson.databind.node.ArrayNode readCapNode() {
        com.fasterxml.jackson.databind.node.ArrayNode cap = objectMapper.createArrayNode();
        com.fasterxml.jackson.databind.node.ObjectNode atom = objectMapper.createObjectNode();
        atom.put("actionClass", "read");
        cap.add(atom);
        return cap;
    }

    private void addPrincipalReadGrant() {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType("agent_principal");
        grant.setSubjectId(principalId);
        grant.setGranterType("user");
        grant.setGranterId(UUID.fromString(userId));
        grant.setSource("direct");
        grant.setPermissions(readCapNode());
        grantIds.add(grantRepository.saveAndFlush(grant).getId());
    }
}
