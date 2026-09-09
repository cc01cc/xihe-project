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

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

class OperationServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private OperationService operationService;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private ChatApprovalRepository approvalRepository;

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
                "pending", java.time.Instant.now().plusSeconds(300), null, null));
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
    void getOperationTrace_returns404ForUnknownOperation() {
        UUID unknown = UUID.randomUUID();
        var missing = assertThrows(IllegalArgumentException.class,
                () -> operationService.getOperationTrace(unknown));
        assertTrue(missing instanceof com.cc01cc.p.xihe.cp.config.CpApiException api
                        && "OPERATION_NOT_FOUND".equals(api.getCode()),
                "expected OPERATION_NOT_FOUND but got: " + missing.getMessage());
    }
}
