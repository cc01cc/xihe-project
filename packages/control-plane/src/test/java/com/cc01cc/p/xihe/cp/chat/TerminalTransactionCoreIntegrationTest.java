package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunHistoryRepository;
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
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
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
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;

/**
 * PLAN-0464 T1.2/T1.3/T2.1: the terminal transaction's durable faces are the
 * ChatRun row, its {@code chat_run_history} row, the child waiting link and the
 * Inbox notice — the Operation settlement face is gone.
 */
class TerminalTransactionCoreIntegrationTest extends AbstractIntegrationTest {
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private ChatRunHistoryRepository historyRepository;
    @Autowired private LedgerOperationRepository ledgerOperationRepository;
    @Autowired private OperationItemRepository operationItemRepository;
    @Autowired private OperationAttemptRepository operationAttemptRepository;
    @Autowired private OperationEventRepository operationEventRepository;
    @Autowired private OperationService operationService;
    @Autowired private ChatRunTerminalService terminalService;
    @Autowired private SessionService sessionService;
    @Autowired private GrantAuthorizationService grantAuthorizationService;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private PlatformTransactionManager transactionManager;
    @Autowired private com.cc01cc.p.xihe.cp.repository.McpInvocationRepository mcpInvocationRepository;

    @MockitoSpyBean
    private ChatRunHistoryWriter historyWriter;

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
    void v44AndV50TerminalColumnsAreMappedOnAChainThatIncludesV45() {
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
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM information_schema.columns "
                        + "WHERE table_schema = current_schema() AND table_name = 'chat_runs' "
                        + "AND column_name = 'waiting_on_run_id'",
                Integer.class), "PLAN-0464 V50 moved the waiting link onto the child run");
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM information_schema.tables "
                        + "WHERE table_schema = current_schema() AND table_name = 'chat_run_history'",
                Integer.class), "PLAN-0464 V50 added the ChatRun transition history");
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '45' AND success = true",
                Integer.class),
                "PLAN-0408 T1.1 added V45 to the chain this suite boots with");
    }

    @Test
    void rootTerminalCommitsRunTimestampAndHistoryTogether() {
        RunFixture root = createRun(createSession("root", null, null));

        ChatRunTerminalService.TerminalResult result = terminalService.terminalize(
                request(root, "succeeded", "success", null, ChatRunTerminalService.TerminalSource.STREAM));

        assertTrue(result.committed());
        ChatRun terminalRun = chatRunRepository.findById(root.run().getId()).orElseThrow();
        assertEquals("succeeded", terminalRun.getStatus());
        assertNotNull(terminalRun.getTerminalAt());
        List<com.cc01cc.p.xihe.cp.entity.ChatRunHistory> history =
                historyRepository.findByRunIdOrderBySequenceAsc(root.run().getId());
        assertEquals(1, history.size());
        assertEquals("terminal", history.get(0).getEventType());
        assertEquals("stream", history.get(0).getSource());
        assertEquals("succeeded", history.get(0).getToStatus());
        assertEquals("success", history.get(0).getTerminalOutcome());
    }

    @Test
    void childTerminalCommitsHistoryAndClearsWaitingLink() {
        SpawnFixture fixture = createSpawnFixture(true, "running");

        ChatRunTerminalService.TerminalResult result = terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM));

        assertTrue(result.committed());
        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("succeeded", child.getStatus());
        assertNotNull(child.getTerminalAt());
        assertNull(child.getWaitingOnRunId(), "the child waiting link must be settled");
        assertNull(child.getWaitingToolCallId());
        assertEquals(1, historyRepository.findByRunIdOrderBySequenceAsc(child.getId()).size());
        assertEquals("running", chatRunRepository.findById(fixture.parent().run().getId())
                .orElseThrow().getStatus(), "child terminal must not touch the parent run");
        // The legacy parent item is untouched by the terminal path (PLAN-0464 T1.2).
        OperationItem parentItem = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        assertEquals("running", parentItem.getStatus());
        assertNull(parentItem.getResultRef());
        assertEquals(fixture.child().run().getId(), parentItem.getWaitingOnRunId());
    }

    @Test
    void parentTerminalPreservesChildWaitingLinkUntilChildSettlesIt() {
        SpawnFixture fixture = createSpawnFixture(true, "running");

        operationService.transitionItem(fixture.parentItemId(), "completed", null, null, null, null);
        OperationItem completedToolItem = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        assertEquals("completed", completedToolItem.getStatus());
        assertEquals(fixture.child().run().getId(), completedToolItem.getWaitingOnRunId(),
                "finishing the parent tool result must preserve the previously committed link");

        assertTrue(terminalService.terminalize(request(fixture.parent(), "succeeded", "success", null,
                ChatRunTerminalService.TerminalSource.STREAM)).committed());
        ChatRun liveChild = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals(fixture.parent().run().getId().toString(), liveChild.getWaitingOnRunId(),
                "parent Run terminal must not clear a still-live child link");

        assertTrue(terminalService.terminalize(request(fixture.child(), "succeeded", "success", null,
                ChatRunTerminalService.TerminalSource.STREAM)).committed());

        ChatRun settled = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertNull(settled.getWaitingOnRunId());
        assertNull(settled.getWaitingToolCallId());
        assertEquals(1, historyRepository.findByRunIdOrderBySequenceAsc(settled.getId()).size());
        assertEquals(1, historyRepository.findByRunIdOrderBySequenceAsc(fixture.parent().run().getId()).size());
    }

    @Test
    void childTerminalLeavesTerminalParentOperationItemsUntouched() {
        SpawnFixture fixture = createSpawnFixture(true, "running");

        assertTrue(terminalService.terminalize(request(fixture.parent(), "succeeded", "success", null,
                ChatRunTerminalService.TerminalSource.STREAM)).committed());
        OperationItem before = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        assertEquals("running", before.getStatus());
        assertEquals(fixture.child().run().getId(), before.getWaitingOnRunId());
        int parentItemEventCount = operationEventRepository
                .findByItemIdOrderBySequenceAsc(fixture.parentItemId().toString()).size();

        assertTrue(terminalService.terminalize(request(fixture.child(), "failed", "error", "CHILD_TERMINAL_ERROR",
                ChatRunTerminalService.TerminalSource.STREAM)).committed());

        OperationItem settled = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        assertEquals("running", settled.getStatus(), "child terminal must not mutate a legacy parent item");
        assertNull(settled.getErrorCode());
        assertNull(settled.getFinishedAt());
        assertNull(settled.getResultRef(), "PLAN-0464: the terminal path no longer writes the parent item");
        assertEquals(fixture.child().run().getId(), settled.getWaitingOnRunId());
        assertEquals(parentItemEventCount, operationEventRepository
                .findByItemIdOrderBySequenceAsc(fixture.parentItemId().toString()).size(),
                "child settlement must not append a state event to the parent item");
        assertEquals("failed", chatRunRepository.findById(fixture.child().run().getId())
                .orElseThrow().getStatus());
    }

    @Test
    void childTerminalLeavesAlreadyFailedParentItemUntouched() {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        operationService.transitionItem(fixture.parentItemId(), "failed", null, null,
                "existing-parent-result", "PARENT_ITEM_ERROR");
        OperationItem before = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        int parentItemEventCount = operationEventRepository
                .findByItemIdOrderBySequenceAsc(fixture.parentItemId().toString()).size();

        assertTrue(terminalService.terminalize(request(fixture.child(), "failed", "error", "CHILD_TERMINAL_ERROR",
                ChatRunTerminalService.TerminalSource.STREAM)).committed());

        OperationItem settled = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        assertEquals("failed", settled.getStatus());
        assertEquals("PARENT_ITEM_ERROR", settled.getErrorCode());
        assertEquals(before.getFinishedAt(), settled.getFinishedAt());
        assertEquals("existing-parent-result", settled.getResultRef(),
                "an already-set result_ref is preserved — the terminal path never writes it");
        assertEquals(fixture.child().run().getId(), settled.getWaitingOnRunId());
        assertEquals(parentItemEventCount, operationEventRepository
                .findByItemIdOrderBySequenceAsc(fixture.parentItemId().toString()).size(),
                "terminal item settlement must not append a duplicate status event");
        assertEquals(1, historyRepository.findByRunIdOrderBySequenceAsc(fixture.child().run().getId()).size());
    }

    @Test
    void deletedParentAllowsChildLocalTerminalCommit() {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        sessionService.delete(fixture.parent().session().getId().toString(), userId, workspaceId);

        ChatRunTerminalService.TerminalResult result = terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM));

        assertTrue(result.committed());
        assertTrue(sessionRepository.findById(fixture.child().session().getId()).isPresent());
        assertEquals("succeeded", chatRunRepository.findById(fixture.child().run().getId()).orElseThrow().getStatus());
        assertEquals(1, historyRepository.findByRunIdOrderBySequenceAsc(fixture.child().run().getId()).size());
        assertTrue(operationItemRepository.findById(fixture.parentItemId()).isEmpty());
    }

    @Test
    void liveParentWithoutWaitingLinkRollsBackTerminalTransition() {
        SpawnFixture fixture = createSpawnFixture(false, "running");

        CpApiException failure = assertThrows(CpApiException.class, () -> terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM)));

        assertEquals("RUN_TERMINAL_INVARIANT_VIOLATION", failure.getCode());
        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("running", child.getStatus());
        assertNull(child.getTerminalAt());
        assertNull(child.getWaitingOnRunId());
        assertTrue(historyRepository.findByRunIdOrderBySequenceAsc(child.getId()).isEmpty());
        assertEquals("running", chatRunRepository.findById(fixture.parent().run().getId())
                .orElseThrow().getStatus());
        // The legacy parent item link is a fixture detail; the invariant that
        // matters is the child run's own missing waiting link.
        assertNotNull(operationItemRepository.findById(fixture.parentItemId()).orElseThrow().getWaitingOnRunId());
    }

    @Test
    void historyWriteFailureRollsBackRunAndParentLink() {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        doThrow(new IllegalStateException("forced history failure"))
                .when(historyWriter)
                .append(any(), any(), any(), any(), any(), any(), any(), any(), any(), any());

        assertThrows(IllegalStateException.class, () -> terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM)));

        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("running", child.getStatus());
        assertNull(child.getTerminalAt());
        assertNotNull(child.getWaitingOnRunId(), "a failed history write rolls the link settlement back");
        assertTrue(historyRepository.findByRunIdOrderBySequenceAsc(child.getId()).isEmpty());
        OperationItem item = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        assertEquals("running", item.getStatus());
        assertEquals(fixture.child().run().getId(), item.getWaitingOnRunId());
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
                        ChatRunTerminalService.TerminalSource.STREAM));
            });
            Future<ChatRunTerminalService.TerminalResult> failure = executor.submit(() -> {
                ready.countDown();
                start.await(5, TimeUnit.SECONDS);
                return terminalService.terminalize(request(root, "failed", "error", "PROVIDER_ERROR",
                        ChatRunTerminalService.TerminalSource.STREAM));
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
            assertEquals(1, historyRepository.findByRunIdOrderBySequenceAsc(terminal.getId()).size(),
                    "exactly one history row — only the CAS winner writes one");
        } finally {
            start.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void terminalRunBlocksTheDurableCallerGateButAllowsCheckpointMarkers() {
        RunFixture root = createRun(createSession("late-writer-root", null, null));
        String toolCallId = UUID.randomUUID().toString();
        OperationItem item = operationService.appendItem(root.operationId(), toolCallId,
                null, "tool_call", "mcp__test", "mcp", "{}", null, null);
        operationService.transitionItem(item.getId(), "running", null, null, null, null);
        var attempt = operationService.startAttempt(item.getId(), "cp_forward", null, "cp",
                UUID.randomUUID().toString());
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository,
                root.session().getId().toString(), root.run().getId().toString(), workspaceId, userId,
                toolCallId, "mcp__test", "{}");

        assertTrue(grantAuthorizationService.hasCurrentAgentToolCall(userId, workspaceId,
                root.session().getId().toString(), root.run().getId().toString(), toolCallId, "mcp__test"),
                "a live run authorizes its own durable tool call");

        assertTrue(terminalService.terminalize(request(root, "succeeded", "success", null,
                ChatRunTerminalService.TerminalSource.STREAM)).committed());

        // PLAN-0464 T2.2: the durable caller gate is the run lease + invocation
        // scope, so a terminal run fails closed even though the legacy Ledger
        // operation row is no longer finished by the terminal path.
        assertFalse(grantAuthorizationService.hasCurrentAgentToolCall(userId, workspaceId,
                root.session().getId().toString(), root.run().getId().toString(), toolCallId, "mcp__test"),
                "a terminal run must fail the durable caller gate closed");

        // PLAN-0464: the Ledger no longer mirrors run terminal state, so a late
        // ledger write is accepted — the durable caller gate above is now the
        // only thing that rejects the tool call (0467 drops the Ledger anyway).
        operationService.finishAttempt(attempt.getId(), "succeeded", 200, null, null, null);
        assertEquals("succeeded", operationAttemptRepository.findById(attempt.getId()).orElseThrow().getStatus());

        OperationItem marker = operationService.appendItem(root.operationId(), UUID.randomUUID().toString(),
                null, "checkpoint", "run_checkpoint", "runtime", "{}", null, null);
        operationService.transitionItem(marker.getId(), "completed", null, null, "checkpoint-ref", null);
        assertEquals("completed", operationItemRepository.findById(marker.getId()).orElseThrow().getStatus());
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
        if (createWaitingLink) {
            // PLAN-0464 T2.1: the waiting link lives on the child run row; the
            // legacy parent-item link stays as a fixture detail the terminal
            // must never touch.
            updatedChild.setWaitingOnRunId(parent.run().getId().toString());
            updatedChild.setWaitingToolCallId(toolCallId);
        }
        chatRunRepository.saveAndFlush(updatedChild);
        OperationItem linkedItem = operationItemRepository.findById(parentItem.getId()).orElseThrow();
        linkedItem.setWaitingOnRunId(child.run().getId());
        operationItemRepository.saveAndFlush(linkedItem);
        return new SpawnFixture(parent, parentItem.getId(), child, assistantMessageId, toolCallId);
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
                                                           ChatRunTerminalService.TerminalSource mode) {
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

    private record RunFixture(Session session, ChatRun run, UUID operationId) {}

    private record SpawnFixture(RunFixture parent, UUID parentItemId,
                                RunFixture child, String childAssistantMessageId, String toolCallId) {}
}
