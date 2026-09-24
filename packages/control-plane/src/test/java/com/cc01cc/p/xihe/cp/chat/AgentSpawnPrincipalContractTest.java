package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
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

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AgentSpawnPrincipalContractTest extends AbstractIntegrationTest {

    private static final String SERVICE_TOKEN = "dev-token-not-secure";

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private MessageRepository messageRepository;

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
    private OperationService operationService;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String userId;
    private String workspaceId;
    private UUID principalId;

    @AfterEach
    void cleanFixtures() {
        if (workspaceId != null) {
            jdbcTemplate.update("DELETE FROM sessions WHERE CAST(workspace_id AS VARCHAR) = ?", workspaceId);
        }
        if (principalId != null && workspaceId != null
                && workspaceAgentRepository.existsById(
                        new WorkspaceAgentId(principalId, UUID.fromString(workspaceId)))) {
            workspaceAgentRepository.deleteById(new WorkspaceAgentId(principalId, UUID.fromString(workspaceId)));
        }
        if (principalId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    "agent_principal", principalId));
            agentPrincipalRepository.deleteById(principalId);
        }
        if (workspaceId != null) {
            workspaceRepository.deleteById(UUID.fromString(workspaceId));
        }
        if (userId != null) {
            userRepository.deleteById(UUID.fromString(userId));
        }
    }

    @Test
    void spawnRouteDerivesIdentityFromDurableParentAndCreatesChildInOneTransaction() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"build the widget\"}");
        int sessionsBefore = sessionCount();
        int runsBefore = runCount();
        int grantsBefore = grantCount();

        ResponseEntity<Map> response = spawnRequest(parent.parentRunId, parent.toolCallId, SERVICE_TOKEN);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        Map<String, Object> body = response.getBody();
        assertNotNull(body);
        assertEquals(workspaceId, body.get("workspaceId"));
        assertEquals(principalId.toString(), body.get("principalId"));

        Session child = sessionRepository
                .findById(UUID.fromString((String) body.get("sessionId"))).orElseThrow();
        assertEquals(Session.KIND_SPAWN, child.getKind());
        assertEquals(parent.parentSessionId, child.getSpawnedFromSessionId().toString());
        assertEquals(parent.parentRunId, child.getSpawnedFromRunId().toString());
        assertNotNull(child.getSpawnedAt());
        assertEquals(principalId.toString(), child.getAgentPrincipalId());
        assertEquals(expectedSessionCap(), child.getAgentPermissionsSnapshot().toString());
        Session parentSession = sessionRepository
                .findById(UUID.fromString(parent.parentSessionId)).orElseThrow();
        assertEquals(parentSession.getTitle(), child.getTitle());

        ChatRun spawnRun = chatRunRepository
                .findById(UUID.fromString((String) body.get("runId"))).orElseThrow();
        assertEquals(ChatRun.ORIGIN_SPAWN, spawnRun.getOrigin());
        assertEquals(child.getId().toString(), spawnRun.getSessionId());
        assertEquals(workspaceId, spawnRun.getWorkspaceId());
        assertEquals(parent.itemPk, spawnRun.getIdempotencyKey());
        assertNotEquals(parent.toolCallId, spawnRun.getIdempotencyKey());
        assertNotNull(operationService.findOperationIdByRunId(spawnRun.getId().toString()));

        List<Message> childMessages = messageRepository
                .findBySessionIdOrderByCreatedAtAsc(child.getId().toString());
        assertEquals(1, childMessages.size());
        assertEquals("build the widget", childMessages.get(0).getContent());

        ChatRun parentRun = chatRunRepository.findById(UUID.fromString(parent.parentRunId)).orElseThrow();
        assertEquals("running", parentRun.getStatus());
        assertEquals(sessionsBefore + 1, sessionCount());
        assertEquals(runsBefore + 1, runCount());
        assertEquals(grantsBefore, grantCount());
    }

    @Test
    void spawnRouteRejectsBadBearerAndUnknownReferencesWithoutWrites() {
        ParentFixture parent = fixture("spawn_agent", "{}");
        assertNoWrites(() -> {
            ResponseEntity<Map> wrongToken = spawnRequest(parent.parentRunId, parent.toolCallId, "wrong-token");
            assertEquals(HttpStatus.UNAUTHORIZED, wrongToken.getStatusCode());
            ResponseEntity<Map> noBearer = spawnRequest(parent.parentRunId, parent.toolCallId, null);
            assertEquals(HttpStatus.UNAUTHORIZED, noBearer.getStatusCode());
        });

        assertNoWrites(() -> {
            ResponseEntity<Map> unknownParent = spawnRequest(
                    UUID.randomUUID().toString(), parent.toolCallId, SERVICE_TOKEN);
            assertEquals(HttpStatus.NOT_FOUND, unknownParent.getStatusCode());
            assertEquals("SPAWN_PARENT_RUN_NOT_FOUND", unknownParent.getBody().get("code"));
        });

        assertNoWrites(() -> {
            ResponseEntity<Map> unknownItem = spawnRequest(
                    parent.parentRunId, UUID.randomUUID().toString(), SERVICE_TOKEN);
            assertEquals(HttpStatus.NOT_FOUND, unknownItem.getStatusCode());
            assertEquals("SPAWN_EVENT_NOT_FOUND", unknownItem.getBody().get("code"));
        });
    }

    @Test
    void spawnRouteRejectsNonSpawnAndCrossParentItemsWithoutWrites() {
        ParentFixture parent = fixture("spawn_agent", "{}");
        String sameParentNonSpawnCallId = appendToolCall(parent, "read_file", "agent");
        assertNoWrites(() -> {
            ResponseEntity<Map> nonSpawn = spawnRequest(
                    parent.parentRunId, sameParentNonSpawnCallId, SERVICE_TOKEN);
            assertEquals(HttpStatus.FORBIDDEN, nonSpawn.getStatusCode());
            assertEquals("FORBIDDEN", nonSpawn.getBody().get("code"));
        });

        ParentFixture secondParent = fixture("spawn_agent", "{}");
        String crossParentCallId = secondParent.toolCallId;
        assertNoWrites(() -> {
            ResponseEntity<Map> crossParent = spawnRequest(
                    parent.parentRunId, crossParentCallId, SERVICE_TOKEN);
            assertEquals(HttpStatus.FORBIDDEN, crossParent.getStatusCode());
            assertEquals("FORBIDDEN", crossParent.getBody().get("code"));
        });

        ParentFixture userSourced = fixture("spawn_agent", "{}", "ui");
        String userSourcedCallId = userSourced.toolCallId;
        assertNoWrites(() -> {
            ResponseEntity<Map> wrongSource = spawnRequest(
                    userSourced.parentRunId, userSourcedCallId, SERVICE_TOKEN);
            assertEquals(HttpStatus.FORBIDDEN, wrongSource.getStatusCode());
            assertEquals("FORBIDDEN", wrongSource.getBody().get("code"));
        });
    }

    @Test
    void spawnRouteRejectsInjectedIdentityFieldsWithoutWrites() {
        ParentFixture parent = fixture("spawn_agent", "{}");

        assertNoWrites(() -> {
            Map<String, Object> injected = Map.of(
                    "parentRunId", parent.parentRunId,
                    "toolCallId", parent.toolCallId,
                    "principalId", UUID.randomUUID().toString(),
                    "userId", UUID.randomUUID().toString(),
                    "workspaceId", UUID.randomUUID().toString(),
                    "sessionId", UUID.randomUUID().toString(),
                    "grants", List.of(Map.of("actionClass", "read"))
            );
            ResponseEntity<Map> response = postSpawn(injected, SERVICE_TOKEN);
            assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
            assertEquals("INVALID_REQUEST", response.getBody().get("code"));
        });

        assertNoWrites(() -> {
            ResponseEntity<Map> malformed = spawnRequest(
                    "not-a-uuid", parent.toolCallId, SERVICE_TOKEN);
            assertEquals(HttpStatus.BAD_REQUEST, malformed.getStatusCode());
            assertEquals("INVALID_REQUEST", malformed.getBody().get("code"));
        });

        assertNoWrites(() -> {
            ResponseEntity<Map> missing = postSpawn(
                    Map.of("parentRunId", parent.parentRunId), SERVICE_TOKEN);
            assertEquals(HttpStatus.BAD_REQUEST, missing.getStatusCode());
            assertEquals("INVALID_REQUEST", missing.getBody().get("code"));
        });
    }

    @Test
    void spawnRouteReplaysIdempotentlyAndRejectsHashConflict() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"same spawn\"}");
        int sessionsBefore = sessionCount();
        int runsBefore = runCount();

        ResponseEntity<Map> first = spawnRequest(parent.parentRunId, parent.toolCallId, SERVICE_TOKEN);
        assertEquals(HttpStatus.OK, first.getStatusCode());
        ResponseEntity<Map> second = spawnRequest(parent.parentRunId, parent.toolCallId, SERVICE_TOKEN);
        assertEquals(HttpStatus.OK, second.getStatusCode());
        assertEquals(first.getBody().get("sessionId"), second.getBody().get("sessionId"));
        assertEquals(first.getBody().get("runId"), second.getBody().get("runId"));
        assertEquals(sessionsBefore + 1, sessionCount());
        assertEquals(runsBefore + 1, runCount());

        jdbcTemplate.update("UPDATE chat_runs SET request_hash = ? WHERE CAST(id AS VARCHAR) = ?",
                "f".repeat(64), (String) first.getBody().get("runId"));
        ResponseEntity<Map> conflicting = spawnRequest(parent.parentRunId, parent.toolCallId, SERVICE_TOKEN);
        assertEquals(HttpStatus.CONFLICT, conflicting.getStatusCode());
        assertEquals("IDEMPOTENCY_KEY_CONFLICT", conflicting.getBody().get("code"));
        assertEquals(sessionsBefore + 1, sessionCount());
        assertEquals(runsBefore + 1, runCount());
    }

    @Test
    void spawnRouteRejectsParentWithoutPrincipalOrWorkspaceBindingWithoutWrites() {
        ParentFixture parent = fixture("spawn_agent", "{}");
        Session parentSession = sessionRepository
                .findById(UUID.fromString(parent.parentSessionId)).orElseThrow();
        parentSession.setAgentPrincipalId(null);
        parentSession.setAgentPermissionsSnapshot(null);
        sessionRepository.saveAndFlush(parentSession);

        assertNoWrites(() -> {
            ResponseEntity<Map> response = spawnRequest(parent.parentRunId, parent.toolCallId, SERVICE_TOKEN);
            assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
            assertEquals("FORBIDDEN", response.getBody().get("code"));
        });

        parentSession.setAgentPrincipalId(principalId.toString());
        parentSession.setAgentPermissionsSnapshot(expectedSessionCapNode());
        sessionRepository.saveAndFlush(parentSession);
        workspaceAgentRepository.deleteById(new WorkspaceAgentId(principalId, UUID.fromString(workspaceId)));

        assertNoWrites(() -> {
            ResponseEntity<Map> response = spawnRequest(parent.parentRunId, parent.toolCallId, SERVICE_TOKEN);
            assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
            assertEquals("FORBIDDEN", response.getBody().get("code"));
        });
    }

    @Test
    void concurrentSpawnRequestsCreateExactlyOneChild() throws Exception {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"concurrent spawn\"}");
        int sessionsBefore = sessionCount();
        int runsBefore = runCount();

        ExecutorService executor = Executors.newFixedThreadPool(2);
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        Future<ResponseEntity<Map>> firstFuture = executor.submit(() -> {
            ready.countDown();
            if (!start.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("concurrent spawn test did not release start barrier");
            }
            return spawnRequest(parent.parentRunId, parent.toolCallId, SERVICE_TOKEN);
        });
        Future<ResponseEntity<Map>> secondFuture = executor.submit(() -> {
            ready.countDown();
            if (!start.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("concurrent spawn test did not release start barrier");
            }
            return spawnRequest(parent.parentRunId, parent.toolCallId, SERVICE_TOKEN);
        });
        assertTrue(ready.await(5, TimeUnit.SECONDS), "both spawn requests must reach the start barrier");
        start.countDown();
        ResponseEntity<Map> first;
        ResponseEntity<Map> second;
        try {
            first = firstFuture.get(20, TimeUnit.SECONDS);
            second = secondFuture.get(20, TimeUnit.SECONDS);
        } finally {
            executor.shutdownNow();
        }

        assertEquals(HttpStatus.OK, first.getStatusCode());
        assertEquals(HttpStatus.OK, second.getStatusCode());
        assertEquals(first.getBody().get("sessionId"), second.getBody().get("sessionId"));
        assertEquals(first.getBody().get("runId"), second.getBody().get("runId"));
        assertEquals(sessionsBefore + 1, sessionCount());
        assertEquals(runsBefore + 1, runCount());
    }

    private record ParentFixture(String parentSessionId, String parentRunId, String itemPk,
                                 String toolCallId, UUID operationId) {}

    private ParentFixture fixture(String toolName, String argumentsPreview) {
        return fixture(toolName, argumentsPreview, "agent");
    }

    private ParentFixture fixture(String toolName, String argumentsPreview, String source) {
        ensureWorkspace();
        Session parentSession = new Session(workspaceId, userId,
                "Parent " + UUID.randomUUID().toString().substring(0, 8));
        parentSession.setId(UUID.randomUUID());
        parentSession.setAgentPrincipalId(principalId.toString());
        parentSession.setAgentPermissionsSnapshot(expectedSessionCapNode());
        sessionRepository.saveAndFlush(parentSession);

        String parentRunId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(
                parentRunId, parentSession.getId().toString(), userId, workspaceId,
                "parent-" + parentRunId, "parent-hash", "provider", "model", "workspace", "running"));
        OperationService.OperationStartResult operation = operationService.startOperation(
                userId, parentSession.getId().toString(), workspaceId, parentRunId,
                UUID.randomUUID().toString(), "chat", "ui", "user", userId,
                "parent-submit-" + parentRunId, "Parent chat");
        String toolCallId = UUID.randomUUID().toString();
        OperationItem item = operationService.appendItem(operation.operationId(), toolCallId, null,
                "tool_call", toolName, source, argumentsPreview, null, null);
        return new ParentFixture(parentSession.getId().toString(), parentRunId,
                item.getId().toString(), toolCallId, operation.operationId());
    }

    private String appendToolCall(ParentFixture parent, String toolName, String source) {
        OperationItem item = operationService.appendItem(parent.operationId,
                UUID.randomUUID().toString(), null, "tool_call", toolName, source, "{}", null, null);
        return item.getToolCallId();
    }

    private void ensureWorkspace() {
        if (userId != null) {
            return;
        }
        User user = userRepository.save(new User("spawn-route-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Spawn route test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("Spawn route test", userId));
        workspaceId = workspace.getId().toString();
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Spawn route principal");
        principal.setCreatedByUserId(userId);
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        principal = agentPrincipalRepository.saveAndFlush(principal);
        principalId = principal.getId();
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principalId.toString(), workspaceId,
                expectedSessionCapNode()));
    }

    private com.fasterxml.jackson.databind.node.ArrayNode expectedSessionCapNode() {
        com.fasterxml.jackson.databind.node.ArrayNode cap = objectMapper.createArrayNode();
        com.fasterxml.jackson.databind.node.ObjectNode atom = objectMapper.createObjectNode();
        atom.put("actionClass", "read");
        cap.add(atom);
        return cap;
    }

    private String expectedSessionCap() {
        return expectedSessionCapNode().toString();
    }

    private ResponseEntity<Map> spawnRequest(String parentRunId, String toolCallId, String bearer) {
        return postSpawn(Map.of("parentRunId", parentRunId, "toolCallId", toolCallId), bearer);
    }

    private ResponseEntity<Map> postSpawn(Map<String, Object> body, String bearer) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (bearer != null) {
            headers.setBearerAuth(bearer);
        }
        return restTemplate.exchange(url("/internal/v1/agents/spawn"), HttpMethod.POST,
                new HttpEntity<>(body, headers), Map.class);
    }

    private void assertNoWrites(Runnable assertions) {
        int sessionsBefore = sessionCount();
        int runsBefore = runCount();
        int grantsBefore = grantCount();
        assertions.run();
        assertEquals(sessionsBefore, sessionCount());
        assertEquals(runsBefore, runCount());
        assertEquals(grantsBefore, grantCount());
    }

    private int sessionCount() {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM sessions WHERE CAST(workspace_id AS VARCHAR) = ?",
                Integer.class, workspaceId);
    }

    private int runCount() {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM chat_runs WHERE CAST(workspace_id AS VARCHAR) = ?",
                Integer.class, workspaceId);
    }

    private int grantCount() {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM grants WHERE subject_type = 'agent_principal' "
                        + "AND CAST(subject_id AS VARCHAR) = ?",
                Integer.class, principalId.toString());
    }
}
