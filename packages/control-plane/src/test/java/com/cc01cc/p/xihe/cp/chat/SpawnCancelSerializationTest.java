package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.net.InetSocketAddress;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0407 T2.5/T2.5b：spawn/cancel 序列化与 Session-first 删除（真实 PostgreSQL）。
 *
 * <p>覆盖：① spawn 与 cancel 按 Session→Run 共用同一事务锁序（两种确定胜序 +
 * CyclicBarrier 真实竞态）；② 序列化后终态一致（parent/child 状态与零半行）；
 * ③ 仅沿 kind=spawn 取消活跃后代并有界等待、fork 不跟随；④ 删除父 Session 零级联；
 * ⑤ cancel 端点对认领结果的 HTTP 契约。
 */
class SpawnCancelSerializationTest extends AbstractIntegrationTest {

    @Autowired
    private ChatSubmissionService submissionService;

    @Autowired
    private ChatRunCancellationService cancellationService;

    @Autowired
    private ChatController chatController;

    @Autowired
    private SessionService sessionService;

    @Autowired
    private OperationService operationService;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private SessionRepository sessionRepository;

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
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.McpInvocationRepository mcpInvocationRepository;

    @Autowired
    private PlatformTransactionManager transactionManager;

    private String userId;
    private String workspaceId;
    private UUID principalId;

    @AfterEach
    void cleanFixtures() {
        if (workspaceId != null) {
            SpawnTestSupport.clearForWorkspace(mcpInvocationRepository, jdbcTemplate, workspaceId);
        }
        TenantContext.clear();
        if (workspaceId != null) {
            deleteWorkspaceSessions();
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

    /** T2.5 胜序 A：cancel 先认领 → 新 spawn 被拒，零半行。 */
    @Test
    void cancelWinsRejectsNewSpawnAndLeavesZeroHalfRows() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"after cancel\"}");
        int sessionsBefore = sessionCount();
        int runsBefore = runCount();

        ChatRunCancellationService.CancelClaim claim =
                cancellationService.cancelSerialized(
                        parent.parentRunId, parent.parentSessionId, userId, workspaceId, "t25_cancel_first");
        assertEquals(ChatRunCancellationService.CancelOutcome.CLAIMED, claim.outcome());
        assertEquals("cancelled", runStatus(parent.parentRunId), "claim winner settles the parent run");

        CpApiException rejected = assertThrows(CpApiException.class,
                () -> spawnDirect(parent.parentRunId, parent.toolCallId));
        assertEquals(HttpStatus.CONFLICT, rejected.getStatus());
        assertEquals("SPAWN_PARENT_RUN_NOT_ACTIVE", rejected.getCode());
        assertEquals(sessionsBefore, sessionCount(), "rejected spawn must leave zero half rows");
        assertEquals(runsBefore, runCount(), "rejected spawn must leave zero half rows");
    }

    /** T2.5 胜序 B：spawn 先提交 → cancel 的传播看到已提交 child，链上 spawn 后代全停，fork 不跟随。 */
    @Test
    void spawnWinsCancelSeesCommittedChildStopsSpawnChainAndSkipsFork() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"chain\"}");
        ChatSubmissionService.SpawnResult child =
                spawnDirect(parent.parentRunId, parent.toolCallId);
        assertNotNull(child.runId());

        // PLAN-0464 T1.1: the child run has no operation root any more.
        assertNull(operationService.findOperationIdByRunId(child.runId()));
        String grandChildToolCallId = UUID.randomUUID().toString();
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository, child.sessionId(), child.runId(),
                workspaceId, userId, grandChildToolCallId, "spawn_agent",
                "{\"prompt\":\"grandchild\"}");
        ChatSubmissionService.SpawnResult grandChild =
                spawnDirect(child.runId(), grandChildToolCallId);
        assertNotNull(grandChild.runId());

        Session forkSession = forkSession(parent.parentSessionId, parent.parentRunId);
        String forkRunId = saveRun(forkSession, "running");

        ChatRunCancellationService.CancelClaim claim =
                cancellationService.cancelSerialized(
                        parent.parentRunId, parent.parentSessionId, userId, workspaceId, "t25_spawn_first");
        assertEquals(ChatRunCancellationService.CancelOutcome.CLAIMED, claim.outcome());

        assertEquals("cancelled", runStatus(parent.parentRunId));
        assertEquals("cancelled", runStatus(child.runId()), "cancel must see the spawn-winner child");
        assertEquals("cancelled", runStatus(grandChild.runId()),
                "cancellation follows kind=spawn transitively");
        assertEquals("running", runStatus(forkRunId), "fork must not follow ancestor cancel");

        assertTrue(sessionRepository.findById(UUID.fromString(child.sessionId())).isPresent());
        assertTrue(sessionRepository.findById(UUID.fromString(grandChild.sessionId())).isPresent());
        assertTrue(sessionRepository.findById(forkSession.getId()).isPresent(),
                "cancel never deletes sessions");
    }

    /** T2.5 真实竞态：CyclicBarrier 同时放行 spawn 与 cancel，只允许两种一致结局。 */
    @Test
    void spawnAndCancelRaceSerializesToOneConsistentOutcome() throws Exception {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"race\"}");
        int sessionsBefore = sessionCount();
        int runsBefore = runCount();

        CyclicBarrier barrier = new CyclicBarrier(2);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        Future<SpawnAttempt> spawnFuture = executor.submit(() -> {
            barrier.await(10, TimeUnit.SECONDS);
            try {
                ChatSubmissionService.SpawnResult result =
                        spawnDirect(parent.parentRunId, parent.toolCallId);
                return new SpawnAttempt(true, result.runId(), null);
            } catch (CpApiException e) {
                return new SpawnAttempt(false, null, e.getCode());
            }
        });
        Future<ChatRunCancellationService.CancelClaim> cancelFuture = executor.submit(() -> {
            barrier.await(10, TimeUnit.SECONDS);
            return cancellationService.cancelSerialized(
                    parent.parentRunId, parent.parentSessionId, userId, workspaceId, "t25_race");
        });
        SpawnAttempt spawn;
        ChatRunCancellationService.CancelClaim claim;
        try {
            spawn = spawnFuture.get(60, TimeUnit.SECONDS);
            claim = cancelFuture.get(60, TimeUnit.SECONDS);
        } finally {
            executor.shutdownNow();
        }

        assertEquals(ChatRunCancellationService.CancelOutcome.CLAIMED, claim.outcome());
        assertEquals("cancelled", runStatus(parent.parentRunId));
        int sessionDelta = sessionCount() - sessionsBefore;
        int runDelta = runCount() - runsBefore;
        assertEquals(sessionDelta, runDelta, "child session and spawn run commit together (zero half rows)");
        if (spawn.created()) {
            assertEquals(1, sessionDelta, "spawn winner commits exactly one child session");
            assertEquals(1, runDelta, "spawn winner commits exactly one spawn run");
            assertEquals("cancelled", runStatus(spawn.runId()),
                    "cancel must see and stop the spawn-winner child");
        } else {
            assertEquals("SPAWN_PARENT_RUN_NOT_ACTIVE", spawn.code(),
                    "cancel winner rejects the new spawn");
            assertEquals(0, sessionDelta, "rejected spawn leaves zero half rows");
            assertEquals(0, runDelta, "rejected spawn leaves zero half rows");
        }
    }

    /** T2.5 删除父 Session 零级联：child Session 与其 run 照常独立存活。 */
    @Test
    void deletingParentSessionKeepsSpawnChildSessionAndRun() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"delete parent\"}");
        ChatSubmissionService.SpawnResult child =
                spawnDirect(parent.parentRunId, parent.toolCallId);
        assertNotNull(child.runId());

        sessionService.delete(parent.parentSessionId, userId, workspaceId);

        assertTrue(sessionRepository.findById(UUID.fromString(parent.parentSessionId)).isEmpty(),
                "parent session is deleted");
        assertTrue(chatRunRepository.findById(UUID.fromString(parent.parentRunId)).isEmpty(),
                "the parent session's own runs cascade with it");
        Session childSession = sessionRepository.findById(UUID.fromString(child.sessionId())).orElseThrow();
        assertEquals(UUID.fromString(parent.parentSessionId), childSession.getSpawnedFromSessionId(),
                "provenance edge is a plain reference, never a cascade");
        ChatRun childRun = chatRunRepository.findById(UUID.fromString(child.runId())).orElseThrow();
        assertEquals("accepted", childRun.getStatus(),
                "child run keeps running independently of the deleted parent");
    }

    @Test
    void deleteWinsSessionFirstAgainstSpawnAndCancelClaims() throws Exception {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"delete wins\"}");
        int sessionsBefore = sessionCount();
        int runsBefore = runCount();
        CountDownLatch sessionLocked = new CountDownLatch(1);
        CountDownLatch releaseDelete = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(3);
        TransactionTemplate transactions = new TransactionTemplate(transactionManager);

        Future<?> deleteFuture = executor.submit(() -> transactions.execute(status -> {
            sessionRepository.findByIdForUpdate(UUID.fromString(parent.parentSessionId)).orElseThrow();
            sessionLocked.countDown();
            awaitLatch(releaseDelete, "delete winner release");
            sessionService.delete(parent.parentSessionId, userId, workspaceId);
            return null;
        }));

        SpawnAttempt spawn;
        ChatRunCancellationService.CancelClaim claim;
        try {
            assertTrue(sessionLocked.await(5, TimeUnit.SECONDS), "delete must own the Session row first");
            Future<SpawnAttempt> spawnFuture = executor.submit(() -> {
                try {
                        ChatSubmissionService.SpawnResult result = transactions.execute(status -> {
                            jdbcTemplate.execute("SET LOCAL application_name = 't25-spawn-delete-loser'");
                            return spawnDirect(parent.parentRunId, parent.toolCallId);
                    });
                    return new SpawnAttempt(true, result.runId(), null);
                } catch (CpApiException error) {
                    return new SpawnAttempt(false, null, error.getCode());
                }
            });
            Future<ChatRunCancellationService.CancelClaim> cancelFuture = executor.submit(() -> {
                return transactions.execute(status -> {
                    jdbcTemplate.execute("SET LOCAL application_name = 't25-cancel-delete-loser'");
                    return cancellationService.cancelSerialized(
                            parent.parentRunId, parent.parentSessionId, userId, workspaceId, "session_deleted");
                });
            });
            awaitPostgresLockWait("t25-spawn-delete-loser");
            awaitPostgresLockWait("t25-cancel-delete-loser");
            releaseDelete.countDown();
            deleteFuture.get(15, TimeUnit.SECONDS);
            spawn = spawnFuture.get(15, TimeUnit.SECONDS);
            claim = cancelFuture.get(15, TimeUnit.SECONDS);
        } finally {
            releaseDelete.countDown();
            executor.shutdownNow();
        }

        assertTrue(!spawn.created(), "a deleted parent cannot admit a child spawn");
        assertEquals("SPAWN_PARENT_RUN_NOT_FOUND", spawn.code());
        assertEquals(ChatRunCancellationService.CancelOutcome.NOT_FOUND, claim.outcome());
        assertTrue(sessionRepository.findById(UUID.fromString(parent.parentSessionId)).isEmpty());
        assertTrue(chatRunRepository.findById(UUID.fromString(parent.parentRunId)).isEmpty());
        assertEquals(sessionsBefore - 1, sessionCount(), "delete winner leaves no child Session");
        assertEquals(runsBefore - 1, runCount(), "delete winner leaves no child Run");
        assertEquals(0, operationItemCount(parent.operationId), "delete winner leaves no parent spawn item");
    }

    @Test
    void spawnAndCancelClaimsThatWinBeforeDeleteRemainSerialized() throws Exception {
        ExecutorService executor = Executors.newSingleThreadExecutor();
        TransactionTemplate transactions = new TransactionTemplate(transactionManager);
        try {
            ParentFixture spawnParent = fixture("spawn_agent", "{\"prompt\":\"spawn wins delete\"}");
            SpawnDeleteOutcome spawnOutcome = transactions.execute(status -> {
                sessionRepository.findByIdForUpdate(UUID.fromString(spawnParent.parentSessionId)).orElseThrow();
                ChatSubmissionService.SpawnResult child = spawnDirect(
                        spawnParent.parentRunId, spawnParent.toolCallId);
                assertEquals(1, jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM operation_items "
                                + "WHERE operation_id = ? AND tool_call_id = ?",
                        Integer.class, UUID.fromString(spawnParent.operationId),
                        UUID.fromString(spawnParent.toolCallId)),
                        "spawn winner must retain exactly one parent item until deletion; T2.10 owns the waiting link");
                Future<?> deletion = executor.submit(() -> {
                    return transactions.execute(deleteStatus -> {
                        jdbcTemplate.execute("SET LOCAL application_name = 't25-delete-after-spawn'");
                        sessionService.delete(spawnParent.parentSessionId, userId, workspaceId);
                        return null;
                    });
                });
                awaitPostgresLockWait("t25-delete-after-spawn");
                return new SpawnDeleteOutcome(child, deletion);
            });
            spawnOutcome.deletion().get(15, TimeUnit.SECONDS);
            assertTrue(sessionRepository.findById(UUID.fromString(spawnOutcome.child().sessionId())).isPresent(),
                    "spawn winner commits its child before parent deletion");
            assertEquals("accepted", runStatus(spawnOutcome.child().runId()));
            assertEquals(0, operationItemCount(spawnParent.operationId),
                    "parent deletion removes its ledger item without deleting the child");

            ParentFixture cancelParent = fixture("spawn_agent", "{\"prompt\":\"cancel wins delete\"}");
            CancelDeleteOutcome cancelOutcome = transactions.execute(status -> {
                sessionRepository.findByIdForUpdate(UUID.fromString(cancelParent.parentSessionId)).orElseThrow();
                ChatRunCancellationService.CancelClaim claim = cancellationService.claimCancellation(
                        cancelParent.parentRunId, cancelParent.parentSessionId, userId, workspaceId);
                Future<?> deletion = executor.submit(() -> {
                    return transactions.execute(deleteStatus -> {
                        jdbcTemplate.execute("SET LOCAL application_name = 't25-delete-after-cancel'");
                        sessionService.delete(cancelParent.parentSessionId, userId, workspaceId);
                        return null;
                    });
                });
                awaitPostgresLockWait("t25-delete-after-cancel");
                return new CancelDeleteOutcome(claim, deletion);
            });
            cancelOutcome.deletion().get(15, TimeUnit.SECONDS);
            assertEquals(ChatRunCancellationService.CancelOutcome.CLAIMED, cancelOutcome.claim().outcome());
            assertTrue(sessionRepository.findById(UUID.fromString(cancelParent.parentSessionId)).isEmpty());
            assertTrue(chatRunRepository.findById(UUID.fromString(cancelParent.parentRunId)).isEmpty());
            assertEquals(0, operationItemCount(cancelParent.operationId),
                    "cancel-winner then delete leaves no parent operation item");
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    void cancellationClaimRejectsMismatchedSessionAndTenantContext() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"wrong cancellation context\"}");

        ChatRunCancellationService.CancelClaim wrongSession = cancellationService.claimCancellation(
                parent.parentRunId, UUID.randomUUID().toString(), userId, workspaceId);
        ChatRunCancellationService.CancelClaim wrongUser = cancellationService.cancelSerialized(
                parent.parentRunId, parent.parentSessionId, UUID.randomUUID().toString(), workspaceId, "wrong_user");
        ChatRunCancellationService.CancelClaim wrongWorkspace = cancellationService.cancelSerialized(
                parent.parentRunId, parent.parentSessionId, userId,
                UUID.randomUUID().toString(), "wrong_workspace");

        assertEquals(ChatRunCancellationService.CancelOutcome.NOT_FOUND, wrongSession.outcome());
        assertEquals(ChatRunCancellationService.CancelOutcome.NOT_FOUND, wrongUser.outcome());
        assertEquals(ChatRunCancellationService.CancelOutcome.NOT_FOUND, wrongWorkspace.outcome());
        assertEquals("running", runStatus(parent.parentRunId()),
                "a claim with mismatched durable or caller ownership must not settle or forward");
    }

    @Test
    void sessionLockTimeoutFailsClosedBeforeCancelForwarding() throws Exception {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"lock timeout\"}");
        HttpServer agentServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicInteger cancelRequests = new AtomicInteger();
        String previousAgentUrl = (String) ReflectionTestUtils.getField(cancellationService, "agentUrl");
        CountDownLatch sessionLocked = new CountDownLatch(1);
        CountDownLatch releaseLock = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        TransactionTemplate transactions = new TransactionTemplate(transactionManager);
        Future<?> lockHolder = null;
        boolean serverStarted = false;
        boolean agentUrlChanged = false;

        try {
            agentServer.createContext("/internal/v1/agent/runs/", exchange -> {
                cancelRequests.incrementAndGet();
                exchange.getRequestBody().readAllBytes();
                exchange.sendResponseHeaders(204, -1);
                exchange.close();
            });
            agentServer.start();
            serverStarted = true;
            ReflectionTestUtils.setField(cancellationService, "agentUrl",
                    "http://127.0.0.1:" + agentServer.getAddress().getPort() + "/chat");
            agentUrlChanged = true;
            lockHolder = executor.submit(() -> transactions.execute(status -> {
                sessionRepository.findByIdForUpdate(UUID.fromString(parent.parentSessionId)).orElseThrow();
                sessionLocked.countDown();
                awaitLatch(releaseLock, "session lock release");
                return null;
            }));

            assertTrue(sessionLocked.await(5, TimeUnit.SECONDS), "lock holder must own the Session row");
            Future<ChatRunCancellationService.CancelClaim> cancellation = executor.submit(
                    () -> cancellationService.cancelSerialized(
                            parent.parentRunId, parent.parentSessionId, userId, workspaceId, "timeout"));
            ExecutionException lockFailure = assertThrows(ExecutionException.class,
                    () -> cancellation.get(8, TimeUnit.SECONDS));
            assertTrue(lockFailure.getCause() instanceof PessimisticLockingFailureException,
                    "the Session lock timeout must surface as a persistence lock failure");
            assertEquals("running", runStatus(parent.parentRunId()),
                    "failed claim must not transition the Run or forward cancellation");
            assertEquals(0, cancelRequests.get(), "a failed claim must not call Agent or start settlement");
        } finally {
            releaseLock.countDown();
            try {
                if (lockHolder != null) {
                    lockHolder.get(10, TimeUnit.SECONDS);
                }
            } finally {
                executor.shutdownNow();
                if (serverStarted) {
                    agentServer.stop(0);
                }
                if (agentUrlChanged) {
                    ReflectionTestUtils.setField(cancellationService, "agentUrl", previousAgentUrl);
                }
            }
        }
    }

    /** T2.5 端点契约：认领获胜 → 200 收敛；已终态 → 409；已 cancelling → 200 幂等不改写。 */
    @Test
    void cancelEndpointMapsClaimOutcomesToHttpContract() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"endpoint\"}");
        Session parentSession =
                sessionRepository.findById(UUID.fromString(parent.parentSessionId)).orElseThrow();

        ResponseEntity<Map<String, Object>> accepted = cancelViaController(parent.parentRunId);
        assertEquals(HttpStatus.OK, accepted.getStatusCode());
        assertEquals("cancel_accepted", accepted.getBody().get("status"));
        assertEquals("cancelled", runStatus(parent.parentRunId));

        String terminalRunId = saveRun(parentSession, "succeeded");
        ResponseEntity<Map<String, Object>> conflict = cancelViaController(terminalRunId);
        assertEquals(HttpStatus.CONFLICT, conflict.getStatusCode());
        assertEquals("RUN_NOT_CANCELLABLE", conflict.getBody().get("code"));
        assertEquals("succeeded", runStatus(terminalRunId), "a terminal run is never rewritten");

        String cancellingRunId = saveRun(parentSession, "cancelling");
        ResponseEntity<Map<String, Object>> inFlight = cancelViaController(cancellingRunId);
        assertEquals(HttpStatus.OK, inFlight.getStatusCode());
        assertEquals("cancel_accepted", inFlight.getBody().get("status"));
        assertEquals("cancelling", runStatus(cancellingRunId),
                "an in-flight claim is not re-settled by a duplicate request");
    }

    // ── fixtures ────────────────────────────────────────────────────────────

    /**
     * cancel 的 settle 会 fire-and-forget 排队 checkpoint capture（后台单线程）；
     * 其 operation_items/ledger 写入与会话级联删除交叉时 PG 会检出死锁并即刻失败
     * （2026-09-25 首轮 wave 实测）。有界轮询重试等 capture 自然收敛（毫秒级），
     * 不使用固定 sleep。
     */
    private void deleteWorkspaceSessions() {
        String sql = "DELETE FROM sessions WHERE CAST(workspace_id AS VARCHAR) = ?";
        try {
            Awaitility.await().atMost(Duration.ofSeconds(15)).pollInterval(Duration.ofMillis(100))
                    .until(() -> {
                        try {
                            jdbcTemplate.update(sql, workspaceId);
                            return true;
                        } catch (PessimisticLockingFailureException e) {
                            return false;
                        }
                    });
        } catch (org.awaitility.core.ConditionTimeoutException e) {
            throw new AssertionError(
                    "workspace session cleanup did not converge under capture/lock contention", e);
        }
    }

    private record ParentFixture(String parentSessionId, String parentRunId,
                                 String operationId, String toolCallId) {}

    private record SpawnAttempt(boolean created, String runId, String code) {}

    private record SpawnDeleteOutcome(ChatSubmissionService.SpawnResult child, Future<?> deletion) {}

    private record CancelDeleteOutcome(ChatRunCancellationService.CancelClaim claim, Future<?> deletion) {}

    private static void awaitLatch(CountDownLatch latch, String description) {
        try {
            if (!latch.await(10, TimeUnit.SECONDS)) {
                throw new IllegalStateException("Timed out waiting for " + description);
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while waiting for " + description, error);
        }
    }

    private void awaitPostgresLockWait(String applicationName) {
        Awaitility.await().atMost(Duration.ofSeconds(5)).pollInterval(Duration.ofMillis(25))
                .untilAsserted(() -> assertEquals(1, jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM pg_stat_activity "
                                + "WHERE application_name = ? AND state = 'active' "
                                + "AND wait_event_type = 'Lock'",
                        Integer.class, applicationName)));
    }

    private ParentFixture fixture(String toolName, String argumentsPreview) {
        ensureWorkspace();
        Session parentSession = new Session(workspaceId, userId,
                "T25 parent " + UUID.randomUUID().toString().substring(0, 8));
        parentSession.setId(UUID.randomUUID());
        parentSession.setAgentPrincipalId(principalId.toString());
        parentSession.setAgentPermissionsSnapshot(capNode());
        sessionRepository.saveAndFlush(parentSession);

        String parentRunId = saveRun(parentSession, "running");
        OperationService.OperationStartResult operation = operationService.startOperation(
                userId, parentSession.getId().toString(), workspaceId, parentRunId,
                UUID.randomUUID().toString(), "chat", "ui", "user", userId,
                "parent-submit-" + parentRunId, "Parent chat");
        String toolCallId = UUID.randomUUID().toString();
        OperationItem item = operationService.appendItem(operation.operationId(), toolCallId, null,
                "tool_call", toolName, "agent", argumentsPreview, null, null);
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository,
                parentSession.getId().toString(), parentRunId, workspaceId, userId,
                item.getToolCallId(), toolName, argumentsPreview);
        return new ParentFixture(parentSession.getId().toString(), parentRunId,
                operation.operationId().toString(), item.getToolCallId());
    }

    /** This suite isolates Session→Run→Operation→Item serialization; gate behavior is tested separately. */
    private ChatSubmissionService.SpawnResult spawnDirect(String parentRunId, String toolCallId) {
        ChatSubmissionService.SpawnInvocation invocation =
                submissionService.prepareSpawnInvocation(parentRunId, toolCallId);
        return submissionService.createSpawnFromParent(parentRunId, toolCallId,
                new ChatSubmissionService.SpawnAuthorization(invocation.authorizationBody(), null, null));
    }

    private Session forkSession(String parentSessionId, String parentRunId) {
        Session fork = new Session(workspaceId, userId, "T25 fork");
        fork.setId(UUID.randomUUID());
        fork.setKind(Session.KIND_FORK);
        fork.setSpawnedFromSessionId(UUID.fromString(parentSessionId));
        fork.setSpawnedFromRunId(UUID.fromString(parentRunId));
        fork.setSpawnedAt(Instant.now());
        fork.setAgentPrincipalId(principalId.toString());
        fork.setAgentPermissionsSnapshot(capNode());
        return sessionRepository.saveAndFlush(fork);
    }

    private String saveRun(Session session, String status) {
        String runId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(
                runId, session.getId().toString(), userId, workspaceId,
                "t25-submit-" + runId, "t25-hash-" + runId,
                "provider", "model", "workspace", status));
        return runId;
    }

    private ResponseEntity<Map<String, Object>> cancelViaController(String runId) {
        TenantContext.setUserId(userId);
        TenantContext.setWorkspaceId(workspaceId);
        // @PreAuthorize 走方法级安全拦截，直接调用 bean 也需要 SecurityContext。
        org.springframework.security.core.context.SecurityContextHolder.getContext().setAuthentication(
                new org.springframework.security.authentication.UsernamePasswordAuthenticationToken(
                        userId, null,
                        List.of(new org.springframework.security.core.authority.SimpleGrantedAuthority(
                                "ROLE_USER"))));
        try {
            return chatController.cancelRun(runId, Map.of("reason", "t25"));
        } finally {
            org.springframework.security.core.context.SecurityContextHolder.clearContext();
            TenantContext.clear();
        }
    }

    private void ensureWorkspace() {
        if (userId != null) {
            return;
        }
        User user = userRepository.save(new User("t25-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Spawn cancel serialization test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("T25 test", userId));
        workspaceId = workspace.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("T25 principal");
        principal.setCreatedByUserId(userId);
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        principal = agentPrincipalRepository.saveAndFlush(principal);
        principalId = principal.getId();
        workspaceAgentRepository.saveAndFlush(
                new WorkspaceAgent(principalId.toString(), workspaceId, capNode()));
    }

    private com.fasterxml.jackson.databind.node.ArrayNode capNode() {
        com.fasterxml.jackson.databind.node.ArrayNode cap = objectMapper.createArrayNode();
        com.fasterxml.jackson.databind.node.ObjectNode atom = objectMapper.createObjectNode();
        atom.put("actionClass", "read");
        cap.add(atom);
        return cap;
    }

    private String runStatus(String runId) {
        return chatRunRepository.findById(UUID.fromString(runId)).orElseThrow().getStatus();
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

    private int operationItemCount(String operationId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM operation_items WHERE operation_id = ?",
                Integer.class, UUID.fromString(operationId));
    }
}
