package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.LedgerOperation;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.LedgerOperationRepository;
import com.cc01cc.p.xihe.cp.repository.OperationItemRepository;
import com.cc01cc.p.xihe.cp.repository.OperationAttemptRepository;
import com.cc01cc.p.xihe.cp.repository.OperationEventRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TerminalTransactionCoreIntegrationTest extends AbstractIntegrationTest {
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private LedgerOperationRepository ledgerOperationRepository;
    @Autowired private OperationItemRepository operationItemRepository;
    @Autowired private OperationAttemptRepository operationAttemptRepository;
    @Autowired private OperationEventRepository operationEventRepository;
    @Autowired private OperationService operationService;
    @Autowired private ChatRunTerminalService terminalService;
    @Autowired private SessionService sessionService;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private PlatformTransactionManager transactionManager;

    private String userId;
    private String workspaceId;
    private UUID principalId;
    private JsonNode permissionSnapshot;

    @BeforeEach
    void createTenant() {
        User user = userRepository.save(new User("terminal-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Terminal transaction integration test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("Terminal transaction test", userId));
        workspaceId = workspace.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Terminal test principal");
        principal.setCreatedByUserId(userId);
        ObjectNode template = objectMapper.createObjectNode();
        template.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(template);
        principalId = agentPrincipalRepository.saveAndFlush(principal).getId();
        permissionSnapshot = capabilitySnapshot();
        workspaceAgentRepository.saveAndFlush(
                new WorkspaceAgent(principalId.toString(), workspaceId, permissionSnapshot));
    }

    @AfterEach
    void awaitAfterCommitCheckpointMarkers() {
        Awaitility.await().atMost(Duration.ofSeconds(10)).pollInterval(Duration.ofMillis(50))
                .untilAsserted(() -> assertEquals(0, jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM chat_runs r "
                                + "JOIN ledger_operations o ON o.run_id = r.id "
                                + "WHERE r.workspace_id = CAST(? AS UUID) AND r.terminal_at IS NOT NULL "
                                + "AND NOT EXISTS (SELECT 1 FROM operation_items i "
                                + "WHERE i.operation_id = o.id AND i.tool_name = 'run_checkpoint' "
                                + "AND i.status = 'completed')",
                        Integer.class, workspaceId)));
    }

    @Test
    void v44MapsTerminalAndWaitingColumnsWithoutV45Inbox() {
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM information_schema.columns "
                        + "WHERE table_schema = current_schema() AND table_name = 'chat_runs' "
                        + "AND column_name = 'terminal_at'",
                Integer.class));
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM information_schema.columns "
                        + "WHERE table_schema = current_schema() AND table_name = 'operation_items' "
                        + "AND column_name = 'waiting_on_run_id'",
                Integer.class));
        assertEquals(0, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '45'", Integer.class));
    }

    @Test
    void rootTerminalCommitsRunTimestampAndOperationTogether() {
        RunFixture root = createRun(createSession("root", null, null));

        ChatRunTerminalService.TerminalResult result = terminalService.terminalize(
                request(root, "succeeded", "success", null, ChatRunTerminalService.LedgerMode.STREAM));

        assertTrue(result.committed());
        ChatRun terminalRun = chatRunRepository.findById(root.run().getId()).orElseThrow();
        assertEquals("succeeded", terminalRun.getStatus());
        assertNotNull(terminalRun.getTerminalAt());
        assertEquals("completed", ledgerOperationRepository.findByRunId(root.run().getId().toString())
                .orElseThrow().getStatus());
    }

    @Test
    void childTerminalCommitsParentResultReferenceAndClearsWaitingLink() {
        SpawnFixture fixture = createSpawnFixture(true, "running");

        ChatRunTerminalService.TerminalResult result = terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.LedgerMode.STREAM));

        assertTrue(result.committed());
        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("succeeded", child.getStatus());
        assertNotNull(child.getTerminalAt());
        OperationItem parentItem = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        assertEquals("completed", parentItem.getStatus());
        assertEquals(fixture.childAssistantMessageId(), parentItem.getResultRef());
        assertNull(parentItem.getWaitingOnRunId());
        assertEquals("running", ledgerOperationRepository.findByRunId(fixture.parent().run().getId().toString())
                .orElseThrow().getStatus());
        assertEquals("completed", ledgerOperationRepository.findByRunId(fixture.child().run().getId().toString())
                .orElseThrow().getStatus());
    }

    @Test
    void childTerminalAfterParentToolResultAndTerminalPreservesLinkAndSettlesResult() {
        SpawnFixture fixture = createSpawnFixture(true, "running");

        operationService.transitionItem(fixture.parentItemId(), "completed", null, null, null, null);
        OperationItem completedToolItem = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        assertEquals("completed", completedToolItem.getStatus());
        assertEquals(fixture.child().run().getId(), completedToolItem.getWaitingOnRunId(),
                "finishing the parent tool result must preserve the previously committed child link");

        assertTrue(terminalService.terminalize(request(fixture.parent(), "succeeded", "success", null,
                ChatRunTerminalService.LedgerMode.STREAM)).committed());
        assertEquals("completed", ledgerOperationRepository.findByRunId(fixture.parent().run().getId().toString())
                .orElseThrow().getStatus());
        assertEquals(fixture.child().run().getId(), operationItemRepository.findById(fixture.parentItemId())
                .orElseThrow().getWaitingOnRunId(), "parent Run terminal must not clear a still-live child link");

        assertTrue(terminalService.terminalize(request(fixture.child(), "succeeded", "success", null,
                ChatRunTerminalService.LedgerMode.STREAM)).committed());

        OperationItem parentItem = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        assertEquals("completed", parentItem.getStatus());
        assertEquals(fixture.childAssistantMessageId(), parentItem.getResultRef());
        assertNull(parentItem.getWaitingOnRunId());
        assertEquals("completed", ledgerOperationRepository.findByRunId(fixture.parent().run().getId().toString())
                .orElseThrow().getStatus());
    }

    @Test
    void childTerminalPreservesActiveParentItemWhenParentOperationIsTerminal() {
        SpawnFixture fixture = createSpawnFixture(true, "running");

        assertTrue(terminalService.terminalize(request(fixture.parent(), "succeeded", "success", null,
                ChatRunTerminalService.LedgerMode.STREAM)).committed());
        assertEquals("completed", ledgerOperationRepository.findById(fixture.parent().operationId())
                .orElseThrow().getStatus());
        OperationItem before = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        assertEquals("running", before.getStatus());
        assertEquals(fixture.child().run().getId(), before.getWaitingOnRunId());
        int parentItemEventCount = operationEventRepository
                .findByItemIdOrderBySequenceAsc(fixture.parentItemId().toString()).size();

        assertTrue(terminalService.terminalize(request(fixture.child(), "failed", "error", "CHILD_TERMINAL_ERROR",
                ChatRunTerminalService.LedgerMode.STREAM)).committed());

        OperationItem settled = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        assertEquals("running", settled.getStatus(), "late child completion must not mutate a terminal Operation");
        assertNull(settled.getErrorCode());
        assertNull(settled.getFinishedAt());
        assertEquals(fixture.childAssistantMessageId(), settled.getResultRef());
        assertNull(settled.getWaitingOnRunId());
        assertEquals(parentItemEventCount, operationEventRepository
                .findByItemIdOrderBySequenceAsc(fixture.parentItemId().toString()).size(),
                "child settlement must not append a state event to the terminal parent Operation");
        assertEquals("completed", ledgerOperationRepository.findById(fixture.parent().operationId())
                .orElseThrow().getStatus());
    }

    @Test
    void childTerminalPreservesErrorCodeAndFinishTimeOnTerminalParentItem() {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        operationService.transitionItem(fixture.parentItemId(), "failed", null, null,
                "existing-parent-result", "PARENT_ITEM_ERROR");
        OperationItem before = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        int parentItemEventCount = operationEventRepository
                .findByItemIdOrderBySequenceAsc(fixture.parentItemId().toString()).size();

        assertTrue(terminalService.terminalize(request(fixture.child(), "failed", "error", "CHILD_TERMINAL_ERROR",
                ChatRunTerminalService.LedgerMode.STREAM)).committed());

        OperationItem settled = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        assertEquals("failed", settled.getStatus());
        assertEquals("PARENT_ITEM_ERROR", settled.getErrorCode());
        assertEquals(before.getFinishedAt(), settled.getFinishedAt());
        assertEquals(fixture.childAssistantMessageId(), settled.getResultRef());
        assertNull(settled.getWaitingOnRunId());
        assertEquals(parentItemEventCount, operationEventRepository
                .findByItemIdOrderBySequenceAsc(fixture.parentItemId().toString()).size(),
                "terminal item settlement must not append a duplicate status event");
        assertEquals("running", ledgerOperationRepository.findById(fixture.parent().operationId())
                .orElseThrow().getStatus());
    }

    @Test
    void deletedParentAllowsChildLocalTerminalCommit() {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        sessionService.delete(fixture.parent().session().getId().toString(), userId, workspaceId);

        ChatRunTerminalService.TerminalResult result = terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.LedgerMode.STREAM));

        assertTrue(result.committed());
        assertTrue(sessionRepository.findById(fixture.child().session().getId()).isPresent());
        assertEquals("succeeded", chatRunRepository.findById(fixture.child().run().getId()).orElseThrow().getStatus());
        assertEquals("completed", ledgerOperationRepository.findByRunId(fixture.child().run().getId().toString())
                .orElseThrow().getStatus());
        assertTrue(operationItemRepository.findById(fixture.parentItemId()).isEmpty());
    }

    @Test
    void liveParentWithoutWaitingLinkRollsBackTerminalTransition() {
        SpawnFixture fixture = createSpawnFixture(false, "running");

        CpApiException failure = assertThrows(CpApiException.class, () -> terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.LedgerMode.STREAM)));

        assertEquals("RUN_TERMINAL_INVARIANT_VIOLATION", failure.getCode());
        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("running", child.getStatus());
        assertNull(child.getTerminalAt());
        assertEquals("running", ledgerOperationRepository.findByRunId(fixture.child().run().getId().toString())
                .orElseThrow().getStatus());
        assertNull(operationItemRepository.findById(fixture.parentItemId()).orElseThrow().getWaitingOnRunId());
    }

    @Test
    void ledgerTransitionFailureRollsBackRunAndParentLink() {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        operationService.transitionOperation(fixture.child().operationId(), "failed", "PREMATURE", null);

        CpApiException failure = assertThrows(CpApiException.class, () -> terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.LedgerMode.STREAM)));

        assertEquals("OPERATION_STATE_CONFLICT", failure.getCode());
        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("running", child.getStatus());
        assertNull(child.getTerminalAt());
        OperationItem item = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        assertEquals("running", item.getStatus());
        assertEquals(fixture.child().run().getId(), item.getWaitingOnRunId());
        assertEquals("failed", ledgerOperationRepository.findByRunId(fixture.child().run().getId().toString())
                .orElseThrow().getStatus());
    }

    @Test
    void concurrentTerminalRequestsHaveOneCasWinner() throws Exception {
        RunFixture root = createRun(createSession("cas-winner-root", null, null));
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<ChatRunTerminalService.TerminalResult> success = executor.submit(() -> {
                ready.countDown();
                start.await(5, TimeUnit.SECONDS);
                return terminalService.terminalize(request(root, "succeeded", "success", null,
                        ChatRunTerminalService.LedgerMode.STREAM));
            });
            Future<ChatRunTerminalService.TerminalResult> failure = executor.submit(() -> {
                ready.countDown();
                start.await(5, TimeUnit.SECONDS);
                return terminalService.terminalize(request(root, "failed", "error", "PROVIDER_ERROR",
                        ChatRunTerminalService.LedgerMode.STREAM));
            });
            assertTrue(ready.await(5, TimeUnit.SECONDS));
            start.countDown();
            ChatRunTerminalService.TerminalResult successResult = success.get(15, TimeUnit.SECONDS);
            ChatRunTerminalService.TerminalResult failureResult = failure.get(15, TimeUnit.SECONDS);
            assertEquals(1L, List.of(successResult, failureResult).stream()
                    .filter(ChatRunTerminalService.TerminalResult::committed).count());

            ChatRun terminal = chatRunRepository.findById(root.run().getId()).orElseThrow();
            assertTrue(List.of("succeeded", "failed").contains(terminal.getStatus()));
            assertNotNull(terminal.getTerminalAt());
            assertEquals("succeeded".equals(terminal.getStatus()) ? "completed" : "failed",
                    ledgerOperationRepository.findByRunId(root.run().getId().toString()).orElseThrow().getStatus());
        } finally {
            start.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void terminalOperationRejectsLateToolWritesButAllowsCheckpointMarkers() {
        RunFixture root = createRun(createSession("late-writer-root", null, null));
        OperationItem item = operationService.appendItem(root.operationId(), UUID.randomUUID().toString(),
                null, "tool_call", "mcp__test", "mcp", "{}", null, null);
        operationService.transitionItem(item.getId(), "running", null, null, null, null);
        var attempt = operationService.startAttempt(item.getId(), "cp_forward", null, "cp",
                UUID.randomUUID().toString());

        assertTrue(terminalService.terminalize(request(root, "succeeded", "success", null,
                ChatRunTerminalService.LedgerMode.STREAM)).committed());

        assertEquals("OPERATION_STATE_CONFLICT", assertThrows(CpApiException.class,
                () -> operationService.appendItem(root.operationId(), UUID.randomUUID().toString(), null,
                        "tool_call", "late_tool", "mcp", "{}", null, null)).getCode());
        assertEquals("OPERATION_STATE_CONFLICT", assertThrows(CpApiException.class,
                () -> operationService.transitionItem(item.getId(), "completed", null, null, null, null))
                .getCode());
        assertEquals("OPERATION_STATE_CONFLICT", assertThrows(CpApiException.class,
                () -> operationService.startAttempt(item.getId(), "late", null, "cp",
                        UUID.randomUUID().toString()))
                .getCode());

        operationService.finishAttempt(attempt.getId(), "succeeded", 200, null, null, null);
        assertEquals("started", operationAttemptRepository.findById(attempt.getId()).orElseThrow().getStatus());

        OperationItem marker = operationService.appendItem(root.operationId(), UUID.randomUUID().toString(),
                null, "checkpoint", "run_checkpoint", "runtime", "{}", null, null);
        operationService.transitionItem(marker.getId(), "completed", null, null, "checkpoint-ref", null);
        assertEquals("completed", operationItemRepository.findById(marker.getId()).orElseThrow().getStatus());
    }

    @Test
    void transitionItemWriterAndTerminalOwnerShareLedgerLockOrder() throws Exception {
        RunFixture root = createRun(createSession("lock-order-root", null, null));
        OperationItem item = operationService.appendItem(root.operationId(), UUID.randomUUID().toString(),
                null, "tool_call", "mcp__lock", "mcp", "{}", null, null);
        operationService.transitionItem(item.getId(), "running", null, null, null, null);
        TransactionTemplate transaction = new TransactionTemplate(transactionManager);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            Future<ChatRunTerminalService.TerminalResult> terminal = transaction.execute(status -> {
                ledgerOperationRepository.findByIdForUpdate(root.operationId()).orElseThrow();
                operationService.transitionItem(item.getId(), "failed", null, null, null, "TOOL_FAILED");
                Future<ChatRunTerminalService.TerminalResult> competing = executor.submit(
                        () -> terminalService.terminalize(request(root, "succeeded", "success", null,
                                ChatRunTerminalService.LedgerMode.STREAM)));
                awaitTerminalOperationLockWait(root.run().getId());
                return competing;
            });
            assertTrue(terminal.get(15, TimeUnit.SECONDS).committed());
            assertEquals("succeeded", chatRunRepository.findById(root.run().getId()).orElseThrow().getStatus());
            assertEquals("failed", operationItemRepository.findById(item.getId()).orElseThrow().getStatus());
            assertEquals("completed", ledgerOperationRepository.findByRunId(root.run().getId().toString())
                    .orElseThrow().getStatus());
            assertEquals("OPERATION_STATE_CONFLICT", assertThrows(CpApiException.class,
                    () -> operationService.transitionItem(item.getId(), "completed", null, null, null, null))
                    .getCode());
        } finally {
            executor.shutdownNow();
        }
    }

    private RunFixture createRun(Session session) {
        String runId = UUID.randomUUID().toString();
        String requestId = UUID.randomUUID().toString();
        ChatRun run = new ChatRun(runId, session.getId().toString(), userId, workspaceId,
                requestId, "t26-hash-" + runId,
                "provider", "model", "workspace", "running");
        run = chatRunRepository.saveAndFlush(run);
        OperationService.OperationStartResult started = operationService.startOperation(
                userId, session.getId().toString(), workspaceId, runId, requestId,
                "chat", "ui", "user", userId, "t26-idem-" + runId, "T2.6a integration");
        operationService.transitionOperation(started.operationId(), "running", null, null);
        return new RunFixture(session, run, started.operationId());
    }

    private SpawnFixture createSpawnFixture(boolean createWaitingLink, String parentItemStatus) {
        RunFixture parent = createRun(createSession("parent", null, null));
        String toolCallId = UUID.randomUUID().toString();
        OperationItem parentItem = operationService.appendItem(parent.operationId(), toolCallId, null,
                "tool_call", "spawn_agent", "agent", "{}", null, null);
        operationService.transitionItem(parentItem.getId(), "running", null, null, null, null);
        if (!"running".equals(parentItemStatus)) {
            operationService.transitionItem(parentItem.getId(), parentItemStatus,
                    null, null, "early-child-reference", null);
        }

        Session childSession = createSession("child", Session.KIND_SPAWN, parent);
        RunFixture child = createRun(childSession);
        String assistantMessageId = UUID.randomUUID().toString();
        ChatRun updatedChild = chatRunRepository.findById(child.run().getId()).orElseThrow();
        updatedChild.setAssistantMessageId(assistantMessageId);
        chatRunRepository.saveAndFlush(updatedChild);
        if (createWaitingLink) {
            OperationItem linkedItem = operationItemRepository.findById(parentItem.getId()).orElseThrow();
            linkedItem.setWaitingOnRunId(child.run().getId());
            operationItemRepository.saveAndFlush(linkedItem);
        }
        return new SpawnFixture(parent, parentItem.getId(), child, assistantMessageId);
    }

    private Session createSession(String title, String kind, RunFixture parent) {
        Session session = new Session(workspaceId, userId, title);
        session.setId(UUID.randomUUID());
        session.setAgentPrincipalId(principalId.toString());
        session.setAgentPermissionsSnapshot(permissionSnapshot.deepCopy());
        if (kind != null) {
            session.setKind(kind);
            session.setSpawnedFromSessionId(parent.session().getId());
            session.setSpawnedFromRunId(parent.run().getId());
            session.setSpawnedAt(Instant.now());
        }
        return sessionRepository.saveAndFlush(session);
    }

    private ChatRunTerminalService.TerminalRequest request(RunFixture run, String status,
                                                           String outcome, String errorCode,
                                                           ChatRunTerminalService.LedgerMode mode) {
        String detail = errorCode == null ? null : "terminal test error";
        return new ChatRunTerminalService.TerminalRequest(run.run().getId().toString(),
                List.of(run.run().getStatus()), status, outcome, errorCode, detail,
                run.run().getTokenCount(), run.run().getAssistantChars(), mode, List.of());
    }

    private Session createSession(String title) {
        return createSession(title, null, null);
    }

    private ArrayNode capabilitySnapshot() {
        ArrayNode caps = objectMapper.createArrayNode();
        ObjectNode read = objectMapper.createObjectNode();
        read.put("actionClass", "read");
        caps.add(read);
        return caps;
    }

    private void awaitTerminalOperationLockWait(UUID runId) {
        Awaitility.await().atMost(Duration.ofSeconds(4)).pollInterval(Duration.ofMillis(25))
                .untilAsserted(() -> assertTrue(jdbcTemplate.queryForObject(
                        "SELECT count(*) > 0 FROM pg_stat_activity WHERE application_name = ? "
                                + "AND state = 'active' AND wait_event_type = 'Lock'",
                        Boolean.class, "xihe-terminal-" + runId)));
    }

    private record RunFixture(Session session, ChatRun run, UUID operationId) {}

    private record SpawnFixture(RunFixture parent, UUID parentItemId,
                                RunFixture child, String childAssistantMessageId) {}
}
