package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionOperationRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

class OperationServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private OperationService operationService;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private SessionOperationRepository sessionOperationRepository;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private ChatApprovalRepository approvalRepository;

    @Autowired
    private org.springframework.jdbc.core.JdbcTemplate jdbcTemplate;

    private String authToken;
    private String userId;
    private String workspaceId;
    private String sessionId;
    private String runId;

    @BeforeEach
    void setUp() {
        String email = "op-int-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "OperationIntTest");
        ResponseEntity<AuthResponse> regResponse = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        authToken = regResponse.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow().getId().toString();

        Session session = new Session(workspaceId, userId, "Operation Ledger Session");
        session.setId(UUID.randomUUID());
        sessionId = sessionRepository.save(session).getId().toString();

        ChatRun run = new ChatRun(UUID.randomUUID().toString(), sessionId, userId, workspaceId,
                "op-key-" + UUID.randomUUID().toString().substring(0, 8), "hash", null, null, "none", "running");
        runId = chatRunRepository.save(run).getId().toString();
    }

    private OperationService.OperationStartResult start(String idempotencyKey) {
        return operationService.startOperation(userId, sessionId, workspaceId, null, null,
                "chat", "ui", "user", userId, idempotencyKey, "Test operation");
    }

    /** PLAN-0346: start bound to the setUp run so run-scoped lookups resolve. */
    private OperationService.OperationStartResult startForRun(String idempotencyKey) {
        return operationService.startOperation(userId, sessionId, workspaceId, runId, null,
                "chat", "ui", "user", userId, idempotencyKey, "Test operation");
    }

    @Test
    void startOperation_isIdempotentByIdempotencyKey() {
        String key = "idem-" + UUID.randomUUID();
        OperationService.OperationStartResult first = start(key);
        OperationService.OperationStartResult second = start(key);
        assertFalse(first.alreadyRecorded());
        assertTrue(second.alreadyRecorded());
        assertEquals(first.operationId(), second.operationId());
    }

    @Test
    void startOperation_conflictsOnDuplicateRunId() {
        operationService.startOperation(userId, sessionId, workspaceId, runId, null,
                "chat", "ui", "user", userId, null, "Root op");
        var conflict = assertThrows(com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> operationService.startOperation(userId, sessionId, workspaceId, runId, null,
                        "chat", "ui", "user", userId, null, "Second root op"));
        assertEquals("OPERATION_RUN_CONFLICT", conflict.getCode());
        assertEquals(HttpStatus.CONFLICT, conflict.getStatus());
    }

    @Test
    void transitionOperation_appendsEventAndRejectsIllegalTransition() {
        UUID operationId = start(null).operationId();
        operationService.transitionOperation(operationId, "running", null, null);
        operationService.transitionOperation(operationId, "completed", null, null);

        var conflict = assertThrows(com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> operationService.transitionOperation(operationId, "running", null, null));
        assertEquals("OPERATION_STATE_CONFLICT", conflict.getCode());

        Map<String, Object> trace = operationService.getOperationTrace(operationId);
        assertTrue(trace.containsKey("events"));
    }

    @Test
    void transitionOperation_setsFinishedAtOnTerminalState() {
        UUID operationId = start(null).operationId();
        operationService.transitionOperation(operationId, "failed", "AGENT_FAILED", "ref-1");
        Map<String, Object> trace = operationService.getOperationTrace(operationId);
        com.cc01cc.p.xihe.cp.entity.SessionOperation operation =
                (com.cc01cc.p.xihe.cp.entity.SessionOperation) trace.get("operation");
        assertEquals("failed", operation.getStatus());
        assertEquals("AGENT_FAILED", operation.getErrorCode());
        assertEquals("ref-1", operation.getErrorRef());
        assertNotNull(operation.getFinishedAt());
    }

    @Test
    void appendItem_isIdempotentByToolCallIdAndIncrementsSequence() {
        UUID operationId = start(null).operationId();
        String toolCallId = UUID.randomUUID().toString();
        com.cc01cc.p.xihe.cp.entity.OperationItem first =
                operationService.appendItem(operationId, toolCallId, null, "tool_call", "read_file",
                        "agent", null, null, null);
        com.cc01cc.p.xihe.cp.entity.OperationItem duplicate =
                operationService.appendItem(operationId, toolCallId, null, "tool_call", "read_file",
                        "agent", null, null, null);
        assertEquals(first.getId(), duplicate.getId());

        com.cc01cc.p.xihe.cp.entity.OperationItem second =
                operationService.appendItem(operationId, UUID.randomUUID().toString(), null,
                        "tool_call", "write_file", "agent", null, null, null);
        assertEquals(1, first.getSequence());
        assertEquals(2, second.getSequence());
    }

    @Test
    void transitionItem_conditionalUpdateAndEvent() {
        UUID operationId = start(null).operationId();
        com.cc01cc.p.xihe.cp.entity.OperationItem item =
                operationService.appendItem(operationId, null, null, "tool_call", "apply_patch",
                        "agent", null, null, null);
        operationService.transitionItem(item.getId(), "running", null, null, null, null);
        operationService.transitionItem(item.getId(), "waiting_for_approval", "pending", null, null, null);
        operationService.transitionItem(item.getId(), "resolving", "approved", null, null, null);
        operationService.transitionItem(item.getId(), "completed", "allow", null, "res://ok", null);

        var conflict = assertThrows(com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> operationService.transitionItem(item.getId(), "running", null, null, null, null));
        assertEquals("OPERATION_STATE_CONFLICT", conflict.getCode());

        Map<String, Object> trace = operationService.getOperationTrace(operationId);
        @SuppressWarnings("unchecked")
        List<com.cc01cc.p.xihe.cp.entity.OperationItem> items =
                (List<com.cc01cc.p.xihe.cp.entity.OperationItem>) (Object) trace.get("items");
        assertEquals(1, items.size());
        assertEquals("completed", items.get(0).getStatus());
        assertEquals("allow", items.get(0).getPolicyDecision());
    }

    @Test
    void appendApprovalItem_reachesWaitingForApprovalInOneTransaction() {
        UUID operationId = start(null).operationId();
        String approvalRequestId = UUID.randomUUID().toString();
        approvalRepository.save(new com.cc01cc.p.xihe.cp.entity.ChatApproval(
                approvalRequestId, runId, sessionId, userId, workspaceId,
                "request_approval", "delete file", "README.md",
                "pending", java.time.Instant.now().plusSeconds(300)));
        com.cc01cc.p.xihe.cp.entity.OperationItem item =
                operationService.appendApprovalItem(operationId, approvalRequestId, "request_approval", "{}");
        assertEquals("waiting_for_approval", item.getStatus());
        assertEquals(approvalRequestId, item.getApprovalRequestId());

        operationService.resolveApprovalItem(approvalRequestId, false);
        Map<String, Object> trace = operationService.getOperationTrace(operationId);
        @SuppressWarnings("unchecked")
        List<com.cc01cc.p.xihe.cp.entity.OperationItem> items =
                (List<com.cc01cc.p.xihe.cp.entity.OperationItem>) (Object) trace.get("items");
        assertEquals(1, items.size());
        assertEquals("failed", items.get(0).getStatus());
        assertEquals("APPROVAL_REJECTED", items.get(0).getErrorCode());

        // Rejection terminates the aggregate while waiting; no synthetic
        // running hop is required.
        operationService.transitionOperation(operationId, "running", null, null);
        operationService.transitionOperation(operationId, "waiting_for_approval", null, null);
        operationService.transitionOperation(operationId, "failed", "APPROVAL_REJECTED", null);
        com.cc01cc.p.xihe.cp.entity.SessionOperation aggregate =
                (com.cc01cc.p.xihe.cp.entity.SessionOperation) operationService
                        .getOperationTrace(operationId).get("operation");
        assertEquals("failed", aggregate.getStatus());
        assertNotNull(aggregate.getFinishedAt());
    }

    @Test
    void approvedRunCanFinishWithoutSyntheticRunningHop() {
        // PLAN-292 C1: after the grant is consumed the run's own terminal
        // event is the authoritative transition — waiting_for_approval ->
        // completed must be legal or the operation sticks forever (host
        // journey-c evidence 2026-09-10).
        UUID operationId = start(null).operationId();
        operationService.transitionOperation(operationId, "running", null, null);
        operationService.transitionOperation(operationId, "waiting_for_approval", null, null);

        operationService.transitionOperation(operationId, "completed", null, null);

        com.cc01cc.p.xihe.cp.entity.SessionOperation aggregate =
                (com.cc01cc.p.xihe.cp.entity.SessionOperation) operationService
                        .getOperationTrace(operationId).get("operation");
        assertEquals("completed", aggregate.getStatus());
        assertNotNull(aggregate.getFinishedAt());
    }

    @Test
    void startAttempt_incrementsRetryNoPerStage() {
        UUID operationId = start(null).operationId();
        com.cc01cc.p.xihe.cp.entity.OperationItem item =
                operationService.appendItem(operationId, null, null, "tool_call", "execute_command",
                        "agent", null, null, null);
        com.cc01cc.p.xihe.cp.entity.OperationAttempt first =
                operationService.startAttempt(item.getId(), "runtime_exec", null, "runtime", null);
        operationService.finishAttempt(first.getId(), "timed_out", 504, "TIMEOUT", null, null);
        com.cc01cc.p.xihe.cp.entity.OperationAttempt retry =
                operationService.startAttempt(item.getId(), "runtime_exec", first.getId().toString(),
                        "runtime", null);

        assertEquals(0, first.getRetryNo());
        assertEquals(1, retry.getRetryNo());
        assertEquals(first.getId().toString(), retry.getParentAttemptId());
    }

    @Test
    void startAttempt_isIdempotentByRequestId() {
        UUID operationId = start(null).operationId();
        com.cc01cc.p.xihe.cp.entity.OperationItem item =
                operationService.appendItem(operationId, null, null, "tool_call", "read_file",
                        "agent", null, null, null);
        String requestId = UUID.randomUUID().toString();

        com.cc01cc.p.xihe.cp.entity.OperationAttempt first =
                operationService.startAttempt(item.getId(), "agent_dispatch", null, "agent", requestId);
        com.cc01cc.p.xihe.cp.entity.OperationAttempt duplicate =
                operationService.startAttempt(item.getId(), "agent_dispatch", null, "agent", requestId);

        assertEquals(first.getId(), duplicate.getId());
        assertEquals(0, duplicate.getRetryNo());
    }

    @Test
    void finishAttempt_rejectsDoubleFinish() {
        UUID operationId = start(null).operationId();
        com.cc01cc.p.xihe.cp.entity.OperationItem item =
                operationService.appendItem(operationId, null, null, "tool_call", "read_file",
                        "agent", null, null, null);
        com.cc01cc.p.xihe.cp.entity.OperationAttempt attempt =
                operationService.startAttempt(item.getId(), "agent_dispatch", null, "agent", null);
        operationService.finishAttempt(attempt.getId(), "succeeded", 200, null, null, 10L);
        var conflict = assertThrows(com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> operationService.finishAttempt(attempt.getId(), "failed", 500, "X", null, 20L));
        assertEquals("OPERATION_STATE_CONFLICT", conflict.getCode());
    }

    @Test
    void finishAttempt_isIdempotentForSameTerminalResult_andSupportsUnknown() {
        UUID operationId = start(null).operationId();
        com.cc01cc.p.xihe.cp.entity.OperationItem item =
                operationService.appendItem(operationId, null, null, "tool_call", "read_file",
                        "agent", null, null, null);
        com.cc01cc.p.xihe.cp.entity.OperationAttempt attempt =
                operationService.startAttempt(item.getId(), "agent_dispatch", null, "agent", null);

        operationService.finishAttempt(attempt.getId(), "unknown", null, "DISPATCH_RESULT_UNKNOWN", null, 10L);
        operationService.finishAttempt(attempt.getId(), "unknown", null, "DISPATCH_RESULT_UNKNOWN", null, 10L);

        Map<String, Object> trace = operationService.getOperationTrace(operationId);
        @SuppressWarnings("unchecked")
        List<com.cc01cc.p.xihe.cp.entity.OperationAttempt> attempts =
                (List<com.cc01cc.p.xihe.cp.entity.OperationAttempt>) (Object) trace.get("attempts");
        assertEquals(1, attempts.size());
        assertEquals("unknown", attempts.get(0).getStatus());
    }

    @Test
    void appendExtension_conflictsOnDuplicateKindAndVersion() {
        UUID operationId = start(null).operationId();
        com.cc01cc.p.xihe.cp.entity.OperationItem item =
                operationService.appendItem(operationId, null, null, "chat", null, "agent", null, null, null);
        operationService.appendExtension(item.getId(), null, "llm_usage", 1, "{\"totalTokens\":10}");
        var conflict = assertThrows(com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> operationService.appendExtension(item.getId(), null, "llm_usage", 1,
                        "{\"totalTokens\":20}"));
        assertEquals("OPERATION_EXTENSION_CONFLICT", conflict.getCode());
    }

    @Test
    void appendExtension_isIdempotentForSamePayload() {
        UUID operationId = start(null).operationId();
        com.cc01cc.p.xihe.cp.entity.OperationItem item =
                operationService.appendItem(operationId, null, null, "chat", null, "agent", null, null, null);
        operationService.appendExtension(item.getId(), null, "llm_usage", 1, "{\"totalTokens\":10}");
        assertDoesNotThrow(() -> operationService.appendExtension(item.getId(), null, "llm_usage", 1,
                "{\"totalTokens\":10}"));
    }

    @Test
    void eventsAreAppendOnly_acrossLifecycle() {
        UUID operationId = start(null).operationId();
        operationService.transitionOperation(operationId, "running", null, null);
        com.cc01cc.p.xihe.cp.entity.OperationItem item =
                operationService.appendItem(operationId, null, null, "tool_call", "read_file",
                        "agent", null, null, null);
        operationService.transitionItem(item.getId(), "running", null, null, null, null);
        operationService.transitionItem(item.getId(), "completed", "allow", null, null, null);
        operationService.transitionOperation(operationId, "completed", null, null);

        Map<String, Object> trace = operationService.getOperationTrace(operationId);
        @SuppressWarnings("unchecked")
        List<com.cc01cc.p.xihe.cp.entity.OperationEvent> operationEvents =
                (List<com.cc01cc.p.xihe.cp.entity.OperationEvent>) (Object) trace.get("events");
        assertEquals(6, operationEvents.size());
        assertEquals("operation.started", operationEvents.get(0).getEventType());
        assertEquals("operation.running", operationEvents.get(1).getEventType());
        assertEquals("item.created", operationEvents.get(2).getEventType());
        assertEquals("item.running", operationEvents.get(3).getEventType());
        assertEquals("item.completed", operationEvents.get(4).getEventType());
        assertEquals("operation.completed", operationEvents.get(5).getEventType());
        for (int i = 0; i < operationEvents.size(); i++) {
            assertEquals(i, operationEvents.get(i).getSequence());
        }
    }

    @Test
    void listUserOperations_filtersBySessionAndStatus() {
        start(null);
        UUID operationId = start(null).operationId();
        operationService.transitionOperation(operationId, "completed", null, null);

        Page<com.cc01cc.p.xihe.cp.entity.SessionOperation> all = operationService.listUserOperations(
                userId, sessionId, null, null, PageRequest.of(0, 10, Sort.by("createdAt").descending()));
        assertEquals(2, all.getTotalElements());

        Page<com.cc01cc.p.xihe.cp.entity.SessionOperation> completed = operationService.listUserOperations(
                userId, sessionId, null, "completed", PageRequest.of(0, 10));
        assertEquals(1, completed.getTotalElements());
        assertEquals(operationId, completed.getContent().get(0).getId());

        Page<com.cc01cc.p.xihe.cp.entity.SessionOperation> otherSession = operationService.listUserOperations(
                userId, UUID.randomUUID().toString(), null, null, PageRequest.of(0, 10));
        assertEquals(0, otherSession.getTotalElements());
    }

    @Test
    void userApi_requiresOwnershipAndSupportsPagination() {
        UUID operationId = start("page-key-1").operationId();
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);

        ResponseEntity<Map> own = restTemplate.exchange(
                baseUrl + "/api/v1/operations/" + operationId, HttpMethod.GET,
                new HttpEntity<>(headers), Map.class);
        assertEquals(HttpStatus.OK, own.getStatusCode());
        assertEquals(operationId.toString(), ((Map<?, ?>) own.getBody().get("operation")).get("id").toString());

        // another user must not see the operation (404, not 403)
        String otherEmail = "op-other-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        restTemplate.postForEntity(baseUrl + "/api/v1/auth/register",
                new RegisterRequest(otherEmail, TestDataFactory.PASSWORD, "Other"), AuthResponse.class);
        String otherToken = restTemplate.postForEntity(baseUrl + "/api/v1/auth/login",
                Map.of("email", otherEmail, "password", TestDataFactory.PASSWORD), Map.class)
                .getBody().get("accessToken").toString();
        HttpHeaders otherHeaders = new HttpHeaders();
        otherHeaders.setBearerAuth(otherToken);
        ResponseEntity<Map> foreign = restTemplate.exchange(
                baseUrl + "/api/v1/operations/" + operationId, HttpMethod.GET,
                new HttpEntity<>(otherHeaders), Map.class);
        assertEquals(HttpStatus.NOT_FOUND, foreign.getStatusCode());

        // list endpoint only returns own operations and redacts internal refs
        ResponseEntity<Map> list = restTemplate.exchange(
                baseUrl + "/api/v1/operations?sessionId=" + sessionId + "&size=50",
                HttpMethod.GET, new HttpEntity<>(headers), Map.class);
        assertEquals(HttpStatus.OK, list.getStatusCode());
        List<Map<String, Object>> operations =
                (List<Map<String, Object>>) (Object) list.getBody().get("operations");
        assertEquals(1, operations.size());
        assertFalse(operations.get(0).containsKey("errorRef"));
        assertFalse(operations.get(0).containsKey("resultRef"));
        assertFalse(operations.get(0).containsKey("argumentsPreview"));
        assertFalse(own.getBody().containsKey("errorRef"));
    }

    @Test
    void internalApi_startAndTrace_withServiceToken() {
        HttpHeaders serviceHeaders = new HttpHeaders();
        serviceHeaders.setBearerAuth("dev-token-not-secure");

        Map<String, Object> startBody = Map.of(
                "userId", userId,
                "sessionId", sessionId,
                "workspaceId", workspaceId,
                "runId", runId,
                "kind", "chat",
                "source", "agent",
                "actorType", "agent",
                "idempotencyKey", "internal-idem-" + UUID.randomUUID(),
                "summary", "Internal start");
        ResponseEntity<Map> created = restTemplate.postForEntity(
                baseUrl + "/internal/v1/operations", new HttpEntity<>(startBody, serviceHeaders), Map.class);
        assertEquals(HttpStatus.CREATED, created.getStatusCode());
        String operationId = created.getBody().get("operationId").toString();

        // idempotent replay returns 200 with the same operationId
        ResponseEntity<Map> replayed = restTemplate.postForEntity(
                baseUrl + "/internal/v1/operations", new HttpEntity<>(startBody, serviceHeaders), Map.class);
        assertEquals(HttpStatus.OK, replayed.getStatusCode());
        assertEquals(operationId, replayed.getBody().get("operationId").toString());
        assertEquals(Boolean.TRUE, replayed.getBody().get("alreadyRecorded"));

        ResponseEntity<Map> trace = restTemplate.exchange(
                baseUrl + "/internal/v1/operations/" + operationId + "/trace", HttpMethod.GET,
                new HttpEntity<>(serviceHeaders), Map.class);
        assertEquals(HttpStatus.OK, trace.getStatusCode());
        assertTrue(trace.getBody().containsKey("operation"));
        assertTrue(trace.getBody().containsKey("events"));

        // missing service token is rejected
        ResponseEntity<Map> anonymous = restTemplate.exchange(
                baseUrl + "/internal/v1/operations/" + operationId + "/trace", HttpMethod.GET,
                new HttpEntity<>(new HttpHeaders()), Map.class);
        assertEquals(HttpStatus.UNAUTHORIZED, anonymous.getStatusCode());
    }

    @Test
    void attachPolicySummary_isProjectedOnOwnerAndInternalTraces() {
        UUID operationId = start(null).operationId();
        com.cc01cc.p.xihe.cp.entity.OperationItem item =
                operationService.appendItem(operationId, UUID.randomUUID().toString(), null,
                        "tool_call", "write_file", "mcp", null, null, null);
        operationService.transitionItem(item.getId(), "running", "allow", null, null, null);
        String snapshot = "{\"effect\":\"ask\",\"sourceLayer\":\"builtin\","
                + "\"matchedRule\":\"{ write, \\\"*\\\", ask }\",\"reason\":\"requires approval for domain write\","
                + "\"mode\":\"auto\",\"allowedBy\":\"auto@session\",\"actionClass\":\"write\","
                + "\"shape\":\"structured\"}";
        assertTrue(operationService.attachPolicySummary(item.getId(), snapshot));

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        ResponseEntity<Map> owner = restTemplate.exchange(
                baseUrl + "/api/v1/operations/" + operationId, HttpMethod.GET,
                new HttpEntity<>(headers), Map.class);
        assertEquals(HttpStatus.OK, owner.getStatusCode());
        List<Map<String, Object>> ownerItems =
                (List<Map<String, Object>>) (Object) owner.getBody().get("items");
        assertEquals(1, ownerItems.size());
        Map<String, Object> ownerPolicy = (Map<String, Object>) ownerItems.get(0).get("policy");
        assertNotNull(ownerPolicy);
        assertEquals(Set.of("effect", "sourceLayer", "matchedRule", "reason", "mode",
                "allowedBy", "actionClass", "shape", "reused"), ownerPolicy.keySet());
        assertEquals("ask", ownerPolicy.get("effect"));
        assertEquals("auto@session", ownerPolicy.get("allowedBy"));
        // V19 snapshot predates the T1.7 reuse annotation: it parses, with `reused` explicitly null.
        assertNull(ownerPolicy.get("reused"));
        assertEquals("allow", ownerItems.get(0).get("policyDecision"));
        assertFalse(ownerPolicy.containsKey("arguments"));
        assertFalse(ownerPolicy.containsKey("details"));

        HttpHeaders serviceHeaders = new HttpHeaders();
        serviceHeaders.setBearerAuth("dev-token-not-secure");
        ResponseEntity<Map> internal = restTemplate.exchange(
                baseUrl + "/internal/v1/operations/" + operationId + "/trace", HttpMethod.GET,
                new HttpEntity<>(serviceHeaders), Map.class);
        assertEquals(HttpStatus.OK, internal.getStatusCode());
        List<Map<String, Object>> internalItems =
                (List<Map<String, Object>>) (Object) internal.getBody().get("items");
        assertEquals(1, internalItems.size());
        assertEquals(ownerPolicy, internalItems.get(0).get("policy"));
    }

    @Test
    void attachPolicySummary_legacyRowAndRepeatAttachAreSafe() {
        // pre-V19 rows (no snapshot) must omit `policy` while keeping the legacy marker.
        UUID operationId = start(null).operationId();
        com.cc01cc.p.xihe.cp.entity.OperationItem legacy =
                operationService.appendItem(operationId, UUID.randomUUID().toString(), null,
                        "tool_call", "read_file", "mcp", null, null, null);
        operationService.transitionItem(legacy.getId(), "running", "allow", null, null, null);

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        ResponseEntity<Map> owner = restTemplate.exchange(
                baseUrl + "/api/v1/operations/" + operationId, HttpMethod.GET,
                new HttpEntity<>(headers), Map.class);
        List<Map<String, Object>> items =
                (List<Map<String, Object>>) (Object) owner.getBody().get("items");
        assertFalse(items.get(0).containsKey("policy"));
        assertEquals("allow", items.get(0).get("policyDecision"));

        // Missing item: skip safely, never create a second item.
        assertFalse(operationService.attachPolicySummary(UUID.randomUUID(),
                "{\"effect\":\"allow\",\"sourceLayer\":\"builtin\",\"matchedRule\":null,"
                        + "\"reason\":\"allowed by read rules\",\"mode\":\"manual\",\"allowedBy\":null,"
                        + "\"actionClass\":\"read\",\"shape\":\"structured\"}"));
        // Unsafe / malformed payloads are rejected instead of persisted.
        assertFalse(operationService.attachPolicySummary(legacy.getId(), "{\"effect\":\"ask\"}"));
        assertFalse(operationService.attachPolicySummary(legacy.getId(),
                "{\"arguments\":{\"path\":\"/etc/passwd\"}}"));
        assertNull(operationService.findItem(legacy.getId().toString()).getPolicySummary());
    }

    @Test
    void attachPolicySummary_firstWriteWinsOnReplay() {
        UUID operationId = start(null).operationId();
        com.cc01cc.p.xihe.cp.entity.OperationItem item =
                operationService.appendItem(operationId, UUID.randomUUID().toString(), null,
                        "tool_call", "read_file", "mcp", null, null, null);
        String first = "{\"effect\":\"allow\",\"sourceLayer\":\"builtin\",\"matchedRule\":null,"
                + "\"reason\":\"allowed by read rules\",\"mode\":\"manual\",\"allowedBy\":null,"
                + "\"actionClass\":\"read\",\"shape\":\"structured\"}";
        String replay = "{\"effect\":\"deny\",\"sourceLayer\":\"instance\",\"matchedRule\":null,"
                + "\"reason\":\"denied later\",\"mode\":\"manual\",\"allowedBy\":null,"
                + "\"actionClass\":\"read\",\"shape\":\"structured\"}";

        assertTrue(operationService.attachPolicySummary(item.getId(), first));
        assertFalse(operationService.attachPolicySummary(item.getId(), replay));

        Map<String, Object> trace = operationService.getOperationTrace(operationId);
        @SuppressWarnings("unchecked")
        List<com.cc01cc.p.xihe.cp.entity.OperationItem> items =
                (List<com.cc01cc.p.xihe.cp.entity.OperationItem>) (Object) trace.get("items");
        assertEquals(first, items.get(0).getPolicySummary());
    }

    @Test
    void v19PolicySummaryColumnAppliedByFlyway() {
        // PLAN-0328 T1.15: the Flyway-managed integration schema carries the new column
        // (ddl-auto=validate only; Flyway is the sole schema manager).
        String dataType = jdbcTemplate.queryForObject(
                "SELECT data_type FROM information_schema.columns "
                        + "WHERE table_schema = 'public' AND table_name = 'operation_items' "
                        + "AND column_name = 'policy_summary'",
                String.class);
        assertEquals("text", dataType);
        Integer applied = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '19' AND success = true",
                Integer.class);
        assertEquals(1, applied);
    }

    @Test
    void getOperationTrace_returns404ForUnknownOperation() {
        UUID unknown = UUID.randomUUID();
        var missing = assertThrows(IllegalArgumentException.class,
                () -> operationService.getOperationTrace(unknown));
        assertTrue(missing instanceof com.cc01cc.p.xihe.cp.config.CpApiException api
                        && "OPERATION_NOT_FOUND".equals(api.getCode()),
                "expected OPERATION_NOT_FOUND but got: " + missing.getMessage());
    }

    // ── PLAN-0346 gaps B/C/D: concurrency + reconciliation semantics ────

    @Test
    void appendExtension_samePayloadFromTwoThreads_isIdempotentNot409() throws Exception {
        // Gap B: concurrent duplicate delivery hit the unique index and returned
        // a spurious 409 instead of an idempotent hit. Two threads race the same
        // (itemId, kind, version, payload): exactly one insert wins, the loser
        // re-reads, compares, and returns quietly. Final state: one row.
        var started = start("key-gapb-" + UUID.randomUUID().toString().substring(0, 8));
        var item = operationService.appendItem(started.operationId(), UUID.randomUUID().toString(),
                null, "tool_call", "probe", "agent", null, null, null);
        String payload = "{\"k\":\"v\"}";

        var executor = java.util.concurrent.Executors.newFixedThreadPool(2);
        var latch = new java.util.concurrent.CountDownLatch(1);
        var futures = new java.util.ArrayList<java.util.concurrent.Future<?>>();
        for (int i = 0; i < 2; i++) {
            futures.add(executor.submit(() -> {
                latch.await();
                operationService.appendExtension(item.getId(), null, "job_state", 1, payload);
                return null;
            }));
        }
        latch.countDown();
        for (var f : futures) {
            f.get(30, java.util.concurrent.TimeUnit.SECONDS); // any 409 surfaces here
        }
        executor.shutdown();

        Integer rows = jdbcTemplate.queryForObject(
                "select count(*) from operation_extensions where item_id = ?::uuid and extension_kind = 'job_state'",
                Integer.class, item.getId().toString());
        assertEquals(1, rows, "concurrent same-payload delivery must leave exactly one row");
    }

    @Test
    void startAttempt_fromTwoThreads_allocatesDistinctRetryNos() throws Exception {
        // Gap C: retryNo allocation now runs under the operation row lock;
        // concurrent starts must get distinct, ordered retryNos (previously a
        // unique-index 409 race).
        var started = start("key-gapc-" + UUID.randomUUID().toString().substring(0, 8));
        var item = operationService.appendItem(started.operationId(), UUID.randomUUID().toString(),
                null, "tool_call", "probe", "agent", null, null, null);

        var executor = java.util.concurrent.Executors.newFixedThreadPool(2);
        var latch = new java.util.concurrent.CountDownLatch(1);
        var futures = new java.util.ArrayList<java.util.concurrent.Future<java.util.UUID>>();
        for (int i = 0; i < 2; i++) {
            final int idx = i;
            futures.add(executor.submit(() -> {
                latch.await();
                return operationService
                        .startAttempt(item.getId(), "cp_forward", null, "cp", UUID.randomUUID().toString())
                        .getId();
            }));
        }
        latch.countDown();
        java.util.Set<java.util.UUID> ids = new java.util.HashSet<>();
        for (var f : futures) {
            ids.add(f.get(30, java.util.concurrent.TimeUnit.SECONDS));
        }
        executor.shutdown();

        assertEquals(2, ids.size(), "both attempts must exist (no 409 lost race)");
        Integer rows = jdbcTemplate.queryForObject(
                "select count(*) from operation_attempts where item_id = ?::uuid and stage = 'cp_forward'",
                Integer.class, item.getId().toString());
        assertEquals(2, rows);
    }

    @Test
    void reconcileStaleOperation_settlesRowsAndKeepsTerminalFacts() {
        // Gap D: row-level reconciliation was implemented but untested —
        // non-terminal attempts → unknown(RUN_RECONCILED), non-terminal items →
        // aborted(RUN_RECONCILED), terminal rows keep their facts.
        var started = startForRun("key-gapd-" + UUID.randomUUID().toString().substring(0, 8));
        var done = operationService.appendItem(started.operationId(), UUID.randomUUID().toString(),
                null, "tool_call", "done-tool", "agent", null, null, null);
        operationService.transitionItem(done.getId(), "completed", null, null, null, null);
        var stuck = operationService.appendItem(started.operationId(), UUID.randomUUID().toString(),
                null, "tool_call", "stuck-tool", "agent", null, null, null);
        operationService.transitionItem(stuck.getId(), "running", null, null, null, null);
        var attempt = operationService.startAttempt(stuck.getId(), "cp_forward", null, "cp", UUID.randomUUID().toString());

        operationService.reconcileStaleOperation(runId, "failed");

        var stuckRow = jdbcTemplate.queryForMap(
                "select status, error_code from operation_items where id = ?::uuid", stuck.getId().toString());
        assertEquals("aborted", stuckRow.get("status"));
        assertEquals("RUN_RECONCILED", stuckRow.get("error_code"));
        var attemptRow = jdbcTemplate.queryForMap(
                "select status, error_code from operation_attempts where id = ?::uuid", attempt.getId().toString());
        assertEquals("unknown", attemptRow.get("status"));
        assertEquals("RUN_RECONCILED", attemptRow.get("error_code"));
        var doneRow = jdbcTemplate.queryForMap(
                "select status from operation_items where id = ?::uuid", done.getId().toString());
        assertEquals("completed", doneRow.get("status"), "terminal rows keep their facts");
    }

    @Test
    void getOperationTrace_pairsAgentAndMcpRowsByToolCallId() {
        // PLAN-0346 gap Q2: the two channel facts of one tool call are paired
        // read-side by tool_call_id; a missing side stays visible as null.
        var started = start("key-gapq2-" + UUID.randomUUID().toString().substring(0, 8));
        String pairedToolCall = UUID.randomUUID().toString();
        var agentRow = operationService.appendItem(started.operationId(), pairedToolCall, null,
                "tool_call", "read_file", "agent", null, null, null);
        var mcpRow = operationService.appendItem(started.operationId(), pairedToolCall, null,
                "tool_call", "read_file", "mcp", null, null, null);
        String singleToolCall = UUID.randomUUID().toString();
        var singleRow = operationService.appendItem(started.operationId(), singleToolCall, null,
                "tool_call", "write_file", "agent", null, null, null);

        Map<String, Object> trace = operationService.getOperationTrace(started.operationId());
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> pairs = (List<Map<String, Object>>) (Object) trace.get("toolCallPairs");
        assertNotNull(pairs);
        assertEquals(2, pairs.size(), "one pair per tool_call_id");
        Map<String, Object> pair = pairs.stream()
                .filter(p -> pairedToolCall.equals(p.get("toolCallId"))).findFirst().orElseThrow();
        assertEquals(agentRow.getId().toString(), pair.get("agentItemId"));
        assertEquals(mcpRow.getId().toString(), pair.get("mcpItemId"));
        Map<String, Object> singlePair = pairs.stream()
                .filter(p -> singleToolCall.equals(p.get("toolCallId"))).findFirst().orElseThrow();
        assertEquals(singleRow.getId().toString(), singlePair.get("agentItemId"));
        assertNull(singlePair.get("mcpItemId"), "missing side is visible as null");

        // The additive field must survive the API projection (owner endpoint).
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        ResponseEntity<Map> owner = restTemplate.exchange(
                baseUrl + "/api/v1/operations/" + started.operationId(), HttpMethod.GET,
                new HttpEntity<>(headers), Map.class);
        assertEquals(HttpStatus.OK, owner.getStatusCode());
        assertNotNull(owner.getBody().get("toolCallPairs"));
    }

    @Test
    void replayOperation_isConsistentForLiveFlowAndDetectsTamperedStatus() {
        // PLAN-0346 gap Q1: replay re-derives statuses from the event stream;
        // a live flow is homomorphic, and a row changed behind the ledger's
        // back is reported as a mismatch.
        var started = start("key-gapq1-" + UUID.randomUUID().toString().substring(0, 8));
        var item = operationService.appendItem(started.operationId(), UUID.randomUUID().toString(),
                null, "tool_call", "read_file", "agent", null, null, null);
        operationService.transitionItem(item.getId(), "running", null, null, null, null);
        var attempt = operationService.startAttempt(item.getId(), "cp_forward", null, "cp",
                UUID.randomUUID().toString());
        operationService.finishAttempt(attempt.getId(), "succeeded", 200, null, null, 5L);
        operationService.transitionItem(item.getId(), "completed", null, null, null, null);

        Map<String, Object> consistent = operationService.replayOperation(started.operationId());
        List<Map<String, Object>> rawEvents = jdbcTemplate.queryForList(
                "select sequence, event_type from operation_events where operation_id = ?::uuid order by sequence",
                started.operationId().toString());
        assertEquals(Boolean.TRUE, consistent.get("consistent"),
                "live flow must replay homomorphically: " + consistent + " raw=" + rawEvents);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> noMismatches = (List<Map<String, Object>>) (Object) consistent.get("mismatches");
        assertEquals(0, noMismatches.size());

        jdbcTemplate.update("update operation_items set status = 'failed' where id = ?::uuid",
                item.getId().toString());
        Map<String, Object> tampered = operationService.replayOperation(started.operationId());
        assertEquals(Boolean.FALSE, tampered.get("consistent"), "tampered row must be detected: " + tampered);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> mismatches = (List<Map<String, Object>>) (Object) tampered.get("mismatches");
        assertEquals(1, mismatches.size());
        assertEquals("item", mismatches.get(0).get("entity"));
        assertEquals(item.getId().toString(), mismatches.get(0).get("id"));
        assertEquals("completed", mismatches.get(0).get("expected"));
        assertEquals("failed", mismatches.get(0).get("actual"));
    }

    @Test
    void writesToDifferentOperationsDoNotBlockEachOther() throws Exception {
        // PLAN-0346 T1.7 scope assertion: the sequence lock is per operation —
        // while operation A's row lock is held open, a write to operation B
        // must complete instead of waiting (no global serialization).
        var opA = start("key-scope-a-" + UUID.randomUUID().toString().substring(0, 8));
        var opB = start("key-scope-b-" + UUID.randomUUID().toString().substring(0, 8));

        var executor = java.util.concurrent.Executors.newSingleThreadExecutor();
        var lockHeld = new java.util.concurrent.CountDownLatch(1);
        var release = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.Future<?> holder = executor.submit(() -> new TransactionTemplate(transactionManager)
                .execute(status -> {
                    sessionOperationRepository.findByIdForUpdate(opA.operationId()).orElseThrow();
                    lockHeld.countDown();
                    try {
                        release.await(30, java.util.concurrent.TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    return null;
                }));
        assertTrue(lockHeld.await(10, java.util.concurrent.TimeUnit.SECONDS),
                "holder must acquire A's row lock");

        var done = new java.util.concurrent.CompletableFuture<java.util.UUID>();
        Thread writer = new Thread(() -> {
            try {
                done.complete(operationService.appendItem(opB.operationId(), UUID.randomUUID().toString(),
                        null, "tool_call", "probe", "agent", null, null, null).getId());
            } catch (Throwable e) {
                done.completeExceptionally(e);
            }
        });
        writer.start();
        try {
            assertNotNull(done.get(10, java.util.concurrent.TimeUnit.SECONDS),
                    "write to another operation must not wait for A's held row lock");
        } finally {
            release.countDown();
            holder.get(30, java.util.concurrent.TimeUnit.SECONDS);
            executor.shutdown();
        }
    }
}
