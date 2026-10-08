package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0407 T2.9 / V4：spawn 生命周期集成缺口（真实 PostgreSQL）。
 *
 * <p>只断言既有测试未覆盖的缺口，明确不复制：
 * <ul>
 *   <li>origin（spawn run {@code origin=spawn}、公开提交 {@code user_submission}）已由
 *       {@code ChatSpawnSubmissionIntegrationTest:178}、{@code AgentSpawnPrincipalContractTest:179}
 *       与 {@code ChatControllerTest:329/353/473/474} 覆盖——本类不重复；</li>
 *   <li>基础停止传播（spawn 链式停子 + fork 不跟随）与删父行存活性已由
 *       {@code SpawnCancelSerializationTest.spawnWinsCancelSeesCommittedChildStopsSpawnChainAndSkipsFork}
 *       与 {@code deletingParentSessionKeepsSpawnChildSessionAndRun} 覆盖——本类只补
 *       <b>有界收口</b>（卡死 lease 下仍在文档上界内返回并留诊断）与
 *       <b>删父后子 run 独立走到终态</b>两个缺口；</li>
 *   <li>终态事务侧回滚已由 {@code TerminalTransactionCoreIntegrationTest} 覆盖；本类补
 *       <b>spawn 创建事务</b>注入失败后的同滚（child Session/provenance/snapshot/run/
 *       waiting link/audit 全量回滚）。</li>
 * </ul>
 */
class SpawnLifecycleTest extends AbstractIntegrationTest {

    /** 传播等待上界内的实际等待为 2s（SPAWN_DESCENDANT_WAIT）；10s 是整体返回的宽松 sanity 上界。 */
    private static final long BOUNDED_CLOSE_MAX_MS = 10_000;

    @Autowired
    private ChatSubmissionService submissionService;

    @Autowired
    private ChatRunCancellationService cancellationService;

    @Autowired
    private SessionService sessionService;


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

    private String userId;
    private String workspaceId;
    private UUID principalId;

    @AfterEach
    void cleanFixtures() {
        if (workspaceId != null) {
            SpawnTestSupport.clearForWorkspace(mcpInvocationRepository, jdbcTemplate, workspaceId);
        }
        dropSpawnRunFailureTrigger();
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
        userId = null;
        workspaceId = null;
        principalId = null;
    }

    /**
     * T2.9 同滚（V2 / spec session §2）：spawn 创建事务在 ChatRun 写入点被注入的
     * PostgreSQL 失败打断后，child Session（含 provenance 与 snapshot）、child
     * ChatRun、parent waiting link 与 spawn audit 必须全部回滚，parent item
     * 随后仍可再次 spawn 成功。
     */
    @Test
    void spawnCreationTransactionFailureRollsBackChildSessionRunLinkAndAudit() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"rollback\"}");
        int sessionsBefore = sessionCount();
        int runsBefore = runCount();
        int spawnAuditsBefore = agentSpawnAuditCount();
        assertTrue(mcpInvocationRepository.findById(parent.invocationId()).isPresent(),
                "the parent invocation is the durable spawn caller");

        // PLAN-0464 T2.1: the spawn idempotency key is now the canonical toolCallId.
        installSpawnRunFailureTrigger(parent.toolCallId);
        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> spawnDirect(parent.parentRunId, parent.toolCallId));
        dropSpawnRunFailureTrigger();
        assertTrue(messagesContain(failure, "injected spawn rollback"),
                "the spawn must fail on the injected DB error, not on an earlier gate: " + failure);

        assertEquals(sessionsBefore, sessionCount(),
                "the child Session (provenance + snapshot) must roll back with the transaction");
        assertEquals(runsBefore, runCount(), "the child ChatRun must roll back with the transaction");
        assertEquals(spawnAuditsBefore, agentSpawnAuditCount(), "the spawn audit row must roll back");
        assertEquals(0, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM chat_runs WHERE idempotency_key = ?", Integer.class, parent.toolCallId),
                "no ChatRun row may survive for the failed spawn key");

        ChatSubmissionService.SpawnResult retried = spawnDirect(parent.parentRunId, parent.toolCallId);
        assertNotNull(retried.runId(), "after rollback the same parent item must be spawnable again");
        assertEquals(sessionsBefore + 1, sessionCount(), "the retry commits exactly one child Session");
        assertEquals(runsBefore + 1, runCount(), "the retry commits exactly one child ChatRun");
        ChatRun retriedChild = chatRunRepository.findById(UUID.fromString(retried.runId())).orElseThrow();
        assertEquals(parent.parentRunId, retriedChild.getWaitingOnRunId(),
                "the retry writes the child waiting link");
        assertEquals(parent.toolCallId, retriedChild.getWaitingToolCallId());
    }

    /**
     * T2.9 / V4 停止传播 + 有界收口：停父后活跃 spawn child 被链式取消并落终态；
     * child 的 relay lease 卡死（无人 release）时，传播等待只到文档上界
     * （SPAWN_DESCENDANT_WAIT=2s）即记 {@code session_delete_sse_wait_timeout}
     * 返回，不无限阻塞，且不留任何非终态的 dangling child。
     */
    @Test
    void stopParentCancelsActiveSpawnChildWithinBoundedClose() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"bounded close\"}");
        ChatSubmissionService.SpawnResult child = spawnDirect(parent.parentRunId, parent.toolCallId);
        assertNotNull(child.runId());

        ChatRun childRun = chatRunRepository.findById(UUID.fromString(child.runId())).orElseThrow();
        childRun.setLeaseOwner("stuck-relay");
        childRun.setLeaseExpiresAt(Instant.now().plusSeconds(600));
        chatRunRepository.saveAndFlush(childRun);

        String previousAgentUrl = (String) ReflectionTestUtils.getField(cancellationService, "agentUrl");
        ReflectionTestUtils.setField(cancellationService, "agentUrl", "http://127.0.0.1:1/chat");
        ch.qos.logback.classic.Logger cancelLogger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(
                        ChatRunCancellationService.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        cancelLogger.addAppender(appender);
        ChatRunCancellationService.CancelClaim claim;
        long started = System.nanoTime();
        try {
            claim = cancellationService.cancelSerialized(
                    parent.parentRunId, parent.parentSessionId, userId, workspaceId, "v4_bounded_close");
        } finally {
            cancelLogger.detachAppender(appender);
            ReflectionTestUtils.setField(cancellationService, "agentUrl", previousAgentUrl);
        }
        long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);

        assertEquals(ChatRunCancellationService.CancelOutcome.CLAIMED, claim.outcome());
        assertEquals("cancelled", runStatus(parent.parentRunId), "the stopped parent reaches its terminal state");
        ChatRun cancelledChild = chatRunRepository.findById(UUID.fromString(child.runId())).orElseThrow();
        assertEquals("cancelled", cancelledChild.getStatus(),
                "stop propagation must cancel the active spawn child");
        assertNotNull(cancelledChild.getTerminalAt(), "the child terminal transaction commits terminal_at");
        assertTrue(elapsedMs <= BOUNDED_CLOSE_MAX_MS,
                "stop propagation must close within a bounded wait, took ms=" + elapsedMs);
        assertTrue(chatRunRepository.findBySessionIdAndStatusIn(
                        child.sessionId(), ChatRunCancellationService.NON_TERMINAL_STATUSES).isEmpty(),
                "no dangling active child run may remain after the stop");
        String logs = appender.list.stream()
                .map(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage)
                .collect(Collectors.joining("\n"));
        assertTrue(logs.contains("session_delete_sse_wait_timeout"), logs);
        assertTrue(logs.contains("waitTimeoutMs=2000"), logs);
    }

    /**
     * T2.9 / V4 删父零级联（完整形态）：真实 SessionService 删除父 Session 后，
     * child Session 与 provenance 保留，且 child run 仍能经统一终态事务独立走到
     * 终态（parent 缺失 → child-local 收口 + {@code derived_parent_missing} 诊断）。
     */
    @Test
    void deletingParentSessionLetsChildRunTerminateIndependently() {
        ParentFixture parent = fixture("spawn_agent", "{\"prompt\":\"delete parent terminal\"}");
        ChatSubmissionService.SpawnResult child = spawnDirect(parent.parentRunId, parent.toolCallId);
        assertNotNull(child.runId());

        sessionService.delete(parent.parentSessionId, userId, workspaceId);

        assertTrue(sessionRepository.findById(UUID.fromString(parent.parentSessionId)).isEmpty(),
                "the parent Session is deleted");
        assertTrue(chatRunRepository.findById(UUID.fromString(parent.parentRunId)).isEmpty(),
                "the parent Session's own runs cascade with it");
        assertTrue(mcpInvocationRepository.findById(parent.invocationId()).isEmpty(),
                "the parent Session's invocation history is removed with its owner");
        Session childSession = sessionRepository.findById(UUID.fromString(child.sessionId())).orElseThrow();
        assertEquals(Session.KIND_SPAWN, childSession.getKind());
        assertEquals(UUID.fromString(parent.parentSessionId), childSession.getSpawnedFromSessionId(),
                "provenance is a plain reference; deleting the parent never cascades to the child");
        assertEquals("accepted", runStatus(child.runId()),
                "the child run keeps running independently of the deleted parent");

        ch.qos.logback.classic.Logger terminalLogger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(ChatRunTerminalService.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        terminalLogger.addAppender(appender);
        ChatRunCancellationService.CancelClaim claim;
        try {
            claim = cancellationService.cancelSerialized(
                    child.runId(), child.sessionId(), userId, workspaceId, "v4_child_after_parent_delete");
        } finally {
            terminalLogger.detachAppender(appender);
        }

        assertEquals(ChatRunCancellationService.CancelOutcome.CLAIMED, claim.outcome());
        ChatRun childRun = chatRunRepository.findById(UUID.fromString(child.runId())).orElseThrow();
        assertEquals("cancelled", childRun.getStatus(),
                "the orphaned child run must still reach a terminal state on its own");
        assertNotNull(childRun.getTerminalAt(), "child-local terminal commit writes terminal_at");
        String logs = appender.list.stream()
                .map(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage)
                .collect(Collectors.joining("\n"));
        assertTrue(logs.contains("derived_parent_missing"),
                "child-local terminal with a deleted parent must log the documented diagnostic: " + logs);
        assertTrue(sessionRepository.findById(UUID.fromString(child.sessionId())).isPresent(),
                "the child Session survives both the parent deletion and its own run terminal");
    }

    // ── fixtures ────────────────────────────────────────────────────────────

    /**
     * cancel 的 settle 会 fire-and-forget 排队 checkpoint capture（后台单线程）；
     * 其写入与会话级联删除交叉时 PG 会检出死锁并即刻失败。有界轮询重试等
     * capture 自然收敛，不使用固定 sleep。
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
                                 String toolCallId, UUID invocationId) {}

    private ParentFixture fixture(String toolName, String argumentsPreview) {
        ensureWorkspace();
        Session parentSession = new Session(workspaceId, userId,
                "Spawn lifecycle parent " + UUID.randomUUID().toString().substring(0, 8));
        parentSession.setId(UUID.randomUUID());
        parentSession.setAgentPrincipalId(principalId.toString());
        parentSession.setAgentPermissionsSnapshot(capNode());
        sessionRepository.saveAndFlush(parentSession);

        String parentRunId = saveRun(parentSession, "running");
        String toolCallId = UUID.randomUUID().toString();
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository,
                parentSession.getId().toString(), parentRunId, workspaceId, userId,
                toolCallId, toolName, argumentsPreview);
        UUID invocationId = mcpInvocationRepository.findByRunIdAndToolCallIdAndSource(
                parentRunId, toolCallId, "agent").orElseThrow().getId();
        return new ParentFixture(parentSession.getId().toString(), parentRunId,
                toolCallId, invocationId);
    }

    /** This suite isolates spawn lifecycle serialization; gate behavior is tested separately. */
    private ChatSubmissionService.SpawnResult spawnDirect(String parentRunId, String toolCallId) {
        ChatSubmissionService.SpawnInvocation invocation =
                submissionService.prepareSpawnInvocation(parentRunId, toolCallId);
        return submissionService.createSpawnFromParent(parentRunId, toolCallId,
                new ChatSubmissionService.SpawnAuthorization(invocation.authorizationBody(), null, null));
    }

    private String saveRun(Session session, String status) {
        String runId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(
                runId, session.getId().toString(), userId, workspaceId,
                "spawn-lifecycle-submit-" + runId, "spawn-lifecycle-hash-" + runId,
                "provider", "model", "workspace", status));
        return runId;
    }

    private void ensureWorkspace() {
        if (userId != null) {
            return;
        }
        User user = userRepository.save(new User("spawn-lifecycle-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Spawn lifecycle test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("Spawn lifecycle test", userId));
        workspaceId = workspace.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Spawn lifecycle principal");
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

    /**
     * spawn run 的 idempotency_key = parent toolCallId（生产路径固定），因此
     * 该键可精确定位注入点，不影响同事务之前的任何写入，也不影响其他测试的 run。
     */
    private void installSpawnRunFailureTrigger(String idempotencyKey) {
        jdbcTemplate.execute("CREATE OR REPLACE FUNCTION xihe_test_spawn_rollback_guard() RETURNS trigger "
                + "LANGUAGE plpgsql AS $$ BEGIN "
                + "RAISE EXCEPTION 'injected spawn rollback %', NEW.idempotency_key; END $$");
        jdbcTemplate.execute("CREATE TRIGGER xihe_test_spawn_rollback_guard "
                + "BEFORE INSERT ON chat_runs FOR EACH ROW "
                + "WHEN (NEW.idempotency_key = '" + idempotencyKey + "') "
                + "EXECUTE FUNCTION xihe_test_spawn_rollback_guard()");
    }

    private void dropSpawnRunFailureTrigger() {
        try {
            jdbcTemplate.execute("DROP TRIGGER IF EXISTS xihe_test_spawn_rollback_guard ON chat_runs");
            jdbcTemplate.execute("DROP FUNCTION IF EXISTS xihe_test_spawn_rollback_guard()");
        } catch (RuntimeException e) {
            org.slf4j.LoggerFactory.getLogger(SpawnLifecycleTest.class)
                    .warn("spawn rollback trigger cleanup failed: {}", e.getMessage(), e);
        }
    }

    private static boolean messagesContain(Throwable failure, String needle) {
        Throwable current = failure;
        int guard = 0;
        while (current != null && guard++ < 32) {
            if (current.getMessage() != null && current.getMessage().contains(needle)) {
                return true;
            }
            current = current.getCause();
        }
        return false;
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

    private int agentSpawnAuditCount() {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = 'agent_spawn_created'",
                Integer.class);
    }

}
