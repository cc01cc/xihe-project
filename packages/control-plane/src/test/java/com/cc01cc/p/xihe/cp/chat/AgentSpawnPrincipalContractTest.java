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
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUserId;
import com.cc01cc.p.xihe.cp.mcp.McpProxyController;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.OperationItemRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.github.tomakehurst.wiremock.WireMockServer;
import org.awaitility.Awaitility;
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
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.containing;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlPathEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.options;
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
    private WorkspaceUserRepository workspaceUserRepository;

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
    private McpProxyController mcpProxyController;

    @Autowired
    private OperationItemRepository operationItemRepository;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.McpInvocationRepository mcpInvocationRepository;

    @Autowired
    private PlatformTransactionManager transactionManager;

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
    private final List<UUID> restrictedPrincipalIds = new java.util.ArrayList<>();
    private final List<UUID> additionalWorkspaceIds = new java.util.ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        for (UUID additionalWorkspaceId : additionalWorkspaceIds) {
            jdbcTemplate.update("DELETE FROM sessions WHERE CAST(workspace_id AS VARCHAR) = ?",
                    additionalWorkspaceId.toString());
        }
        if (workspaceId != null) {
            jdbcTemplate.update("DELETE FROM sessions WHERE CAST(workspace_id AS VARCHAR) = ?", workspaceId);
            SpawnTestSupport.clearForWorkspace(mcpInvocationRepository, jdbcTemplate, workspaceId);
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
        for (UUID restrictedPrincipalId : restrictedPrincipalIds) {
            WorkspaceAgentId bindingId = new WorkspaceAgentId(restrictedPrincipalId, UUID.fromString(workspaceId));
            if (workspaceAgentRepository.existsById(bindingId)) {
                workspaceAgentRepository.deleteById(bindingId);
            }
            agentPrincipalRepository.deleteById(restrictedPrincipalId);
        }
        restrictedPrincipalIds.clear();
        for (UUID additionalWorkspaceId : additionalWorkspaceIds) {
            workspaceRepository.deleteById(additionalWorkspaceId);
        }
        additionalWorkspaceIds.clear();
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
                    "SELECT count(*) FROM chat_runs WHERE CAST(id AS VARCHAR) = ? "
                            + "AND waiting_on_run_id IS NOT NULL AND waiting_tool_call_id IS NOT NULL",
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
        // PLAN-0464 T1.1/T2.1: the spawn idempotency key is the canonical tool call
        // id, the child run has no operation root, and the waiting link lives here.
        assertEquals(parent.toolCallId, spawnRun.getIdempotencyKey());
        assertNull(operationService.findOperationIdByRunId(spawnRun.getId().toString()));
        assertEquals(parent.parentRunId, spawnRun.getWaitingOnRunId());
        assertEquals(parent.toolCallId, spawnRun.getWaitingToolCallId());

        List<Message> childMessages = messageRepository
                .findBySessionIdOrderByCreatedAtAsc(child.getId().toString());
        assertEquals(1, childMessages.size());
        assertEquals("build the widget", childMessages.get(0).getContent());

        ChatRun parentRun = chatRunRepository.findById(UUID.fromString(parent.parentRunId)).orElseThrow();
        assertEquals("running", parentRun.getStatus());
        OperationItem parentItem = operationItemRepository.findById(UUID.fromString(parent.itemPk)).orElseThrow();
        assertNull(parentItem.getWaitingOnRunId(),
                "PLAN-0464: the waiting link moved off the parent item onto the child run");
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
        ChatRun approvedChild = chatRunRepository.findById(UUID.fromString(childRunId)).orElseThrow();
        assertEquals(parent.parentRunId, approvedChild.getWaitingOnRunId());
        assertEquals(parent.toolCallId, approvedChild.getWaitingToolCallId());
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
    void mcpSpawnInvocationMatchesDurableToolCallAndCarriesInvocationId() {
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
        assertNotNull(invocation.mcpInvocationId());
        assertNotEquals(invocation.mcpInvocationId().toString(), invocation.toolCallId());

        ChatSubmissionService.SpawnResult child = executionService.execute(invocation,
                new ChatSubmissionService.SpawnAuthorization(invocation.authorizationBody(), null, null));
        ChatRun waitingChild = chatRunRepository.findById(UUID.fromString(child.runId())).orElseThrow();
        assertEquals(parent.parentRunId, waitingChild.getWaitingOnRunId());
        assertEquals(parent.toolCallId, waitingChild.getWaitingToolCallId());
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
            // PLAN-0464 T2.1: a direct-user invocation never resolves as an agent
            // spawn call, so the lookup reports "not found", not "forbidden".
            assertEquals(HttpStatus.NOT_FOUND, wrongSource.getStatusCode());
            assertEquals("SPAWN_EVENT_NOT_FOUND", wrongSource.getBody().get("code"));
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

    @Test
    void internalMcpToolCallAuthorizesOnlyTheLiveRunSessionInvocationAndToolName() throws Exception {
        ParentFixture authorized = fixture("read_file", "{\"path\":\"authorized.md\"}");
        ParentFixture restricted = restrictedFixture("read_file", "{\"path\":\"restricted.md\"}");
        markAgentToolCallRunning(restricted);

        WireMockServer runtime = new WireMockServer(options().dynamicPort());
        runtime.start();
        String originalRuntimeUrl = (String) ReflectionTestUtils.getField(mcpProxyController, "runtimeBaseUrl");
        @SuppressWarnings("unchecked")
        Map<String, Map<String, String>> toolCache =
                (Map<String, Map<String, String>>) ReflectionTestUtils.getField(mcpProxyController, "toolServerCache");
        @SuppressWarnings("unchecked")
        Map<String, Instant> cacheTimestamps =
                (Map<String, Instant>) ReflectionTestUtils.getField(mcpProxyController, "cacheTimestamps");
        Map<String, String> oldWorkspaceCache = toolCache.put(workspaceId,
                new ConcurrentHashMap<>(Map.of("read_file", "__system__", "list_directory", "__system__")));
        Instant oldCacheTimestamp = cacheTimestamps.put(workspaceId, Instant.now());
        String runtimePath = "/internal/v1/runtime/workspaces/" + workspaceId + "/mcp";
        runtime.stubFor(post(urlPathEqualTo(runtimePath))
                .withRequestBody(containing("\"method\":\"tools/call\""))
                .willReturn(aResponse().withStatus(200).withHeader("Content-Type", "application/json")
                        .withBody("{\"jsonrpc\":\"2.0\",\"id\":14,\"result\":{\"content\":["
                                + "{\"type\":\"text\",\"text\":\"read-ok\"}],\"isError\":false}}")));
        ReflectionTestUtils.setField(mcpProxyController, "runtimeBaseUrl", runtime.baseUrl());

        try {
            int approvalsBefore = approvalCount(authorized.parentSessionId);

            // Positive: a live in-scope invocation authorizes the dispatch.
            ResponseEntity<String> allowed = mcpToolCall(
                    authorized.parentSessionId, authorized.parentRunId,
                    authorized.operationId.toString(), authorized.toolCallId, "read_file");
            assertEquals(HttpStatus.OK, allowed.getStatusCode(), allowed.getBody());
            runtime.verify(1, postRequestedFor(urlPathEqualTo(runtimePath))
                    .withRequestBody(containing("\"name\":\"read_file\"")));
            int operationItemsAfterAllow = operationItemCount(authorized.operationId);
            assertEquals(approvalsBefore, approvalCount(authorized.parentSessionId));

            // PLAN-0464 T2.2 negatives, re-pointed onto invocation-only semantics
            // (the legacy operation/item tuple check and its X-Operation-Id branch
            // are gone; fail-closed now comes from the invocation scope alone):

            // 1. invocation belongs to a different parent run's Session.
            assertMcpCallDeniedWithoutRuntime(authorized.parentSessionId, restricted.parentRunId,
                    restricted.operationId.toString(), restricted.toolCallId, "read_file", runtimePath, runtime);
            // 2. no durable ChatRun ⇒ no invocation row ⇒ fail closed.
            assertMcpCallDeniedWithoutRuntime(authorized.parentSessionId, UUID.randomUUID().toString(),
                    authorized.operationId.toString(), authorized.toolCallId, "read_file", runtimePath, runtime);
            // 3. tool name disagrees with the durable invocation row.
            assertMcpCallDeniedWithoutRuntime(authorized.parentSessionId, authorized.parentRunId,
                    authorized.operationId.toString(), authorized.toolCallId, "list_directory", runtimePath, runtime);
            // 4. no X-Tool-Call-Id header: the gate claims nothing while the
            //    policy key falls back to the body-derived id, so no row governs it.
            assertMcpCallDeniedWithoutRuntime(authorized.parentSessionId, authorized.parentRunId,
                    authorized.operationId.toString(), null, "read_file", runtimePath, runtime);

            ParentFixture otherWorkspace = fixtureInOtherWorkspace();
            int crossWorkspaceItemsBefore = operationItemCount(otherWorkspace.operationId);
            int crossWorkspaceAttemptsBefore = operationAttemptCount(otherWorkspace.operationId);
            assertMcpCallDeniedWithoutRuntime(otherWorkspace.parentSessionId, otherWorkspace.parentRunId,
                    otherWorkspace.operationId.toString(), otherWorkspace.toolCallId, "read_file", runtimePath,
                    runtime, HttpStatus.NOT_FOUND, null);
            assertEquals(crossWorkspaceItemsBefore, operationItemCount(otherWorkspace.operationId),
                    "cross-workspace rejection must not append an MCP ledger item");
            assertEquals(crossWorkspaceAttemptsBefore, operationAttemptCount(otherWorkspace.operationId),
                    "cross-workspace rejection must not create an attempt");

            // 5. terminal run: the lease check rejects an active invocation row.
            ChatRun terminalRun = chatRunRepository.findById(UUID.fromString(authorized.parentRunId))
                    .orElseThrow();
            terminalRun.setStatus("completed");
            terminalRun.setTerminalAt(Instant.now());
            chatRunRepository.saveAndFlush(terminalRun);
            assertMcpCallDeniedWithoutRuntime(authorized.parentSessionId, authorized.parentRunId,
                    authorized.operationId.toString(), authorized.toolCallId, "read_file", runtimePath, runtime);

            // 6. revoked grant: the policy layer still denies before dispatch.
            ParentFixture revoked = fixture("read_file", "{\"path\":\"revoked.md\"}");
            markAgentToolCallRunning(revoked);
            revokeReadGrant();
            assertMcpCallDeniedWithoutRuntime(revoked.parentSessionId, revoked.parentRunId,
                    revoked.operationId.toString(), revoked.toolCallId, "read_file", runtimePath, runtime);

            assertEquals(operationItemsAfterAllow, operationItemCount(authorized.operationId),
                    "denied caller contexts must not append MCP ledger items");
            assertEquals(approvalsBefore, approvalCount(authorized.parentSessionId),
                    "denied caller contexts must not create approvals");
        } finally {
            ReflectionTestUtils.setField(mcpProxyController, "runtimeBaseUrl", originalRuntimeUrl);
            cacheTimestamps.remove(workspaceId);
            if (oldCacheTimestamp != null) {
                cacheTimestamps.put(workspaceId, oldCacheTimestamp);
            }
            toolCache.remove(workspaceId);
            if (oldWorkspaceCache != null) {
                toolCache.put(workspaceId, oldWorkspaceCache);
            }
            runtime.stop();
        }
    }


    private record ParentFixture(String parentSessionId, String parentRunId, String itemPk,
                                 String toolCallId, UUID operationId) {}

    private ParentFixture restrictedFixture(String toolName, String argumentsPreview) {
        ensureWorkspace();
        AgentPrincipal restricted = new AgentPrincipal();
        restricted.setName("Restricted principal " + UUID.randomUUID().toString().substring(0, 8));
        restricted.setCreatedByUserId(userId);
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        restricted.setTemplateSnapshot(snapshot);
        restricted = agentPrincipalRepository.saveAndFlush(restricted);
        restrictedPrincipalIds.add(restricted.getId());
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(restricted.getId().toString(), workspaceId,
                objectMapper.createArrayNode()));

        Session parentSession = new Session(workspaceId, userId,
                "Restricted parent " + UUID.randomUUID().toString().substring(0, 8));
        parentSession.setId(UUID.randomUUID());
        parentSession.setAgentPrincipalId(restricted.getId().toString());
        parentSession.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        parentSession.setApprovalMode("auto");
        sessionRepository.saveAndFlush(parentSession);

        String parentRunId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(
                parentRunId, parentSession.getId().toString(), userId, workspaceId,
                "restricted-parent-" + parentRunId, "restricted-parent-hash", "provider", "model", "workspace", "running"));
        OperationService.OperationStartResult operation = operationService.startOperation(
                userId, parentSession.getId().toString(), workspaceId, parentRunId,
                UUID.randomUUID().toString(), "chat", "ui", "user", userId,
                "restricted-submit-" + parentRunId, "Restricted parent chat");
        String toolCallId = UUID.randomUUID().toString();
        OperationItem item = operationService.appendItem(operation.operationId(), toolCallId, null,
                "tool_call", toolName, "agent", argumentsPreview, null, null);
        seedInvocation(parentSession.getId().toString(), parentRunId, toolCallId, toolName,
                argumentsPreview, "agent");
        return new ParentFixture(parentSession.getId().toString(), parentRunId,
                item.getId().toString(), toolCallId, operation.operationId());
    }

    private ParentFixture fixtureInOtherWorkspace() {
        ensureWorkspace();
        Workspace otherWorkspace = workspaceRepository.saveAndFlush(
                new Workspace("Cross-workspace gate test", userId));
        String otherWorkspaceId = otherWorkspace.getId().toString();
        additionalWorkspaceIds.add(otherWorkspace.getId());

        Session parentSession = new Session(otherWorkspaceId, userId,
                "Cross-workspace parent " + UUID.randomUUID().toString().substring(0, 8));
        parentSession.setId(UUID.randomUUID());
        parentSession.setAgentPrincipalId(principalId.toString());
        parentSession.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        parentSession.setApprovalMode("auto");
        sessionRepository.saveAndFlush(parentSession);

        String parentRunId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(
                parentRunId, parentSession.getId().toString(), userId, otherWorkspaceId,
                "cross-workspace-parent-" + parentRunId, "cross-workspace-parent-hash",
                "provider", "model", "workspace", "running"));
        OperationService.OperationStartResult operation = operationService.startOperation(
                userId, parentSession.getId().toString(), otherWorkspaceId, parentRunId,
                UUID.randomUUID().toString(), "chat", "ui", "user", userId,
                "cross-workspace-submit-" + parentRunId, "Cross-workspace parent chat");
        String toolCallId = UUID.randomUUID().toString();
        OperationItem item = operationService.appendItem(operation.operationId(), toolCallId, null,
                "tool_call", "read_file", "agent", "{\"path\":\"other.md\"}", null, null);
        operationService.transitionItem(item.getId(), "running", null, null, null, null);
        seedInvocation(parentSession.getId().toString(), parentRunId, toolCallId, "read_file",
                "{\"path\":\"other.md\"}", "agent");
        return new ParentFixture(parentSession.getId().toString(), parentRunId,
                item.getId().toString(), toolCallId, operation.operationId());
    }

    private void markAgentToolCallRunning(ParentFixture parent) {
        operationService.transitionItem(UUID.fromString(parent.itemPk), "running", null, null, null, null);
    }

    private void persistAgentToolCall(ParentFixture parent, String argumentsPreview) {
        OperationItem item = operationService.appendItem(parent.operationId, parent.toolCallId, null,
                "tool_call", "read_file", "agent", argumentsPreview, null, null);
        operationService.transitionItem(item.getId(), "running", null, null, null, null);
    }

    private ResponseEntity<String> mcpToolCall(String sessionId, String runId, String operationId,
                                               String toolCallId, String toolName) throws Exception {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(SERVICE_TOKEN);
        headers.set("X-Workspace-Id", workspaceId);
        headers.set("X-Session-Id", sessionId);
        if (runId != null) {
            headers.set("X-Chat-Run-Id", runId);
        }
        if (operationId != null) {
            headers.set("X-Operation-Id", operationId);
        }
        if (toolCallId != null) {
            headers.set("X-Tool-Call-Id", toolCallId);
            headers.set("X-Operation-Item-Id", toolCallId);
        }
        String body = objectMapper.writeValueAsString(Map.of(
                "jsonrpc", "2.0", "method", "tools/call", "id", 14,
                "params", Map.of("name", toolName, "arguments", Map.of("path", "probe.md"))));
        return restTemplate.postForEntity(url("/api/v1/mcp"), new HttpEntity<>(body, headers), String.class);
    }

    private void assertMcpCallDeniedWithoutRuntime(String sessionId, String runId, String operationId,
                                                   String toolCallId, String toolName, String runtimePath,
                                                   WireMockServer runtime) throws Exception {
        assertMcpCallDeniedWithoutRuntime(sessionId, runId, operationId, toolCallId, toolName,
                runtimePath, runtime, HttpStatus.FORBIDDEN, "FORBIDDEN");
    }

    private void assertMcpCallDeniedWithoutRuntime(String sessionId, String runId, String operationId,
                                                   String toolCallId, String toolName, String runtimePath,
                                                   WireMockServer runtime, HttpStatus expectedStatus,
                                                   String expectedCode) throws Exception {
        int itemCountBefore = workspaceOperationItemCount();
        int attemptCountBefore = workspaceOperationAttemptCount();
        int approvalCountBefore = approvalCount(sessionId);
        int runtimeCallsBefore = runtime.findAll(postRequestedFor(urlPathEqualTo(runtimePath))
                .withRequestBody(containing("\"method\":\"tools/call\""))).size();

        ResponseEntity<String> response = mcpToolCall(sessionId, runId, operationId, toolCallId, toolName);

        assertEquals(expectedStatus, response.getStatusCode());
        if (expectedCode != null) {
            assertEquals(expectedCode, objectMapper.readTree(response.getBody()).path("code").asText());
        }
        assertEquals(itemCountBefore, workspaceOperationItemCount(), "rejected call must not append ledger items");
        assertEquals(attemptCountBefore, workspaceOperationAttemptCount(), "rejected call must not start attempts");
        assertEquals(approvalCountBefore, approvalCount(sessionId), "rejected call must not create approvals");
        assertEquals(runtimeCallsBefore, runtime.findAll(postRequestedFor(urlPathEqualTo(runtimePath))
                .withRequestBody(containing("\"method\":\"tools/call\""))).size(),
                "rejected call must not dispatch to Runtime");
    }

    private int workspaceOperationItemCount() {
        return jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM operation_items item JOIN ledger_operations op ON op.id = item.operation_id "
                        + "WHERE CAST(op.workspace_id AS VARCHAR) = ?",
                Integer.class, workspaceId);
    }

    private int operationItemCount(UUID operationId) {
        return jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM operation_items WHERE operation_id = ?", Integer.class, operationId);
    }

    private int operationAttemptCount(UUID operationId) {
        return jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM operation_attempts attempt "
                        + "JOIN operation_items item ON item.id = attempt.item_id "
                        + "WHERE item.operation_id = ?",
                Integer.class, operationId);
    }

    private int workspaceOperationAttemptCount() {
        return jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM operation_attempts attempt "
                        + "JOIN operation_items item ON item.id = attempt.item_id "
                        + "JOIN ledger_operations op ON op.id = item.operation_id "
                        + "WHERE CAST(op.workspace_id AS VARCHAR) = ?",
                Integer.class, workspaceId);
    }

    private void revokeReadGrant() {
        AuthorizationGrant grant = grantRepository.findBySubjectTypeAndSubjectId("agent_principal", principalId)
                .stream()
                .filter(candidate -> {
                    com.fasterxml.jackson.databind.JsonNode permissions = candidate.getPermissions();
                    for (com.fasterxml.jackson.databind.JsonNode permission : permissions) {
                        if ("read".equals(permission.path("actionClass").asText())) {
                            return true;
                        }
                    }
                    return false;
                })
                .findFirst()
                .orElseThrow();
        ArrayNode remaining = objectMapper.createArrayNode();
        for (com.fasterxml.jackson.databind.JsonNode permission : grant.getPermissions()) {
            if (!"read".equals(permission.path("actionClass").asText())) {
                remaining.add(permission);
            }
        }
        grant.setPermissions(remaining);
        grantRepository.saveAndFlush(grant);
    }

    private ParentFixture fixture(String toolName, String argumentsPreview) {
        return fixture(toolName, argumentsPreview, "agent");
    }

    private ParentFixture fixture(String toolName, String argumentsPreview, String source) {
        return fixture(toolName, argumentsPreview, source, true);
    }

    private ParentFixture fixtureWithoutAgentToolCall(String toolName, String argumentsPreview) {
        return fixture(toolName, argumentsPreview, "agent", false);
    }

    private ParentFixture fixture(String toolName, String argumentsPreview, String source,
                                  boolean createToolCall) {
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
        String itemPk = null;
        if (createToolCall) {
            OperationItem item = operationService.appendItem(operation.operationId(), toolCallId, null,
                    "tool_call", toolName, source, argumentsPreview, null, null);
            itemPk = item.getId().toString();
            seedInvocation(parentSession.getId().toString(), parentRunId, toolCallId, toolName,
                    argumentsPreview, source);
        }
        return new ParentFixture(parentSession.getId().toString(), parentRunId,
                itemPk, toolCallId, operation.operationId());
    }

    private String appendToolCall(ParentFixture parent, String toolName, String source) {
        OperationItem item = operationService.appendItem(parent.operationId,
                UUID.randomUUID().toString(), null, "tool_call", toolName, source, "{}", null, null);
        seedInvocation(parent.parentSessionId, parent.parentRunId, item.getToolCallId(), toolName,
                "{}", source);
        return item.getToolCallId();
    }

    /**
     * PLAN-0464 T2.1: the spawn path reads the execution-domain invocation row.
     * The MCP gate is what creates it in production; fixtures seed the same shape
     * directly (source maps the same way the gate does: non-agent sources become
     * {@code direct_user}).
     */
    private void seedInvocation(String sessionId, String runId, String toolCallId, String toolName,
                                String argumentsPreview, String source) {
        com.cc01cc.p.xihe.cp.entity.McpInvocation invocation =
                new com.cc01cc.p.xihe.cp.entity.McpInvocation();
        invocation.setId(UUID.randomUUID());
        invocation.setSessionId(sessionId);
        invocation.setRunId(runId);
        invocation.setWorkspaceId(workspaceId);
        invocation.setUserId(userId);
        invocation.setToolCallId(toolCallId);
        invocation.setToolName(toolName);
        invocation.setSource("agent".equals(source) ? "agent" : "direct_user");
        invocation.setStatus("active");
        invocation.setArgumentsPreview(argumentsPreview);
        mcpInvocationRepository.saveAndFlush(invocation);
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
        WorkspaceUserId membershipId = new WorkspaceUserId(workspaceId, userId);
        if (!workspaceUserRepository.existsById(membershipId)) {
            workspaceUserRepository.saveAndFlush(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        }
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
        headers.set("X-Tool-Call-Id", parent.toolCallId);
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
