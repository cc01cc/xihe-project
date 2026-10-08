package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.McpAttempt;
import com.cc01cc.p.xihe.cp.entity.McpDispatchHistory;
import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.McpAttemptRepository;
import com.cc01cc.p.xihe.cp.repository.McpDispatchHistoryRepository;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.time.Instant;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0463 T2.3 / verify V1-V4: MCP execution-domain write paths and the
 * switched Grant tool-call context check against a real PostgreSQL schema.
 */
class McpInvocationIntegrationTest extends AbstractIntegrationTest {

    /** /internal/v1 only accepts the service Bearer (SecurityConfig hasRole INTERNAL_SERVICE). */
    private static final String SERVICE_TOKEN = "dev-token-not-secure";

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private ChatApprovalRepository chatApprovalRepository;
    @Autowired private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private McpInvocationRepository invocationRepository;
    @Autowired private McpAttemptRepository attemptRepository;
    @Autowired private McpDispatchHistoryRepository historyRepository;
    @Autowired private McpInvocationService mcpInvocationService;
    @Autowired private GrantAuthorizationService grantAuthorizationService;
    @Autowired private McpRelayToolRecorder relayToolRecorder;
    @Autowired private ObjectMapper objectMapper;

    private String userId;
    private String otherUserId;
    private String workspaceId;
    private String sessionId;
    private String runId;
    private UUID principalId;

    @BeforeEach
    void setUpFixtures() {
        User user = userRepository.save(new User(
                "mcp-inv-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "MCP invocation test"));
        userId = user.getId().toString();
        User other = userRepository.save(new User(
                "mcp-inv-other-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "MCP other"));
        otherUserId = other.getId().toString();

        Workspace ws = workspaceRepository.save(new Workspace("MCP invocation test", userId));
        workspaceId = ws.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("MCP invocation test agent");
        principal.setCreatedByUserId(userId);
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        principalId = agentPrincipalRepository.saveAndFlush(principal).getId();
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(
                principalId.toString(), workspaceId, objectMapper.createArrayNode()));

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "MCP invocation test session");
        session.setId(UUID.fromString(sessionId));
        session.setAgentPrincipalId(principalId.toString());
        sessionRepository.save(session);

        runId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(runId, sessionId, userId, workspaceId,
                "mcp-inv-run", "hash", "provider", "model", "workspace", "running"));
    }

    @AfterEach
    void cleanFixtures() {
        if (runId != null) {
            chatRunRepository.deleteById(UUID.fromString(runId));
        }
        if (sessionId != null) {
            sessionRepository.deleteById(UUID.fromString(sessionId));
        }
        if (principalId != null) {
            workspaceAgentRepository.deleteById(new WorkspaceAgentId(principalId, UUID.fromString(workspaceId)));
            agentPrincipalRepository.deleteById(principalId);
        }
        if (workspaceId != null) {
            workspaceUserRepository.deleteAll(workspaceUserRepository.findByIdWorkspaceId(UUID.fromString(workspaceId)));
            workspaceRepository.deleteById(UUID.fromString(workspaceId));
        }
        if (userId != null) {
            userRepository.deleteById(UUID.fromString(userId));
        }
        if (otherUserId != null) {
            userRepository.deleteById(UUID.fromString(otherUserId));
        }
    }

    private String open(String toolCallId, String toolName) {
        return mcpInvocationService
                .openAgentInvocation(runId, toolCallId, toolName, UUID.randomUUID().toString(),
                        "{\"path\":\"README.md\"}")
                .orElseThrow().toString();
    }

    /**
     * verify V1: an active in-scope invocation opens idempotently at the gate and
     * authorizes the tool call from its MCP invocation owner row.
     */
    @Test
    void gateInvocationAuthorizesWithoutLegacyOperationRows() {
        String toolCallId = UUID.randomUUID().toString();
        String invocationId = open(toolCallId, "read_file");
        assertEquals(invocationId, open(toolCallId, "read_file"),
                "the gate must be idempotent on (runId, toolCallId)");

        List<McpDispatchHistory> history = mcpInvocationService.historyFor(UUID.fromString(invocationId));
        assertTrue(history.stream().anyMatch(h -> "invocation.opened".equals(h.getEventType())),
                "opening the invocation must append history");

        assertTrue(grantAuthorizationService.hasCurrentAgentToolCall(
                        userId, workspaceId, sessionId, runId, toolCallId, "read_file"),
                "an active in-scope invocation must authorize through its domain row");
        assertEquals(1, invocationRepository.findByRunIdOrderByCreatedAtAsc(runId).size(),
                "the MCP invocation is the durable fact for this tool call");

        // verify V4 negative authorization: a session outside the invocation scope fails closed.
        assertFalse(grantAuthorizationService.hasCurrentAgentToolCall(
                otherUserId, workspaceId, sessionId, runId, toolCallId, "read_file"),
                "a foreign user must fail closed");
        assertFalse(grantAuthorizationService.hasCurrentAgentToolCall(
                userId, workspaceId, sessionId, runId, UUID.randomUUID().toString(), "read_file"),
                "an unknown toolCallId has no invocation row and must fail closed");
    }

    /**
     * verify V2: dispatch finishes {@code unknown} on a transport failure, and the
     * new late-termination route settles it (append-only history) — replay safe.
     */
    @Test
    void unknownDispatchIsSettledByNewLateTerminationRoute() {
        String toolCallId = UUID.randomUUID().toString();
        String invocationId = open(toolCallId, "read_file");
        String requestId = UUID.randomUUID().toString();
        UUID attemptId = mcpInvocationService
                .startDispatchAttempt(UUID.fromString(invocationId), requestId).orElseThrow();

        mcpInvocationService.finishDispatchAttempt(UUID.fromString(invocationId), attemptId, 502,
                "MCP_RUNTIME_UNKNOWN", McpInvocationService.McpDispatchVerdict.UNDECIDABLE);

        McpAttempt attempt = attemptRepository.findById(attemptId).orElseThrow();
        assertEquals("unknown", attempt.getStatus());
        assertEquals("unknown", invocationRepository.findById(UUID.fromString(invocationId))
                .orElseThrow().getStatus());

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("Authorization", "Bearer " + SERVICE_TOKEN);
        HttpEntity<String> request = new HttpEntity<>("{\"confirmed\":true}", headers);
        ResponseEntity<String> response = restTemplate.exchange(
                url("/internal/v1/mcp/invocations/" + invocationId + "/late-termination"),
                HttpMethod.POST, request, String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        assertTrue(response.getBody().contains("\"status\":\"recorded\""), response.getBody());

        assertEquals("late_confirmed", attemptRepository.findById(attemptId).orElseThrow().getStatus());
        assertEquals("completed", invocationRepository.findById(UUID.fromString(invocationId))
                .orElseThrow().getStatus());
        List<McpDispatchHistory> history = mcpInvocationService.historyFor(UUID.fromString(invocationId));
        assertTrue(history.stream().anyMatch(h -> "attempt.late_confirmed".equals(h.getEventType())),
                "the late termination must be an append-only history event");
        assertTrue(history.stream().anyMatch(h -> "attempt.unknown".equals(h.getEventType())));

        // Replay must stay idempotent for status and never rewrite the settled invocation.
        ResponseEntity<String> replay = restTemplate.exchange(
                url("/internal/v1/mcp/invocations/" + invocationId + "/late-termination"),
                HttpMethod.POST, request, String.class);
        assertEquals(HttpStatus.OK, replay.getStatusCode());
        assertEquals("completed", invocationRepository.findById(UUID.fromString(invocationId))
                .orElseThrow().getStatus());

        // An unknown invocation id is a 404 in the contract vocabulary.
        ResponseEntity<String> missing = restTemplate.exchange(
                url("/internal/v1/mcp/invocations/" + UUID.randomUUID() + "/late-termination"),
                HttpMethod.POST, request, String.class);
        assertEquals(HttpStatus.NOT_FOUND, missing.getStatusCode());
        assertTrue(missing.getBody().contains("MCP_INVOCATION_NOT_FOUND"), missing.getBody());
    }

    /** T1.2 (review round-1 #1): the SSE relay's agent_tool attempt lands in mcp_attempts. */
    @Test
    void relayToolCallWritesAgentToolAttemptInTheExecutionDomain() {
        String toolCallId = UUID.randomUUID().toString();
        String requestId = UUID.randomUUID().toString();
        Map<String, Object> payload = new HashMap<>();
        payload.put("type", "tool_call");
        payload.put("tool", "read_file");
        payload.put("run_id", runId);
        payload.put("toolCallId", toolCallId);
        payload.put("arguments", Map.of("path", "README.md"));

        McpRelayToolRecorder.RunState state = McpRelayToolRecorder.RunState.create();
        relayToolRecorder.record("tool_call", payload, runId, requestId, state);

        McpInvocation invocation = invocationRepository
                .findByRunIdAndToolCallIdAndSource(runId, toolCallId, "agent").orElseThrow();
        List<McpAttempt> attempts = attemptRepository
                .findByInvocationIdOrderByStartedAtAsc(invocation.getId());
        assertEquals(1, attempts.size(), "exactly one agent_tool attempt per relay call");
        assertEquals(McpAttempt.STAGE_AGENT_TOOL, attempts.get(0).getStage());
        assertEquals("agent", attempts.get(0).getModule());
        assertEquals("started", attempts.get(0).getStatus());
        assertTrue(state.invocationsByToolCallId().containsKey(toolCallId));
        assertTrue(state.attemptsByToolCallId().containsKey(toolCallId));

        Map<String, Object> result = new HashMap<>();
        result.put("type", "tool_result");
        result.put("tool", "read_file");
        result.put("run_id", runId);
        result.put("toolCallId", toolCallId);
        result.put("result", "ok");
        relayToolRecorder.record("tool_result", result, runId, requestId, state);

        assertEquals("succeeded", attemptRepository.findById(attempts.get(0).getId())
                .orElseThrow().getStatus());
        assertEquals("completed", invocationRepository.findById(invocation.getId())
                .orElseThrow().getStatus());
        assertFalse(state.invocationsByToolCallId().containsKey(toolCallId),
                "the run cursor must release the invocation after settlement");
    }

    /** T1.2 (review round-1 #2): user-direct mutations record an invocation best-effort. */
    @Test
    void deletingApprovalClearsOptionalInvocationReferenceWithoutDeletingInvocation() {
        UUID requestId = UUID.randomUUID();
        ChatApproval approval = new ChatApproval(requestId.toString(), runId, sessionId, userId,
                workspaceId, "write_file", "write fixture", "safe preview", "dispatch_unknown",
                Instant.now().plusSeconds(60));
        chatApprovalRepository.saveAndFlush(approval);

        McpInvocation invocation = new McpInvocation();
        invocation.setId(UUID.randomUUID());
        invocation.setRunId(runId);
        invocation.setSessionId(sessionId);
        invocation.setWorkspaceId(workspaceId);
        invocation.setUserId(userId);
        invocation.setToolCallId(UUID.randomUUID().toString());
        invocation.setToolName("write_file");
        invocation.setSource(McpInvocation.SOURCE_AGENT);
        invocation.setStatus(McpInvocation.STATUS_ACTIVE);
        invocation.setArgumentsPreview("{}");
        invocation.setApprovalRequestId(requestId.toString());
        invocationRepository.saveAndFlush(invocation);

        chatApprovalRepository.delete(approval);
        chatApprovalRepository.flush();

        McpInvocation afterDelete = invocationRepository.findById(invocation.getId()).orElseThrow();
        assertNull(afterDelete.getApprovalRequestId());
        assertEquals(McpInvocation.STATUS_ACTIVE, afterDelete.getStatus());
    }

    @Test
    void directUserMutationRecordsDirectSourceInvocation() {
        String toolCallId = UUID.nameUUIDFromBytes(
                "{\"params\":{\"arguments\":{\"path\":\"a.md\"}}}".getBytes()).toString();
        String invocationId = mcpInvocationService.openDirectUserInvocation(
                sessionId, workspaceId, userId, toolCallId, "write_file",
                UUID.randomUUID().toString(), "{\"path\":\"a.md\"}").orElseThrow().toString();

        McpInvocation invocation = invocationRepository.findById(UUID.fromString(invocationId)).orElseThrow();
        assertEquals(McpInvocation.SOURCE_DIRECT_USER, invocation.getSource());
        assertNull(invocation.getRunId(), "direct-user invocations have no ChatRun");
        assertEquals(workspaceId, invocation.getWorkspaceId());
        assertEquals(userId, invocation.getUserId());
        assertFalse(invocation.getArgumentsPreview().isBlank());

        // Repeating the same body creates a separate direct-user invocation (no run key).
        String second = mcpInvocationService.openDirectUserInvocation(
                sessionId, workspaceId, userId, toolCallId, "write_file",
                UUID.randomUUID().toString(), "{\"path\":\"a.md\"}").orElseThrow().toString();
        assertNotEquals(invocationId, second);
    }

    /**
     * PLAN-0464 T2.2: the relay now records only the MCP execution domain —
 side of the former dual write is gone with
     * LedgerToolRecorder.
     */
    @Test
    void relayRecordsOnlyTheMcpExecutionDomainForTheSameCall() {
        String toolCallId = UUID.randomUUID().toString();
        String requestId = UUID.randomUUID().toString();

        Map<String, Object> payload = new HashMap<>();
        payload.put("type", "tool_call");
        payload.put("tool", "read_file");
        payload.put("run_id", runId);
        payload.put("toolCallId", toolCallId);
        payload.put("arguments", Map.of("path", "README.md"));

        McpRelayToolRecorder.RunState state = McpRelayToolRecorder.RunState.create();
        relayToolRecorder.record("tool_call", payload, runId, requestId, state);

        McpInvocation invocation = invocationRepository
                .findByRunIdAndToolCallIdAndSource(runId, toolCallId, "agent").orElseThrow();
        assertEquals(1, attemptRepository.findByInvocationIdOrderByStartedAtAsc(invocation.getId()).size(),
                "exactly one agent_tool attempt");
        assertTrue(historyRepository.findByInvocationIdOrderBySequenceAsc(invocation.getId())
                .stream().anyMatch(h -> "attempt.started".equals(h.getEventType())));

        Map<String, Object> result = new HashMap<>();
        result.put("type", "tool_result");
        result.put("tool", "read_file");
        result.put("run_id", runId);
        result.put("toolCallId", toolCallId);
        result.put("result", "Tool error: denied");
        relayToolRecorder.record("tool_result", result, runId, requestId, state);

        assertEquals("failed", attemptRepository
                .findByInvocationIdOrderByStartedAtAsc(invocation.getId()).get(0).getStatus());
        assertEquals("failed", invocationRepository.findById(invocation.getId()).orElseThrow().getStatus());
    }
}
