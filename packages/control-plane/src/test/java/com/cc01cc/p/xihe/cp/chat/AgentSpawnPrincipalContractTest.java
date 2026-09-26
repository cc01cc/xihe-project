package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
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
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
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
import org.springframework.test.context.bean.override.mockito.MockitoBean;

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
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.verify;

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
    private ApprovalService approvalService;

    @Autowired
    private AgentSpawnExecutionService executionService;

    @Autowired
    private ChatApprovalRepository chatApprovalRepository;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.OperationItemRepository operationItemRepository;

    @MockitoBean
    private ChatController chatController;

    @MockitoBean
    private ApprovalAgentClient approvalAgentClient;

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
        doAnswer(invocation -> {
            String dispatchedRunId = invocation.getArgument(0);
            ChatRun committedChild = chatRunRepository.findById(UUID.fromString(dispatchedRunId)).orElseThrow();
            assertEquals(1, jdbcTemplate.queryForObject(
                    "SELECT count(*) FROM operation_items WHERE CAST(waiting_on_run_id AS VARCHAR) = ?",
                    Integer.class, dispatchedRunId), "dispatch must observe the committed parent waiting link");
            assertEquals(1, jdbcTemplate.queryForObject(
                    "SELECT count(*) FROM audit_logs WHERE action = 'agent_spawn_created' AND resource_id = ?",
                    Integer.class, committedChild.getSessionId()), "dispatch must observe the committed audit row");
            return true;
        }).when(chatController).dispatchSpawnRun(anyString());

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
        OperationItem parentItem = operationItemRepository.findById(UUID.fromString(parent.itemPk)).orElseThrow();
        assertEquals(spawnRun.getId(), parentItem.getWaitingOnRunId());
        assertEquals(sessionsBefore + 1, sessionCount());
        assertEquals(runsBefore + 1, runCount());
        assertEquals(grantsBefore, grantCount());
        verify(chatController).dispatchSpawnRun(spawnRun.getId().toString());
    }

    @Test
    void spawnRouteRejectsBadBearerAndUnknownReferencesWithoutWrites() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"unknown reference test\"}");
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
    void spawnRequiresExplicitGrantBeforeCreatingApprovalOrChild() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"requires explicit grant\"}");
        grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                "agent_principal", principalId));

        assertNoWrites(() -> {
            ResponseEntity<Map> response = spawnRequest(parent.parentRunId, parent.toolCallId, SERVICE_TOKEN);
            assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
            assertEquals("FORBIDDEN", response.getBody().get("code"));
        });
        assertEquals(0, approvalCount(parent.parentSessionId),
                "grant denial happens before durable approval creation");
    }

    @Test
    void spawnManualApprovalConsumesMatchingGrantWithChildAndWaitingLink() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"approve this child\"}");
        Session parentSession = sessionRepository.findById(UUID.fromString(parent.parentSessionId)).orElseThrow();
        parentSession.setApprovalMode("manual");
        sessionRepository.saveAndFlush(parentSession);
        int sessionsBefore = sessionCount();
        int runsBefore = runCount();

        ResponseEntity<Map> pending = spawnRequest(parent.parentRunId, parent.toolCallId, SERVICE_TOKEN);
        assertEquals(HttpStatus.CONFLICT, pending.getStatusCode());
        assertEquals("APPROVAL_REQUIRED", pending.getBody().get("code"));
        assertEquals(AgentSpawnAuthorizationService.APPROVAL_GRANT_HEADER, pending.getBody().get("retryHeader"));
        String approvalId = (String) pending.getBody().get("approvalRequestId");
        assertNotNull(approvalId);
        assertEquals("awaiting_approval", chatRunRepository.findById(UUID.fromString(parent.parentRunId))
                .orElseThrow().getStatus());
        assertEquals(sessionsBefore, sessionCount());
        assertEquals(runsBefore, runCount());

        approvalService.decide(approvalId, userId, workspaceId, ApprovalDecision.once());
        assertEquals("running", chatRunRepository.findById(UUID.fromString(parent.parentRunId))
                .orElseThrow().getStatus());

        ResponseEntity<Map> approved = postSpawn(
                Map.of("parentRunId", parent.parentRunId, "toolCallId", parent.toolCallId),
                SERVICE_TOKEN, approvalId);
        assertEquals(HttpStatus.OK, approved.getStatusCode());
        String childRunId = (String) approved.getBody().get("runId");
        String childSessionId = (String) approved.getBody().get("sessionId");
        assertEquals(sessionsBefore + 1, sessionCount());
        assertEquals(runsBefore + 1, runCount());
        assertEquals(UUID.fromString(childRunId), operationItemRepository
                .findById(UUID.fromString(parent.itemPk)).orElseThrow().getWaitingOnRunId());
        assertNotNull(chatApprovalRepository.findById(UUID.fromString(approvalId)).orElseThrow()
                .getGrantConsumedAt(), "the one-shot grant is consumed by the child transaction");

        ResponseEntity<Map> replay = postSpawn(
                Map.of("parentRunId", parent.parentRunId, "toolCallId", parent.toolCallId),
                SERVICE_TOKEN, approvalId);
        assertEquals(HttpStatus.OK, replay.getStatusCode());
        assertEquals(childRunId, replay.getBody().get("runId"));
        assertEquals(childSessionId, replay.getBody().get("sessionId"));
        assertEquals(sessionsBefore + 1, sessionCount(), "approval replay must not create another child");
        assertEquals(runsBefore + 1, runCount(), "approval replay must not create another Run");
    }

    @Test
    void spawnRejectsTruncatedPreviewBeforeAuthorization() {
        ParentFixture parent = fixture("spawn_agent",
                "{\"prompt\":\"" + "x".repeat(5000) + "\"}");

        assertNoWrites(() -> {
            ResponseEntity<Map> response = spawnRequest(parent.parentRunId, parent.toolCallId, SERVICE_TOKEN);
            assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
            assertEquals("SPAWN_ARGUMENTS_INVALID", response.getBody().get("code"));
        });
        assertEquals(0, approvalCount(parent.parentSessionId));
    }

    @Test
    void spawnChildSnapshotTakesCurrentBindingCapIntersection() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"narrow child\"}");
        com.fasterxml.jackson.databind.node.ArrayNode narrowed = objectMapper.createArrayNode();
        com.fasterxml.jackson.databind.node.ObjectNode spawn = objectMapper.createObjectNode();
        spawn.put("actionClass", "SPAWN_AGENT");
        narrowed.add(spawn);
        WorkspaceAgent binding = workspaceAgentRepository.findById(
                new WorkspaceAgentId(principalId, UUID.fromString(workspaceId))).orElseThrow();
        binding.setPermissionsSnapshot(narrowed);
        workspaceAgentRepository.saveAndFlush(binding);

        ResponseEntity<Map> response = spawnRequest(parent.parentRunId, parent.toolCallId, SERVICE_TOKEN);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        Session child = sessionRepository.findById(UUID.fromString((String) response.getBody().get("sessionId")))
                .orElseThrow();
        assertEquals(narrowed, child.getAgentPermissionsSnapshot(),
                "the current binding cap may narrow but never expand the parent snapshot");
    }

    @Test
    void mcpSpawnInvocationMatchesDurableToolCallAndUsesActualItemPrimaryKey() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"mcp child task\"}");
        HttpHeaders headers = spawnContextHeaders(parent);
        String mismatchedBody = mcpSpawnBody("different task");

        assertNoWrites(() -> {
            CpApiException mismatch = assertThrows(CpApiException.class,
                    () -> executionService.prepareMcpInvocation(mismatchedBody, headers,
                            parent.parentSessionId, userId, workspaceId));
            assertEquals("SPAWN_ARGUMENTS_CHANGED", mismatch.getCode());
        });

        ChatSubmissionService.SpawnInvocation invocation = executionService.prepareMcpInvocation(
                mcpSpawnBody("mcp child task"), headers, parent.parentSessionId, userId, workspaceId);
        assertEquals(parent.parentRunId, invocation.parentRunId());
        assertEquals(parent.toolCallId, invocation.toolCallId());
        assertEquals(parent.itemPk, invocation.operationItemId().toString());
        assertNotEquals(invocation.operationItemId().toString(), invocation.toolCallId());

        ChatSubmissionService.SpawnResult child = executionService.execute(invocation,
                new ChatSubmissionService.SpawnAuthorization(invocation.authorizationBody(), null, null));
        assertEquals(UUID.fromString(child.runId()), operationItemRepository.findById(
                UUID.fromString(parent.itemPk)).orElseThrow().getWaitingOnRunId());
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = 'agent_spawn_created' AND resource_id = ?",
                Integer.class, child.sessionId()));
    }

    @Test
    void spawnRouteRejectsNonSpawnAndCrossParentItemsWithoutWrites() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"non spawn test\"}");
        String sameParentNonSpawnCallId = appendToolCall(parent, "read_file", "agent");
        assertNoWrites(() -> {
            ResponseEntity<Map> nonSpawn = spawnRequest(
                    parent.parentRunId, sameParentNonSpawnCallId, SERVICE_TOKEN);
            assertEquals(HttpStatus.FORBIDDEN, nonSpawn.getStatusCode());
            assertEquals("FORBIDDEN", nonSpawn.getBody().get("code"));
        });

        ParentFixture secondParent = fixture("spawn_agent", "{\"prompt\":\"cross parent test\"}");
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
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"identity injection test\"}");

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
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"unbound parent test\"}");
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
        parentSession.setApprovalMode("auto");
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
        AuthorizationGrant spawnGrant = new AuthorizationGrant();
        spawnGrant.setId(UUID.randomUUID());
        spawnGrant.setSubjectType("agent_principal");
        spawnGrant.setSubjectId(principalId);
        spawnGrant.setGranterType("user");
        spawnGrant.setGranterId(UUID.fromString(userId));
        spawnGrant.setSource("template");
        spawnGrant.setPermissions(expectedSessionCapNode());
        grantRepository.saveAndFlush(spawnGrant);
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principalId.toString(), workspaceId,
                expectedSessionCapNode()));
    }

    private com.fasterxml.jackson.databind.node.ArrayNode expectedSessionCapNode() {
        com.fasterxml.jackson.databind.node.ArrayNode cap = objectMapper.createArrayNode();
        com.fasterxml.jackson.databind.node.ObjectNode spawn = objectMapper.createObjectNode();
        spawn.put("actionClass", "SPAWN_AGENT");
        cap.add(spawn);
        com.fasterxml.jackson.databind.node.ObjectNode atom = objectMapper.createObjectNode();
        atom.put("actionClass", "read");
        cap.add(atom);
        return cap;
    }

    private String expectedSessionCap() {
        return expectedSessionCapNode().toString();
    }

    private ResponseEntity<Map> spawnRequest(String parentRunId, String toolCallId, String bearer) {
        return postSpawn(Map.of("parentRunId", parentRunId, "toolCallId", toolCallId), bearer, null);
    }

    private ResponseEntity<Map> postSpawn(Map<String, Object> body, String bearer) {
        return postSpawn(body, bearer, null);
    }

    private ResponseEntity<Map> postSpawn(Map<String, Object> body, String bearer, String approvalRequestId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (bearer != null) {
            headers.setBearerAuth(bearer);
        }
        if (approvalRequestId != null) {
            headers.set(AgentSpawnAuthorizationService.APPROVAL_GRANT_HEADER, approvalRequestId);
        }
        return restTemplate.exchange(url("/internal/v1/agents/spawn"), HttpMethod.POST,
                new HttpEntity<>(body, headers), Map.class);
    }

    private HttpHeaders spawnContextHeaders(ParentFixture parent) {
        HttpHeaders headers = new HttpHeaders();
        headers.set("X-Chat-Run-Id", parent.parentRunId);
        headers.set("X-Operation-Id", parent.operationId.toString());
        headers.set("X-Operation-Item-Id", parent.toolCallId);
        return headers;
    }

    private static String mcpSpawnBody(String prompt) {
        return "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":7,"
                + "\"params\":{\"name\":\"spawn_agent\",\"arguments\":{\"prompt\":\""
                + prompt + "\"}}}";
    }

    private int approvalCount(String sessionId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM approval_requests WHERE CAST(session_id AS VARCHAR) = ?",
                Integer.class, sessionId);
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
