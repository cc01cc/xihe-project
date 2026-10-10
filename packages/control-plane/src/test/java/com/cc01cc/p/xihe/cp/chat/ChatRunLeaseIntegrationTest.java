package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

class ChatRunLeaseIntegrationTest extends AbstractIntegrationTest {

    private static final String OWNER_A = "cp-instance-a";
    private static final String OWNER_B = "cp-instance-b";

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private ChatApprovalRepository approvalRepository;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    private String userId;
    private String workspaceId;
    private String sessionId;

    @BeforeEach
    void setUp() {
        String email = "lease-int-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "LeaseIntTest");
        ResponseEntity<AuthResponse> regResponse = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        regResponse.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        Workspace ws = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId)).stream().findFirst().orElseThrow();
        workspaceId = ws.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId);

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "Lease Integration");
        session.setId(UUID.fromString(sessionId));
        sessionRepository.save(session);
    }

    private ChatRun runWithLease(String status, String owner, Instant expiresAt) {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), sessionId, userId, workspaceId,
                "idem-" + UUID.randomUUID(), "hash", "openai", "gpt-test", "none", status);
        run.setLeaseOwner(owner);
        run.setLeaseExpiresAt(expiresAt);
        return chatRunRepository.save(run);
    }

    private int acquire(String runId, String owner, Instant expiresAt) {
        return chatRunRepository.tryAcquireLease(
                UUID.fromString(runId), owner, expiresAt, Instant.now(),
                ChatRunRepository.ACTIVE_LEASE_STATUSES);
    }

    @Test
    void concurrentAcquireIsMutuallyExclusive() throws Exception {
        ChatRun run = runWithLease("running", null, null);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Callable<Integer> taskA = () -> acquire(run.getId().toString(), OWNER_A, Instant.now().plusSeconds(600));
            Callable<Integer> taskB = () -> acquire(run.getId().toString(), OWNER_B, Instant.now().plusSeconds(600));
            Future<Integer> futureA = pool.submit(taskA);
            Future<Integer> futureB = pool.submit(taskB);
            int affectedA = futureA.get(10, TimeUnit.SECONDS);
            int affectedB = futureB.get(10, TimeUnit.SECONDS);
            assertEquals(1, affectedA + affectedB, "exactly one contender wins the lease");
        } finally {
            pool.shutdownNow();
        }
        ChatRun winner = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals(1, chatRunRepository.releaseLease(run.getId(), winner.getLeaseOwner()));
    }

    @Test
    void releaseLeaseOnlyClearsOwnOwnership() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().plusSeconds(600));

        assertEquals(0, chatRunRepository.releaseLease(run.getId(), OWNER_B));
        ChatRun untouched = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals(OWNER_A, untouched.getLeaseOwner());
        assertNotNull(untouched.getLeaseExpiresAt());

        assertEquals(1, chatRunRepository.releaseLease(run.getId(), OWNER_A));
        ChatRun released = chatRunRepository.findById(run.getId()).orElseThrow();
        assertNull(released.getLeaseOwner());
        assertNull(released.getLeaseExpiresAt());
    }

    @Test
    void expiredLeaseCanBeTakenOver() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().minusSeconds(1));

        assertEquals(1, acquire(run.getId().toString(), OWNER_B, Instant.now().plusSeconds(600)));
        ChatRun takenOver = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals(OWNER_B, takenOver.getLeaseOwner());
        assertTrue(takenOver.getLeaseExpiresAt().isAfter(Instant.now()));
    }

    @Test
    void liveLeaseBlocksForeignTakeover() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().plusSeconds(600));

        assertEquals(0, acquire(run.getId().toString(), OWNER_B, Instant.now().plusSeconds(600)));
        ChatRun unchanged = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals(OWNER_A, unchanged.getLeaseOwner());
    }

    @Test
    void terminalStatusIsNotRecoverable() {
        ChatRun run = runWithLease("succeeded", OWNER_A, Instant.now().plusSeconds(600));

        assertEquals(0, acquire(run.getId().toString(), OWNER_B, Instant.now().plusSeconds(600)));
        assertEquals(0, chatRunRepository.findRecoverableRuns(ChatRunRepository.ACTIVE_LEASE_STATUSES).stream()
                .filter(candidate -> candidate.getId().equals(run.getId()))
                .count());
    }

    @Test
    void reconciliationRestoresAwaitingApprovalForLiveApproval() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().plusSeconds(600));
        ChatApproval approval = new ChatApproval(
                UUID.randomUUID().toString(),
                run.getId().toString(),
                sessionId,
                userId,
                workspaceId,
                "request_approval",
                "delete file",
                "README.md",
                "pending",
                Instant.now().plusSeconds(300));
        approvalRepository.save(approval);

        reconciliationService().reconcileOnStartup();

        ChatRun restored = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals("awaiting_approval", restored.getStatus());
        assertNull(restored.getErrorCode());
    }

    @Test
    void reconciliationRestoresAwaitingApprovalForLiveDispatchUnknownWithoutAgentResponse() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().plusSeconds(600));
        ChatApproval unknown = new ChatApproval(
                UUID.randomUUID().toString(),
                run.getId().toString(),
                sessionId,
                userId,
                workspaceId,
                "request_approval",
                "delete file",
                "README.md",
                "dispatch_unknown",
                Instant.now().plusSeconds(300));
        approvalRepository.save(unknown);

        reconciliationService().reconcileOnStartup();

        ChatRun restored = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals("awaiting_approval", restored.getStatus());
        assertEquals(run.getId().toString(), activeRunRegistry.activeRunId(sessionId));
        assertEquals("dispatch_unknown", approvalRepository.findById(unknown.getRequestId()).orElseThrow().getState());
        verify(approvalAgentClient, never()).respond(anyString(), anyBoolean(), anyString(), any());
    }

    @Test
    void reconciliationMarksAmbiguousWithoutLiveApproval() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().plusSeconds(600));

        reconciliationService().reconcileOnStartup();

        ChatRun marked = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals("ambiguous", marked.getStatus());
        assertEquals("ambiguous", marked.getTerminalOutcome());
        assertEquals("CP_RESTARTED", marked.getErrorCode());
    }

    @Test
    void reconciliationIgnoresExpiredApprovalAndMarksAmbiguous() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().plusSeconds(600));
        ChatApproval expired = new ChatApproval(
                UUID.randomUUID().toString(),
                run.getId().toString(),
                sessionId,
                userId,
                workspaceId,
                "request_approval",
                "delete file",
                "README.md",
                "pending",
                Instant.now().minusSeconds(1));
        approvalRepository.save(expired);

        reconciliationService().reconcileOnStartup();

        ChatRun marked = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals("ambiguous", marked.getStatus());
        assertEquals("CP_RESTARTED", marked.getErrorCode());
    }

    @Test
    void reconciliationExpiresDispatchUnknownAndMarksAmbiguous() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().plusSeconds(600));
        ChatApproval expired = new ChatApproval(
                UUID.randomUUID().toString(),
                run.getId().toString(),
                sessionId,
                userId,
                workspaceId,
                "request_approval",
                "delete file",
                "README.md",
                "dispatch_unknown",
                Instant.now().minusSeconds(1));
        approvalRepository.save(expired);

        reconciliationService().reconcileOnStartup();

        ChatRun marked = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals("ambiguous", marked.getStatus());
        assertEquals("CP_RESTARTED", marked.getErrorCode());
        assertNull(activeRunRegistry.activeRunId(sessionId));
        assertEquals("expired", approvalRepository.findById(expired.getRequestId()).orElseThrow().getState());
    }

    private ChatRunRecoveryService reconciliationService() {
        return new ChatRunRecoveryService(chatRunRepository, approvalRepository, activeRunRegistry,
                chatRunTerminalService, historyWriter, runCheckpointService);
    }

    // ── PLAN-0317 T2.7：周期对账（grace=-1 让所有测试 run 立即进入候选） ──────

    private ChatRunReconciliationService staleRunReconciler() {
        return new ChatRunReconciliationService(chatRunRepository, activeRunRegistry, chatRunTerminalService, -1);
    }

    @Test
    void staleRunWithoutLeaseIsReconciledToAmbiguous() {
        ChatRun run = runWithLease("running", null, null);

        staleRunReconciler().reconcileStaleRuns();

        ChatRun marked = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals("ambiguous", marked.getStatus());
        assertEquals("ambiguous", marked.getTerminalOutcome());
        assertEquals("CP_RECONCILED", marked.getErrorCode());
    }

    @Test
    void staleCancellingRunIsReconciledToCancelled() {
        ChatRun run = runWithLease("cancelling", null, null);

        staleRunReconciler().reconcileStaleRuns();

        ChatRun marked = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals("cancelled", marked.getStatus());
        assertEquals("cancelled", marked.getTerminalOutcome());
        assertNull(marked.getErrorCode());
    }

    @Test
    void locallyActiveRunIsNotReconciled() {
        ChatRun run = runWithLease("running", null, null);
        activeRunRegistry.restoreActiveRun(sessionId, run.getId().toString());

        staleRunReconciler().reconcileStaleRuns();

        ChatRun untouched = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals("running", untouched.getStatus(), "an in-flight run must not be reconciled");
    }

    /**
     * T2.6 + T2.4：Agent 不回音（本测试无 Agent）时取消仍自主收敛；Runtime 不可达
     * 时账本落 `aborted`（spec S4 三分映射的"未确认"分支）。
     */
    @Test
    void cancelConvergesWithoutAgentEchoAndFallsBackToAborted() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().plusSeconds(600));
        String approvalId = UUID.randomUUID().toString();
        approvalRepository.saveAndFlush(new ChatApproval(approvalId, run.getId().toString(), sessionId,
                userId, workspaceId, "shell", "start background process", "{}", "pending",
                Instant.now().plusSeconds(600)));
        String toolCallId = UUID.randomUUID().toString();
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository, sessionId,
                run.getId().toString(), workspaceId, userId, toolCallId, "shell", "{}");

        com.cc01cc.p.xihe.cp.config.TenantContext.setUserId(userId);
        com.cc01cc.p.xihe.cp.config.TenantContext.setWorkspaceId(workspaceId);
        // @PreAuthorize 走方法级安全拦截，直接调用 bean 也需要 SecurityContext。
        org.springframework.security.core.context.SecurityContextHolder.getContext().setAuthentication(
                new org.springframework.security.authentication.UsernamePasswordAuthenticationToken(
                        userId, null,
                        java.util.List.of(new org.springframework.security.core.authority.SimpleGrantedAuthority("ROLE_USER"))));
        ResponseEntity<java.util.Map<String, Object>> response;
        ResponseEntity<java.util.Map<String, Object>> runStatus;
        try {
            response = chatController.cancelRun(run.getId().toString(), java.util.Map.of("reason", "user"));
            runStatus = chatController.getRunStatus(run.getId().toString());
        } finally {
            org.springframework.security.core.context.SecurityContextHolder.clearContext();
            com.cc01cc.p.xihe.cp.config.TenantContext.clear();
        }
        assertEquals(200, response.getStatusCode().value());
        assertEquals(200, runStatus.getStatusCode().value());
        assertTrue(((java.util.List<?>) runStatus.getBody().get("pendingApprovals")).isEmpty(),
                "cancelled ChatRuns must not surface approvals that can no longer be acted on");

        ChatRun after = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals("cancelled", after.getStatus(), "cancel must converge without an Agent echo");
        assertEquals("cancelled", after.getTerminalOutcome());
        assertEquals("cancelled", jdbcTemplate.queryForObject(
                "SELECT status FROM mcp_invocations WHERE run_id = CAST(? AS UUID)",
                String.class, run.getId().toString()),
                "an unreachable/unconfirmed termination must land as cancelled in mcp_invocations");
        assertEquals("expired", approvalRepository.findById(UUID.fromString(approvalId)).orElseThrow().getState(),
                "a cancelled ChatRun must not leave a pending approval actionable");
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM approval_history WHERE request_id = CAST(? AS UUID) "
                        + "AND event_type = 'expired' AND from_state = 'pending' AND to_state = 'expired'",
                Integer.class, approvalId),
                "run cancellation must retain approval expiry in its durable history");
    }

    /**
     * PLAN-0352 T1.2：删除路径的取消面——会话下非终态 run 全部纳入等待清单；
     * `running` 走完整取消编排收敛为 `cancelled`；`cancelling` 复用端点语义
     * （不重复转发/结算，仅等待）；已终态 run 不在面内。
     */
    @Test
    void cancelInFlightForSessionMarksRunsCancelledAndReturnsIds() {
        ChatRun running = runWithLease("running", OWNER_A, Instant.now().plusSeconds(600));
        ChatRun cancelling = runWithLease("cancelling", null, null);
        ChatRun finished = runWithLease("succeeded", null, null);

        List<String> ids = chatRunCancellationService.cancelInFlightForSession(
                sessionId, userId, workspaceId, "session_deleted");

        assertEquals(2, ids.size());
        assertTrue(ids.contains(running.getId().toString()));
        assertTrue(ids.contains(cancelling.getId().toString()));
        assertEquals("cancelled", chatRunRepository.findById(running.getId()).orElseThrow().getStatus());
        assertEquals("cancelling", chatRunRepository.findById(cancelling.getId()).orElseThrow().getStatus(),
                "an already-cancelling run keeps the endpoint semantics (no duplicate settle)");
        assertEquals("succeeded", chatRunRepository.findById(finished.getId()).orElseThrow().getStatus(),
                "terminal runs are outside the cancellation surface");
    }

    /**
     * PLAN-0352 T1.2 / V1：release 信号（`releaseRun`，终态投递之后）唤醒有界等待。
     */
    @Test
    void awaitTerminalDeliveryReturnsTrueAfterReleaseSignal() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().plusSeconds(600));
        List<String> ids = chatRunCancellationService.cancelInFlightForSession(
                sessionId, userId, workspaceId, "session_deleted");

        chatRunCancellationService.onRunReleased(run.getId().toString());

        assertTrue(chatRunCancellationService.awaitTerminalDelivery(
                sessionId, ids, java.time.Duration.ofSeconds(2)));
    }

    /**
     * PLAN-0352 T1.2 / V1：等待上界到点后返回 false，并记
     * `session_delete_sse_wait_timeout`（含 sessionId/runId/N）。
     */
    @Test
    void awaitTerminalDeliveryTimesOutWithExplicitLog() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().plusSeconds(600));
        List<String> ids = chatRunCancellationService.cancelInFlightForSession(
                sessionId, userId, workspaceId, "session_deleted");

        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(
                        ChatRunCancellationService.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        boolean delivered;
        try {
            delivered = chatRunCancellationService.awaitTerminalDelivery(
                    sessionId, ids, java.time.Duration.ofMillis(200));
        } finally {
            logger.detachAppender(appender);
        }

        assertFalse(delivered, "wait must report the timeout branch");
        String messages = appender.list.stream()
                .map(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage)
                .collect(java.util.stream.Collectors.joining("\n"));
        assertTrue(messages.contains("session_delete_sse_wait_timeout"), messages);
        assertTrue(messages.contains(sessionId), messages);
        assertTrue(messages.contains(run.getId().toString()), messages);
        assertTrue(messages.contains("waitTimeoutMs=200"), messages);
    }

    /**
     * 2026-09-13 E2E（决策 #8 补充）：run 进入取消流程后，中继不得再为工具事件
     * 写终态——取消副作用（Agent 工具中止 → Tool error）被回写为 failed 时，
     * 与取消收口竞态导致 item 无法落 cancelled。
     */
    @Test
    void relayToolResultSkippedAfterRunCancelled() {
        ChatRun run = runWithLease("cancelled", null, null);
        String toolCallId = UUID.randomUUID().toString();
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository, sessionId,
                run.getId().toString(), workspaceId, userId, toolCallId, "shell", "{}");
        var invocation = mcpInvocationRepository.findByRunIdAndToolCallIdAndSource(
                        run.getId().toString(), toolCallId, "agent")
                .orElseThrow();
        int historyBefore = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM mcp_dispatch_history WHERE invocation_id = CAST(? AS UUID)",
                Integer.class, invocation.getId().toString());

        Object target = org.springframework.test.util.AopTestUtils.getUltimateTargetObject(chatController);
        // PLAN-0464 T2.2：记账组件只剩执行域 McpRelayToolRecorder，直接以其 record() 驱动。
        com.cc01cc.p.xihe.cp.mcp.McpRelayToolRecorder recorder =
                (com.cc01cc.p.xihe.cp.mcp.McpRelayToolRecorder) org.springframework.test.util.ReflectionTestUtils
                        .getField(target, "mcpRelayToolRecorder");
        recorder.record("tool_result",
                java.util.Map.of("tool", "shell", "result", "Tool error: cancelled",
                        "toolCallId", toolCallId),
                run.getId().toString(), null,
                com.cc01cc.p.xihe.cp.mcp.McpRelayToolRecorder.RunState.create());

        assertEquals("active", mcpInvocationRepository.findById(invocation.getId()).orElseThrow().getStatus(),
                "late tool results after cancellation must not update invocation state");
        assertEquals(historyBefore, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM mcp_dispatch_history WHERE invocation_id = CAST(? AS UUID)",
                Integer.class, invocation.getId().toString()),
                "late tool results after cancellation must not append dispatch history");
    }

    /** 2026-09-13 E2E：CP→Agent 取消转发不得重复 `/internal/v1/agent` 前缀（曾 404）。 */
    @Test
    void agentCancelUrlHasNoDuplicatedPrefix() {
        String runId = UUID.randomUUID().toString();
        String url = chatRunCancellationService.buildAgentCancelUrl(runId);
        assertTrue(url.endsWith("/internal/v1/agent/runs/" + runId + "/cancel"), url);
        assertEquals(url.indexOf("/internal/v1/agent/runs/"),
                url.lastIndexOf("/internal/v1/agent/runs/"), url);
    }

    @Autowired
    private ChatController chatController;

    @Autowired
    private ChatActiveRunRegistry activeRunRegistry;

    @Autowired
    private ChatRunCancellationService chatRunCancellationService;

    @Autowired
    private ChatRunTerminalService chatRunTerminalService;

    @MockitoBean
    private ApprovalAgentClient approvalAgentClient;

    @Autowired
    private com.cc01cc.p.xihe.cp.service.RunCheckpointService runCheckpointService;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.McpInvocationRepository mcpInvocationRepository;

    @Autowired
    private org.springframework.jdbc.core.JdbcTemplate jdbcTemplate;

    @Autowired
    private com.cc01cc.p.xihe.cp.chat.ChatRunHistoryWriter historyWriter;

}
