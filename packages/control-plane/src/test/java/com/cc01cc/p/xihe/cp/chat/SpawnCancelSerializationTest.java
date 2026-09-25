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
import org.awaitility.Awaitility;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0407 T2.5：spawn/cancel 序列化与父删除（真实 PostgreSQL）。
 *
 * <p>覆盖：① spawn 与 cancel 在 parent Run 行上的共同 DB 锁/条件更新（两种确定胜序 +
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

    private String userId;
    private String workspaceId;
    private UUID principalId;

    @AfterEach
    void cleanFixtures() {
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
                cancellationService.cancelSerialized(parent.parentRunId, workspaceId, "t25_cancel_first");
        assertEquals(ChatRunCancellationService.CancelOutcome.CLAIMED, claim.outcome());
        assertEquals("cancelled", runStatus(parent.parentRunId), "claim winner settles the parent run");

        CpApiException rejected = assertThrows(CpApiException.class,
                () -> submissionService.createSpawnFromParent(parent.parentRunId, parent.toolCallId));
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
                submissionService.createSpawnFromParent(parent.parentRunId, parent.toolCallId);
        assertNotNull(child.runId());

        UUID childOperationId = operationService.findOperationIdByRunId(child.runId());
        assertNotNull(childOperationId, "spawn run must have a durable operation");
        String grandChildToolCallId = UUID.randomUUID().toString();
        operationService.appendItem(childOperationId, grandChildToolCallId, null,
                "tool_call", "spawn_agent", "agent", "{}", null, null);
        ChatSubmissionService.SpawnResult grandChild =
                submissionService.createSpawnFromParent(child.runId(), grandChildToolCallId);
        assertNotNull(grandChild.runId());

        Session forkSession = forkSession(parent.parentSessionId, parent.parentRunId);
        String forkRunId = saveRun(forkSession, "running");

        ChatRunCancellationService.CancelClaim claim =
                cancellationService.cancelSerialized(parent.parentRunId, workspaceId, "t25_spawn_first");
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
                        submissionService.createSpawnFromParent(parent.parentRunId, parent.toolCallId);
                return new SpawnAttempt(true, result.runId(), null);
            } catch (CpApiException e) {
                return new SpawnAttempt(false, null, e.getCode());
            }
        });
        Future<ChatRunCancellationService.CancelClaim> cancelFuture = executor.submit(() -> {
            barrier.await(10, TimeUnit.SECONDS);
            return cancellationService.cancelSerialized(parent.parentRunId, workspaceId, "t25_race");
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
                submissionService.createSpawnFromParent(parent.parentRunId, parent.toolCallId);
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
        return new ParentFixture(parentSession.getId().toString(), parentRunId,
                operation.operationId().toString(), item.getToolCallId());
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
}
