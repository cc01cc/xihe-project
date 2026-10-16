package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.checkpoint.AgentGraphCheckpointService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
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
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.time.Instant;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
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
    @Autowired private LineageInvocationService lineageInvocationService;
    @Autowired private AgentGraphCheckpointService checkpointService;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private GrantAuthorizationService grantAuthorizationService;
    @Autowired private McpRelayToolRecorder relayToolRecorder;
    @Autowired private ObjectMapper objectMapper;

    private String userId;
    private String otherUserId;
    private String workspaceId;
    private String sessionId;
    private String runId;
    private UUID principalId;
    private String childRunId;

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
        if (childRunId != null) {
            chatRunRepository.deleteById(UUID.fromString(childRunId));
        }
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

    @Test
    void lineageLedgerReservesBeforeReplayAndExposesOnlyBoundedIds() {
        String firstToolCallId = UUID.randomUUID().toString();
        String originId = "provider-call-opaque-1";
        String body = "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                + "\"params\":{\"name\":\"write_file\",\"arguments\":{\"path\":\"safe-name.txt\"}}}";
        AgentGraphCheckpointService.LineageView lineage = checkpointService.createLineage(
                new AgentGraphCheckpointService.LineageRequest(
                        sessionId, userId, workspaceId, runId, null, "test-producer-v1"));
        UUID mcpInvocationId = UUID.fromString(open(firstToolCallId, "write_file"));

        LineageInvocationService.ReservationDecision reserved = lineageInvocationService.reserve(
                runId, firstToolCallId, mcpInvocationId, originId, "write_file", body);
        assertEquals(LineageInvocationService.DecisionKind.RESERVED, reserved.kind());
        assertEquals("pending", jdbc.queryForObject(
                "SELECT status FROM agent_lineage_invocations WHERE lineage_id = ? AND originating_tool_call_id = ?",
                String.class, UUID.fromString(lineage.lineageId()), originId));
        assertEquals(64, jdbc.queryForObject(
                "SELECT length(arguments_hash) FROM agent_lineage_invocations WHERE lineage_id = ? AND originating_tool_call_id = ?",
                Integer.class, UUID.fromString(lineage.lineageId()), originId));
        CpApiException pending = assertThrows(CpApiException.class,
                () -> lineageInvocationService.requireContinuationEligible(runId, lineage.lineageId()));
        assertEquals("RECONCILIATION_REQUIRED", pending.getCode());

        UUID attemptId = mcpInvocationService.startDispatchAttempt(mcpInvocationId, UUID.randomUUID().toString())
                .orElseThrow();
        mcpInvocationService.finishDispatchAttempt(mcpInvocationId, attemptId, 200, null,
                McpInvocationService.McpDispatchVerdict.COMPLETED);
        lineageInvocationService.settle(reserved.reservation(), "completed");

        LineageInvocationService.ContinuationAdmission firstAdmission =
                lineageInvocationService.requireContinuationEligible(runId, lineage.lineageId());
        assertEquals(List.of(originId), firstAdmission.completedToolCallIds());
        assertEquals(List.of(runId), firstAdmission.lineageRunIds());

        String changedArguments = "{\"method\":\"tools/call\",\"params\":{\"name\":\"write_file\","
                + "\"arguments\":{\"path\":\"different.txt\"}}}";
        LineageInvocationService.ReservationDecision conflict = lineageInvocationService.reserve(
                runId, firstToolCallId, mcpInvocationId, originId, "write_file", changedArguments);
        assertEquals(LineageInvocationService.DecisionKind.IDENTITY_CONFLICT, conflict.kind());
        assertEquals(1, jdbc.queryForObject(
                "SELECT conflict_count FROM agent_lineage_invocations WHERE lineage_id = ? AND originating_tool_call_id = ?",
                Integer.class, UUID.fromString(lineage.lineageId()), originId));
        assertEquals(0, jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.columns
                 WHERE table_name = 'agent_lineage_invocations'
                   AND column_name IN ('arguments_preview', 'result_body', 'result_json')
                """, Integer.class));

        ChatRun child = new ChatRun(UUID.randomUUID().toString(), sessionId, userId, workspaceId,
                "lineage-child-" + UUID.randomUUID(), "hash", "provider", "model", "workspace", "running");
        child.setBranchId(chatRunRepository.findById(UUID.fromString(runId)).orElseThrow().getBranchId());
        child.setContinuationSourceRunId(runId);
        child.setContinuationLineageId(lineage.lineageId());
        child.setContinuationThreadId(lineage.threadId());
        child.setContinuationCheckpointId("checkpoint-1");
        child.setContinuationEventSequence(1L);
        child.setContinuationMode("append_user_turn");
        childRunId = chatRunRepository.saveAndFlush(child).getId().toString();

        LineageInvocationService.ContinuationAdmission withChild =
                lineageInvocationService.requireContinuationEligible(runId, lineage.lineageId());
        assertEquals(List.of(runId, childRunId).stream().sorted().toList(), withChild.lineageRunIds());

        String secondToolCallId = UUID.randomUUID().toString();
        UUID childMcpInvocationId = UUID.fromString(openForRun(childRunId, secondToolCallId, "write_file"));
        LineageInvocationService.ReservationDecision replay = lineageInvocationService.reserve(
                childRunId, secondToolCallId, childMcpInvocationId, originId, "write_file", body);
        assertEquals(LineageInvocationService.DecisionKind.REPLAY_BLOCKED, replay.kind());
        // PLAN-0510 准入语义：未进入 CP 派发尝试（无 cp_forward）的 relay 记账不算外部副作用，
        // 因此这里的"未决"场景必须让该调用真实派发过，才能真正落入守卫。
        mcpInvocationService.startDispatchAttempt(childMcpInvocationId, UUID.randomUUID().toString())
                .orElseThrow();
        CpApiException blocked = assertThrows(CpApiException.class,
                () -> lineageInvocationService.requireContinuationEligible(runId, lineage.lineageId()));
        assertEquals("RECONCILIATION_REQUIRED", blocked.getCode());
    }

    /**
     * PLAN-0510（2026-10-16 用户裁定）：SSE relay 记账半会为"计划中"的 tool call 先建
     * source=agent invocation（PLAN-0464 T2.2），此时 MCP gate 尚未运行。未进入 CP 派发
     * 尝试（无 cp_forward attempt）的 mutation invocation 没有外部副作用，不得阻塞续跑。
     */
    @Test
    void relayOnlyMutationInvocationDoesNotBlockContinuation() {
        AgentGraphCheckpointService.LineageView lineage = createTestLineage();
        String toolCallId = UUID.randomUUID().toString();
        Map<String, Object> payload = new HashMap<>();
        payload.put("type", "tool_call");
        payload.put("tool", "write_file");
        payload.put("run_id", runId);
        payload.put("toolCallId", toolCallId);
        payload.put("arguments", Map.of("path", "relay-only.txt"));

        relayToolRecorder.record("tool_call", payload, runId, UUID.randomUUID().toString(),
                McpRelayToolRecorder.RunState.create());
        UUID invocationId = invocationRepository
                .findByRunIdAndToolCallIdAndSource(runId, toolCallId, "agent").orElseThrow().getId();
        assertEquals(List.of(McpAttempt.STAGE_AGENT_TOOL),
                attemptRepository.findByInvocationIdOrderByStartedAtAsc(invocationId).stream()
                        .map(McpAttempt::getStage).toList(),
                "the relay half records only the agent_tool attempt");
        // CP 重启会把这条搁置的 relay invocation 收敛为 failed（生产同形）。
        mcpInvocationService.settle(invocationId, McpInvocation.STATUS_FAILED, null);

        LineageInvocationService.ContinuationAdmission admission =
                lineageInvocationService.requireContinuationEligible(runId, lineage.lineageId());
        assertTrue(admission.completedToolCallIds().isEmpty());
        assertEquals(List.of(runId), admission.lineageRunIds());

        // 对照：一旦该调用真的进入 CP 派发尝试，缺 lineage provenance 仍必须阻塞续跑。
        mcpInvocationService.startDispatchAttempt(invocationId, UUID.randomUUID().toString()).orElseThrow();
        CpApiException blocked = assertThrows(CpApiException.class,
                () -> lineageInvocationService.requireContinuationEligible(runId, lineage.lineageId()));
        assertEquals("RECONCILIATION_REQUIRED", blocked.getCode());
    }

    /**
     * PLAN-0510 A类修复：并发 relay/gate 对同一 (run, toolCallId) 双写时，唯一约束违规会把
     * 事务标记为 aborted；恢复必须在新事务里回读赢家，绝不能复用被污染的事务（否则 500）。
     */
    @Test
    void concurrentOpenForOneToolCallRecoversTheWinner() throws Exception {
        createTestLineage();
        String toolCallId = UUID.randomUUID().toString();
        var pool = java.util.concurrent.Executors.newFixedThreadPool(4);
        try {
            var futures = new java.util.ArrayList<java.util.concurrent.Future<java.util.Optional<UUID>>>();
            for (int i = 0; i < 4; i++) {
                futures.add(pool.submit(() -> mcpInvocationService.openAgentInvocation(
                        runId, toolCallId, "write_file", UUID.randomUUID().toString(), "{}")));
            }
            java.util.Set<UUID> ids = new java.util.HashSet<>();
            for (var future : futures) {
                java.util.Optional<UUID> opened = future.get(30, java.util.concurrent.TimeUnit.SECONDS);
                assertTrue(opened.isPresent(), "concurrent open must resolve to an invocation id");
                ids.add(opened.get());
            }
            assertEquals(1, ids.size(), "concurrent opens for one (run, toolCall) must agree on one row");
        } finally {
            pool.shutdownNow();
        }
    }

    /**
     * PLAN-0510（2026-10-16 用户裁定 甲）：中止于 ambiguous 的 Run 必须把搁置副作用记为
     * {@code unknown}（"是否发生未知"），不能记成 {@code failed}；服务层需接受该收敛值。
     */
    @Test
    void settleStrandedRecordsUnknownSoAmbiguousRunsAreNotReportedAsFailed() {
        createTestLineage();
        String toolCallId = UUID.randomUUID().toString();
        UUID invocationId = UUID.fromString(openForRun(runId, toolCallId, "write_file"));

        int settled = mcpInvocationService.settleStrandedForRun(
                runId, McpInvocation.STATUS_UNKNOWN, "CP_RESTARTED");

        assertEquals(1, settled);
        McpInvocation settledInvocation = invocationRepository.findById(invocationId).orElseThrow();
        assertEquals(McpInvocation.STATUS_UNKNOWN, settledInvocation.getStatus());
        assertEquals("CP_RESTARTED", settledInvocation.getErrorCode());
    }

    @Test
    void reserveRejectsMissingOrMismatchedMcpInvocationBinding() {
        String body = lineageMutationBody("bound.txt");
        AgentGraphCheckpointService.LineageView lineage = createTestLineage();
        String rootToolCallId = UUID.randomUUID().toString();
        UUID rootInvocationId = UUID.fromString(open(rootToolCallId, "write_file"));

        ChatRun child = createLineageChild(lineage);
        String childToolCallId = UUID.randomUUID().toString();
        UUID childInvocationId = UUID.fromString(openForRun(childRunId, childToolCallId, "write_file"));

        String completedToolCallId = UUID.randomUUID().toString();
        UUID completedInvocationId = UUID.fromString(open(completedToolCallId, "write_file"));
        mcpInvocationService.settle(completedInvocationId, McpInvocation.STATUS_COMPLETED, null);

        String directUserToolCallId = UUID.randomUUID().toString();
        UUID directUserInvocationId = mcpInvocationService.openDirectUserInvocation(
                sessionId, workspaceId, userId, directUserToolCallId, "write_file",
                UUID.randomUUID().toString(), "{}")
                .orElseThrow();

        assertReservationRejected(runId, rootToolCallId, UUID.randomUUID(),
                "missing-invocation-id", "write_file", body);
        assertReservationRejected(runId, rootToolCallId, childInvocationId,
                "wrong-run-binding", "write_file", body);
        assertReservationRejected(runId, UUID.randomUUID().toString(), rootInvocationId,
                "wrong-tool-call-binding", "write_file", body);
        assertReservationRejected(runId, rootToolCallId, rootInvocationId,
                "wrong-tool-name-binding", "delete_file", body);
        assertReservationRejected(runId, directUserToolCallId, directUserInvocationId,
                "wrong-source-binding", "write_file", body);
        assertReservationRejected(runId, completedToolCallId, completedInvocationId,
                "inactive-invocation", "write_file", body);

        assertEquals(0, jdbc.queryForObject(
                "SELECT count(*) FROM agent_lineage_invocations WHERE lineage_id = ?",
                Integer.class, UUID.fromString(lineage.lineageId())),
                "a rejected identity must not leave a reservation that could be mistaken for dispatch");
    }

    @Test
    void reserveRejectsMcpInvocationAlreadyBoundToAnotherOriginatingId() {
        AgentGraphCheckpointService.LineageView lineage = createTestLineage();
        String toolCallId = UUID.randomUUID().toString();
        UUID invocationId = UUID.fromString(open(toolCallId, "write_file"));
        String body = lineageMutationBody("single-binding.txt");
        LineageInvocationService.ReservationDecision first = lineageInvocationService.reserve(
                runId, toolCallId, invocationId, "origin-call-first", "write_file", body);
        assertEquals(LineageInvocationService.DecisionKind.RESERVED, first.kind());

        assertReservationRejected(runId, toolCallId, invocationId,
                "origin-call-second", "write_file", body);
        assertEquals(1, jdbc.queryForObject(
                "SELECT count(*) FROM agent_lineage_invocations WHERE lineage_id = ? AND mcp_invocation_id = ?",
                Integer.class, UUID.fromString(lineage.lineageId()), invocationId),
                "one MCP invocation may be bound to only one originating call");
    }

    @Test
    void continuationEligibilityRejectsLedgerRowAfterMcpInvocationIsDeleted() {
        LineageMutationFixture fixture = completeLineageMutation();

        deleteMcpInvocation(fixture.mcpInvocationId());

        assertEquals(1, jdbc.queryForObject("""
                SELECT count(*) FROM agent_lineage_invocations
                 WHERE lineage_id = ? AND originating_tool_call_id = ? AND mcp_invocation_id IS NULL
                """, Integer.class, UUID.fromString(fixture.lineageId()), fixture.originatingToolCallId()),
                "V74's FK must null the missing invocation reference rather than erase the ledger row");
        assertContinuationRejected(fixture);
    }

    @Test
    void continuationEligibilityRejectsLedgerIdPointingAtAnotherLineageInvocation() {
        LineageMutationFixture fixture = completeLineageMutation();
        createLineageChild(fixture.lineage());
        String childToolCallId = UUID.randomUUID().toString();
        UUID childInvocationId = UUID.fromString(openForRun(childRunId, childToolCallId, "write_file"));
        jdbc.update("UPDATE mcp_invocations SET status = ? WHERE id = ?",
                McpInvocation.STATUS_COMPLETED, childInvocationId);
        deleteMcpInvocation(fixture.mcpInvocationId());
        jdbc.update("""
                UPDATE agent_lineage_invocations SET mcp_invocation_id = ?
                 WHERE lineage_id = ? AND originating_tool_call_id = ?
                """, childInvocationId, UUID.fromString(fixture.lineageId()), fixture.originatingToolCallId());

        assertContinuationRejected(fixture);
    }

    @Test
    void continuationEligibilityRejectsMismatchedFirstRunOrToolCallBinding() {
        LineageMutationFixture fixture = completeLineageMutation();
        jdbc.update("""
                UPDATE agent_lineage_invocations SET first_run_id = ?
                 WHERE lineage_id = ? AND originating_tool_call_id = ?
                """, UUID.randomUUID(), UUID.fromString(fixture.lineageId()), fixture.originatingToolCallId());

        assertContinuationRejected(fixture);

        jdbc.update("""
                UPDATE agent_lineage_invocations
                   SET first_run_id = ?, first_tool_call_id = ?
                 WHERE lineage_id = ? AND originating_tool_call_id = ?
                """, UUID.fromString(runId), UUID.randomUUID(), UUID.fromString(fixture.lineageId()),
                fixture.originatingToolCallId());
        assertContinuationRejected(fixture);
    }

    @Test
    void continuationEligibilityRejectsMismatchedToolNameOrMcpStatus() {
        LineageMutationFixture fixture = completeLineageMutation();
        jdbc.update("UPDATE mcp_invocations SET tool_name = ? WHERE id = ?",
                "read_file", fixture.mcpInvocationId());

        assertContinuationRejected(fixture);

        jdbc.update("UPDATE mcp_invocations SET tool_name = ?, status = ? WHERE id = ?",
                "write_file", McpInvocation.STATUS_FAILED, fixture.mcpInvocationId());
        assertContinuationRejected(fixture);
    }

    @Test
    void continuationEligibilityRejectsDuplicateLedgerReferencesToOneMcpInvocation() {
        LineageMutationFixture fixture = completeLineageMutation();
        jdbc.update("""
                INSERT INTO agent_lineage_invocations
                    (id, lineage_id, originating_tool_call_id, first_run_id, first_tool_call_id,
                     mcp_invocation_id, tool_name, arguments_hash, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed')
                """, UUID.randomUUID(), UUID.fromString(fixture.lineageId()),
                fixture.originatingToolCallId() + "-duplicate", UUID.fromString(runId),
                UUID.fromString(fixture.toolCallId()), fixture.mcpInvocationId(), "write_file", "0".repeat(64));

        assertContinuationRejected(fixture);
    }

    private AgentGraphCheckpointService.LineageView createTestLineage() {
        return checkpointService.createLineage(new AgentGraphCheckpointService.LineageRequest(
                sessionId, userId, workspaceId, runId, null, "test-producer-v1"));
    }

    private ChatRun createLineageChild(AgentGraphCheckpointService.LineageView lineage) {
        ChatRun child = new ChatRun(UUID.randomUUID().toString(), sessionId, userId, workspaceId,
                "lineage-child-" + UUID.randomUUID(), "hash", "provider", "model", "workspace", "running");
        child.setBranchId(chatRunRepository.findById(UUID.fromString(runId)).orElseThrow().getBranchId());
        child.setContinuationSourceRunId(runId);
        child.setContinuationLineageId(lineage.lineageId());
        child.setContinuationThreadId(lineage.threadId());
        child.setContinuationCheckpointId("checkpoint-1");
        child.setContinuationEventSequence(1L);
        child.setContinuationMode("append_user_turn");
        childRunId = chatRunRepository.saveAndFlush(child).getId().toString();
        return child;
    }

    private LineageMutationFixture completeLineageMutation() {
        AgentGraphCheckpointService.LineageView lineage = createTestLineage();
        String toolCallId = UUID.randomUUID().toString();
        String originId = "completed-origin-" + UUID.randomUUID();
        String body = lineageMutationBody("completed.txt");
        UUID invocationId = UUID.fromString(open(toolCallId, "write_file"));
        LineageInvocationService.ReservationDecision reservation = lineageInvocationService.reserve(
                runId, toolCallId, invocationId, originId, "write_file", body);
        assertEquals(LineageInvocationService.DecisionKind.RESERVED, reservation.kind());
        UUID attemptId = mcpInvocationService.startDispatchAttempt(invocationId, UUID.randomUUID().toString())
                .orElseThrow();
        mcpInvocationService.finishDispatchAttempt(invocationId, attemptId, 200, null,
                McpInvocationService.McpDispatchVerdict.COMPLETED);
        lineageInvocationService.settle(reservation.reservation(), "completed");
        return new LineageMutationFixture(lineage, originId, toolCallId, invocationId);
    }

    private void deleteMcpInvocation(UUID invocationId) {
        jdbc.update("DELETE FROM mcp_dispatch_history WHERE invocation_id = ?", invocationId);
        jdbc.update("DELETE FROM mcp_attempts WHERE invocation_id = ?", invocationId);
        jdbc.update("DELETE FROM mcp_invocations WHERE id = ?", invocationId);
    }

    private static String lineageMutationBody(String path) {
        return "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\","
                + "\"params\":{\"name\":\"write_file\",\"arguments\":{\"path\":\"" + path + "\"}}}";
    }

    private void assertReservationRejected(String targetRunId, String toolCallId, UUID invocationId,
                                           String originId, String toolName, String body) {
        CpApiException exception = assertThrows(CpApiException.class,
                () -> lineageInvocationService.reserve(
                        targetRunId, toolCallId, invocationId, originId, toolName, body));
        assertEquals("RECONCILIATION_REQUIRED", exception.getCode());
    }

    private void assertContinuationRejected(LineageMutationFixture fixture) {
        CpApiException exception = assertThrows(CpApiException.class,
                () -> lineageInvocationService.requireContinuationEligible(runId, fixture.lineageId()));
        assertEquals("RECONCILIATION_REQUIRED", exception.getCode());
    }

    private record LineageMutationFixture(AgentGraphCheckpointService.LineageView lineage,
                                          String originatingToolCallId, String toolCallId,
                                          UUID mcpInvocationId) {
        private String lineageId() { return lineage.lineageId(); }
    }

    private String openForRun(String targetRunId, String toolCallId, String toolName) {
        return mcpInvocationService
                .openAgentInvocation(targetRunId, toolCallId, toolName, UUID.randomUUID().toString(),
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
