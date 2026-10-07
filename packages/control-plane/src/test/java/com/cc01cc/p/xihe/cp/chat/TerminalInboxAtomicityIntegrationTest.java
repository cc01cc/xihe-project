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
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunHistoryRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.LedgerOperationRepository;
import com.cc01cc.p.xihe.cp.repository.OperationEventRepository;
import com.cc01cc.p.xihe.cp.repository.OperationItemRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.mockito.ArgumentCaptor;

import java.time.Duration;
import java.time.Instant;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;

/**
 * PLAN-0407 T2.6b: Inbox upsert inside the single terminal transaction, on the
 * PLAN-0408 V45 schema (real PostgreSQL).
 *
 * <p>Covers the mandated acceptance face: Inbox fault injection (all-face
 * rollback), missing-parent and live-link-mismatch branches, duplicate
 * terminal suppression, late child terminal after a terminal parent, and the
 * four PostgreSQL barriers (parent-delete-vs-terminal, cancel-vs-terminal,
 * spawn-vs-terminal, simultaneous sibling terminals) with both winners.
 * Every barrier proves real contention through
 * {@code pg_stat_activity.wait_event_type='Lock'} before the winner is
 * released, and asserts no deadlock/lock-timeout, one Inbox row per child
 * terminal, and settled parent items/waiting links (design #42/#44/#45).
 *
 * <p>The V44→V45 upgrade path is covered by PLAN-0408
 * {@code InboxV44UpgradeMigrationTest} (separate class/command/evidence); this
 * class runs on the migrated V45 chain the Spring context boots.
 */
class TerminalInboxAtomicityIntegrationTest extends AbstractIntegrationTest {
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private ChatRunHistoryRepository historyRepository;
    @Autowired private com.cc01cc.p.xihe.cp.repository.McpInvocationRepository mcpInvocationRepository;
    @Autowired private LedgerOperationRepository ledgerOperationRepository;
    @Autowired private OperationItemRepository operationItemRepository;
    @Autowired private OperationEventRepository operationEventRepository;
    @Autowired private OperationService operationService;
    @Autowired private ChatRunTerminalService terminalService;
    @Autowired private SessionService sessionService;
    @Autowired private ChatRunCancellationService cancellationService;
    @Autowired private ChatRunRecoveryService recoveryService;
    @Autowired private ChatController chatController;
    @Autowired private ChatSubmissionService submissionService;
    @Autowired private BranchPathService branchPathService;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private PlatformTransactionManager transactionManager;
    @MockitoSpyBean private SseEmitterManager sseEmitterManager;

    private String userId;
    private String workspaceId;
    private UUID principalId;
    private JsonNode permissionSnapshot;

    @BeforeEach
    void createTenant() {
        User user = userRepository.save(new User("t26b-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "T2.6b inbox terminal integration"));
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("T2.6b inbox test", userId));
        workspaceId = workspace.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("T2.6b principal");
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

    // ------------------------------------------------------------------
    // atomicity baseline, duplicate suppression, root terminal
    // ------------------------------------------------------------------

    @Test
    void childTerminalCommitsTerminalParentSettlementAndOneInboxRowAtomically() {
        SpawnFixture fixture = createSpawnFixture(true, "running");

        assertTrue(terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM)).committed());

        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("succeeded", child.getStatus());
        assertNotNull(child.getTerminalAt());
        assertNull(child.getWaitingOnRunId(), "the child waiting link must be settled");
        assertNull(child.getWaitingToolCallId());
        assertEquals(1, historyRepository.findByRunIdOrderBySequenceAsc(child.getId()).size());
        OperationItem parentItem = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        assertEquals("running", parentItem.getStatus(),
                "PLAN-0464 T1.2: the terminal path no longer settles the legacy parent item");
        assertNull(parentItem.getResultRef());
        assertEquals(fixture.child().run().getId(), parentItem.getWaitingOnRunId());

        assertEquals(1, inboxCountForParent(fixture.parent().session().getId()),
                "one child terminal must commit exactly one Inbox row");
        assertEquals("child_terminal", jdbcTemplate.queryForObject(
                "SELECT type FROM inbox WHERE ref = CAST(? AS UUID)", String.class,
                fixture.child().run().getId().toString()));
        assertEquals(fixture.child().session().getId().toString(), payloadField(fixture.child(), "sessionId"));
        assertEquals(fixture.child().run().getId().toString(), payloadField(fixture.child(), "runId"));
        assertEquals("success", payloadField(fixture.child(), "state"));
        assertEquals(Set.of("sessionId", "runId", "state"), payloadKeys(fixture.child()));
        assertNull(injectedRunId(fixture.child()), "injected_run_id stays NULL until a parent Run claims it");

        ChatRunTerminalService.TerminalResult repeat = terminalService.terminalize(
                request(fixture.child(), "failed", "error", "LATE",
                        ChatRunTerminalService.TerminalSource.STREAM));
        assertFalse(repeat.committed(), "a terminal run must not commit twice");
        assertEquals(1, inboxCountForParent(fixture.parent().session().getId()),
                "a lost repeat CAS must not add or rewrite Inbox rows");
    }

    @Test
    void partialChildTerminalCommitsPartialInboxState() {
        SpawnFixture fixture = createSpawnFixture(true, "running");

        assertTrue(terminalService.terminalize(
                request(fixture.child(), "partial", "partial", "PARTIAL_RESULT",
                        ChatRunTerminalService.TerminalSource.STREAM)).committed());

        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("partial", child.getStatus());
        assertNotNull(child.getTerminalAt());
        assertEquals("partial", payloadField(fixture.child(), "state"));
        assertEquals(1, inboxCountForParent(fixture.parent().session().getId()));
    }

    @Test
    void terminalCommitPublishesExactRefreshHintToParentSessionChannel() throws Exception {
        SpawnFixture fixture = createSpawnFixture(true, "running");

        assertTrue(terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM)).committed());

        ArgumentCaptor<Object> payloadCaptor = ArgumentCaptor.forClass(Object.class);
        verify(sseEmitterManager).send(eq(fixture.parent().session().getId().toString()),
                eq("derived_state_changed"), payloadCaptor.capture());
        JsonNode event = objectMapper.readTree(objectMapper.writeValueAsString(payloadCaptor.getValue()));
        Set<String> eventKeys = new LinkedHashSet<>();
        event.fieldNames().forEachRemaining(eventKeys::add);
        assertEquals(Set.of("sessionId", "runId", "state", "at"), eventKeys,
                "the SSE JSON must have exactly the four frozen keys");
        assertEquals(fixture.child().session().getId().toString(), event.get("sessionId").asText());
        assertEquals(fixture.child().run().getId().toString(), event.get("runId").asText());
        assertEquals("success", event.get("state").asText());
        Instant databaseTerminalAt = jdbcTemplate.queryForObject(
                "SELECT terminal_at FROM chat_runs WHERE id = CAST(? AS UUID)",
                (result, row) -> result.getTimestamp(1).toInstant(), fixture.child().run().getId().toString());
        assertEquals(databaseTerminalAt, Instant.parse(event.get("at").asText()),
                "SSE at must equal the committed durable terminal_at");
    }

    @Test
    void failedSseSendDoesNotUndoTerminalOrInboxCommit() {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        doThrow(new IllegalStateException("injected SSE send failure"))
                .when(sseEmitterManager).send(eq(fixture.parent().session().getId().toString()),
                        eq("derived_state_changed"), any());

        assertTrue(terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM)).committed());

        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("succeeded", child.getStatus());
        assertNotNull(child.getTerminalAt());
        assertEquals(1, inboxCountForParent(fixture.parent().session().getId()));
    }

    @Test
    void startupRecoveryTerminalUsesTheSharedInboxTransaction() {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        assertTrue(terminalService.terminalize(
                request(fixture.parent(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM)).committed());

        recoveryService.reconcileOnStartup();

        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("ambiguous", child.getStatus());
        assertEquals("ambiguous", child.getTerminalOutcome());
        assertNotNull(child.getTerminalAt());
        assertEquals(1, inboxCountForParent(fixture.parent().session().getId()));
        assertEquals("ambiguous", payloadField(fixture.child(), "state"));
    }

    @Test
    void startupRecoveryClosesCancellingChildThroughTheSharedInboxTransaction() {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        assertEquals(ChatRunCancellationService.CancelOutcome.CLAIMED,
                cancellationService.claimCancellation(fixture.child().run().getId().toString(),
                        fixture.child().session().getId().toString(), userId, workspaceId).outcome());

        recoveryService.reconcileOnStartup();

        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("cancelled", child.getStatus());
        assertEquals("cancelled", child.getTerminalOutcome());
        assertNotNull(child.getTerminalAt());
        assertEquals(1, inboxCountForParent(fixture.parent().session().getId()));
        assertEquals("cancelled", payloadField(fixture.child(), "state"));
    }

    @Test
    void staleReconciliationTerminalUsesTheSharedInboxTransaction() {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        assertTrue(terminalService.terminalize(
                request(fixture.parent(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM)).committed());
        ChatRunReconciliationService reconciler = new ChatRunReconciliationService(
                chatRunRepository, chatController, terminalService, -1);

        reconciler.reconcileStaleRuns();

        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("ambiguous", child.getStatus());
        assertEquals("CP_RECONCILED", child.getErrorCode());
        assertNotNull(child.getTerminalAt());
        assertEquals(1, inboxCountForParent(fixture.parent().session().getId()));
        assertEquals("ambiguous", payloadField(fixture.child(), "state"));
    }

    @Test
    void rootTerminalWritesNoInboxRow() {
        RunFixture root = createRun(createSession("root-no-inbox", null, null));

        assertTrue(terminalService.terminalize(
                request(root, "succeeded", "success", null, ChatRunTerminalService.TerminalSource.STREAM))
                .committed());

        assertEquals(0, inboxCountForRef(root.run().getId()),
                "a root terminal has no parent recipient and must not write an Inbox row");
    }

    @Test
    void realParentRunCreateClaimsInboxAtomicallyAndNeverTransfersIt() {
        Session parentSession = createSession("claim-parent", null, null);
        UUID firstInboxId = insertPendingInbox(parentSession.getId());
        String firstRunId = UUID.randomUUID().toString();

        ChatSubmissionService.Submission first = createParentRun(firstRunId, parentSession);

        assertEquals(UUID.fromString(firstRunId), first.run().getId());
        assertTrue(chatRunRepository.findById(UUID.fromString(firstRunId)).isPresent(),
                "the real parent ChatRun must exist with the claimed Inbox");
        assertEquals(firstRunId, claimedRunId(firstInboxId),
                "pending Inbox must be claimed in the real CP create transaction");

        assertTrue(terminalService.terminalize(
                request(new RunFixture(parentSession, first.run(), null),
                        "succeeded", "success", null, ChatRunTerminalService.TerminalSource.STREAM)).committed());
        String nextRunId = UUID.randomUUID().toString();
        createParentRun(nextRunId, parentSession);
        assertEquals(firstRunId, claimedRunId(firstInboxId),
                "a later parent Run must not automatically take over an already-claimed notice");

        Session rollbackSession = createSession("claim-rollback-parent", null, null);
        UUID rollbackInboxId = insertPendingInbox(rollbackSession.getId());
        String rolledBackRunId = UUID.randomUUID().toString();
        TransactionTemplate transaction = new TransactionTemplate(transactionManager);
        transaction.executeWithoutResult(status -> {
            createParentRun(rolledBackRunId, rollbackSession);
            assertTrue(chatRunRepository.findById(UUID.fromString(rolledBackRunId)).isPresent(),
                    "the ChatRun must be in the same outer transaction");
            assertEquals(rolledBackRunId, claimedRunId(rollbackInboxId));
            status.setRollbackOnly();
        });

        assertTrue(chatRunRepository.findById(UUID.fromString(rolledBackRunId)).isEmpty());
        assertNull(claimedRunId(rollbackInboxId),
                "Run and Inbox claim must roll back together");
    }

    // ------------------------------------------------------------------
    // Inbox fault injection and lifecycle branches
    // ------------------------------------------------------------------

    @Test
    void inboxWriteFailureRollsBackAllFacesThenExplicitRetrySucceeds() {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        try {
            jdbcTemplate.execute("CREATE FUNCTION fail_inbox_insert_t26b() RETURNS trigger "
                    + "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected inbox failure'; END $$");
            jdbcTemplate.execute("CREATE TRIGGER fail_inbox_insert_t26b BEFORE INSERT ON inbox "
                    + "FOR EACH ROW EXECUTE FUNCTION fail_inbox_insert_t26b()");

            assertThrows(Exception.class, () -> terminalService.terminalize(
                    request(fixture.child(), "succeeded", "success", null,
                            ChatRunTerminalService.TerminalSource.STREAM)));

            ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
            assertEquals("running", child.getStatus(), "ChatRun status must roll back");
            assertNull(child.getTerminalAt(), "terminal_at must roll back");
            OperationItem parentItem = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
            assertEquals("running", parentItem.getStatus(), "parent item status must roll back");
            assertNull(parentItem.getResultRef(), "parent resultRef must roll back");
            assertEquals(fixture.child().run().getId(), parentItem.getWaitingOnRunId(),
                    "waiting link must roll back with the Inbox failure");
            assertEquals("running", ledgerOperationRepository
                    .findByRunId(fixture.child().run().getId().toString()).orElseThrow().getStatus(),
                    "child ledger operation must roll back");
            assertEquals(0, inboxCountForParent(fixture.parent().session().getId()),
                    "no Inbox row may survive a failed write");
        } finally {
            jdbcTemplate.execute("DROP TRIGGER IF EXISTS fail_inbox_insert_t26b ON inbox");
            jdbcTemplate.execute("DROP FUNCTION IF EXISTS fail_inbox_insert_t26b()");
        }

        assertTrue(terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM)).committed(),
                "after the injected failure is removed the explicit retry must commit");
        assertEquals(1, inboxCountForParent(fixture.parent().session().getId()));
        assertEquals("success", payloadField(fixture.child(), "state"));
    }

    @Test
    void historyWriteFailureRollsBackTerminalAndInbox() {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        try {
            jdbcTemplate.execute("CREATE FUNCTION fail_history_insert_t12() RETURNS trigger "
                    + "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected history insert failure'; END $$");
            jdbcTemplate.execute("CREATE TRIGGER fail_history_insert_t12 BEFORE INSERT ON chat_run_history "
                    + "FOR EACH ROW EXECUTE FUNCTION fail_history_insert_t12()");

            assertThrows(Exception.class, () -> terminalService.terminalize(
                    request(fixture.child(), "succeeded", "success", null,
                            ChatRunTerminalService.TerminalSource.STREAM)));

            ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
            assertEquals("running", child.getStatus());
            assertNull(child.getTerminalAt());
            assertNotNull(child.getWaitingOnRunId(), "the link settlement must roll back too");
            assertEquals(0, historyRepository.findByRunIdOrderBySequenceAsc(child.getId()).size());
            assertEquals(0, inboxCountForRef(fixture.child().run().getId()));
        } finally {
            jdbcTemplate.execute("DROP TRIGGER IF EXISTS fail_history_insert_t12 ON chat_run_history");
            jdbcTemplate.execute("DROP FUNCTION IF EXISTS fail_history_insert_t12()");
        }
    }

    @Test
    void deletedParentCommitsChildLocalTerminalWithoutInboxAndEmitsDiagnostic() {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        sessionService.delete(fixture.parent().session().getId().toString(), userId, workspaceId);
        ChatRun beforeChildTerminal = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("running", beforeChildTerminal.getStatus(),
                "parent deletion must leave the child Run active for independent continuation");
        assertNull(beforeChildTerminal.getTerminalAt());

        try (LogCapture logs = new LogCapture(ChatRunTerminalService.class)) {
            assertTrue(terminalService.terminalize(
                    request(fixture.child(), "succeeded", "success", null,
                            ChatRunTerminalService.TerminalSource.STREAM)).committed());
            assertTrue(logs.saw("derived_parent_missing"),
                    "the missing parent must be recorded as a structured diagnostic");
        }

        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("succeeded", child.getStatus());
        assertNotNull(child.getTerminalAt());
        assertEquals(1, historyRepository.findByRunIdOrderBySequenceAsc(child.getId()).size(),
                "the child-local history row must still commit");
        assertTrue(sessionRepository.findById(fixture.child().session().getId()).isPresent(),
                "child Session stays independent of the deleted parent");
        assertTrue(operationItemRepository.findById(fixture.parentItemId()).isEmpty());
        assertEquals(0, inboxCountForRef(fixture.child().run().getId()), "a missing parent has no recipient, so no Inbox row");
    }

    @Test
    void liveParentWithoutWaitingLinkRollsBackWithoutInboxAndEmitsDiagnostic() {
        SpawnFixture fixture = createSpawnFixture(false, "running");

        try (LogCapture logs = new LogCapture(ChatRunTerminalService.class)) {
            CpApiException failure = assertThrows(CpApiException.class, () -> terminalService.terminalize(
                    request(fixture.child(), "succeeded", "success", null,
                            ChatRunTerminalService.TerminalSource.STREAM)));
            assertEquals("RUN_TERMINAL_INVARIANT_VIOLATION", failure.getCode());
            assertTrue(logs.saw("terminal_invariant_failed"),
                    "a live-parent link mismatch must be recorded as a structured consistency error");
        }

        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("running", child.getStatus());
        assertNull(child.getTerminalAt());
        assertNull(child.getWaitingOnRunId());
        assertTrue(historyRepository.findByRunIdOrderBySequenceAsc(child.getId()).isEmpty());
        assertEquals(0, inboxCountForRef(fixture.child().run().getId()), "a rolled-back terminal must leave no Inbox row");
    }

    @Test
    void lateChildTerminalAfterParentTerminalPreservesParentAndWritesOneInboxRow() {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        assertTrue(terminalService.terminalize(
                request(fixture.parent(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM)).committed());
        assertEquals("succeeded", chatRunRepository.findById(fixture.parent().run().getId())
                .orElseThrow().getStatus());
        ChatRun liveChild = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals(fixture.parent().run().getId().toString(), liveChild.getWaitingOnRunId(),
                "a parent terminal keeps a still-live child link");
        OperationItem before = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        assertEquals(fixture.child().run().getId(), before.getWaitingOnRunId());
        int parentItemEvents = operationEventRepository
                .findByItemIdOrderBySequenceAsc(fixture.parentItemId().toString()).size();

        assertTrue(terminalService.terminalize(
                request(fixture.child(), "failed", "error", "CHILD_ERROR",
                        ChatRunTerminalService.TerminalSource.STREAM)).committed());

        OperationItem settled = operationItemRepository.findById(fixture.parentItemId()).orElseThrow();
        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("failed", child.getStatus());
        assertNotNull(child.getTerminalAt());
        assertNull(child.getWaitingOnRunId(), "the late child terminal settles its own link");
        assertEquals("running", settled.getStatus(), "the legacy parent item status must be preserved");
        assertNull(settled.getErrorCode());
        assertNull(settled.getResultRef(), "PLAN-0464: the terminal path no longer writes the parent item");
        assertEquals(fixture.child().run().getId(), settled.getWaitingOnRunId());
        assertEquals(parentItemEvents, operationEventRepository
                .findByItemIdOrderBySequenceAsc(fixture.parentItemId().toString()).size(),
                "a late child terminal must not reopen or append parent item events");
        assertEquals(1, inboxCountForParent(fixture.parent().session().getId()),
                "the late child terminal still commits exactly one Inbox row");
        assertEquals("error", payloadField(fixture.child(), "state"));
    }

    // ------------------------------------------------------------------
    // barrier: parent delete vs terminal
    // ------------------------------------------------------------------

    @Test
    void parentDeleteWinsAgainstChildTerminalBarrier() throws Exception {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            Future<ChatRunTerminalService.TerminalResult> terminal = executor.submit(() -> {
                start.await(5, TimeUnit.SECONDS);
                return terminalService.terminalize(request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM));
            });
            TransactionTemplate tx = new TransactionTemplate(transactionManager);
            tx.execute(status -> {
                sessionRepository.findByIdForUpdate(fixture.parent().session().getId()).orElseThrow();
                start.countDown();
                awaitTerminalLockWait(fixture.child().run().getId(), 1);
                sessionService.delete(fixture.parent().session().getId().toString(), userId, workspaceId);
                return null;
            });
            assertTrue(terminal.get(20, TimeUnit.SECONDS).committed(),
                    "delete-wins still commits the child-local terminal");
        } finally {
            start.countDown();
            executor.shutdownNow();
        }

        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("succeeded", child.getStatus());
        assertNotNull(child.getTerminalAt());
        assertTrue(sessionRepository.findById(fixture.parent().session().getId()).isEmpty());
        assertTrue(operationItemRepository.findById(fixture.parentItemId()).isEmpty());
        assertEquals(0, inboxCountForRef(fixture.child().run().getId()), "delete-wins leaves no parent aggregate and no Inbox row");
        assertTrue(sessionRepository.findById(fixture.child().session().getId()).isPresent());
    }

    @Test
    void terminalWinsAgainstParentDeleteBarrierAndDeleteClearsTheCommittedInbox() throws Exception {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        Future<Void> deletion = null;
        try {
            Future<ChatRunTerminalService.TerminalResult> terminal = executor.submit(() -> {
                start.await(5, TimeUnit.SECONDS);
                return terminalService.terminalize(request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM));
            });
            TransactionTemplate tx = new TransactionTemplate(transactionManager);
            deletion = tx.execute(status -> {
                chatRunRepository.findByIdForUpdate(fixture.parent().run().getId()).orElseThrow();
                start.countDown();
                awaitTerminalLockWait(fixture.child().run().getId(), 1);
                Future<Void> pending = executor.submit(() -> {
                    sessionService.delete(fixture.parent().session().getId().toString(), userId, workspaceId);
                    return null;
                });
                awaitLockWaiters(2);
                return pending;
            });
            assertNotNull(deletion, "the competing delete must be submitted while the terminal is blocked");
            assertTrue(terminal.get(20, TimeUnit.SECONDS).committed(),
                    "terminal-wins commits before the blocked delete can proceed");
            deletion.get(20, TimeUnit.SECONDS);
        } finally {
            start.countDown();
            executor.shutdownNow();
        }

        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("succeeded", child.getStatus());
        assertTrue(sessionRepository.findById(fixture.parent().session().getId()).isEmpty(),
                "the blocked parent delete must complete after the terminal commit");
        assertEquals(0, inboxCountForParent(fixture.parent().session().getId()),
                "parent delete clears the Inbox row the terminal commit created");
        assertTrue(sessionRepository.findById(fixture.child().session().getId()).isPresent());
        assertTrue(chatRunRepository.findById(fixture.child().run().getId()).isPresent());
    }

    @Test
    void parentDeleteClearsTheInboxRowCommittedByTerminal() {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        assertTrue(terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM)).committed());
        assertEquals(1, inboxCountForParent(fixture.parent().session().getId()),
                "terminal-wins commits the Inbox row first");

        sessionService.delete(fixture.parent().session().getId().toString(), userId, workspaceId);

        assertEquals(0, inboxCountForParent(fixture.parent().session().getId()),
                "parent delete clears its Inbox rows");
        assertTrue(sessionRepository.findById(fixture.child().session().getId()).isPresent());
        assertTrue(chatRunRepository.findById(fixture.child().run().getId()).isPresent(),
                "child Session/ChatRun survive a parent delete");
    }

    // ------------------------------------------------------------------
    // barrier: cancel claim vs terminal
    // ------------------------------------------------------------------

    @Test
    void cancelClaimWinsAgainstChildTerminalBarrier() throws Exception {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<ChatRunTerminalService.TerminalResult> terminal = executor.submit(() -> {
                start.await(5, TimeUnit.SECONDS);
                return terminalService.terminalize(request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM));
            });
            TransactionTemplate tx = new TransactionTemplate(transactionManager);
            ChatRunCancellationService.CancelClaim claim = tx.execute(status -> {
                sessionRepository.findByIdForUpdate(fixture.parent().session().getId()).orElseThrow();
                start.countDown();
                awaitTerminalLockWait(fixture.child().run().getId(), 1);
                Future<ChatRunCancellationService.CancelClaim> pending = executor.submit(
                        () -> cancellationService.claimCancellation(fixture.child().run().getId().toString(),
                                fixture.child().session().getId().toString(), userId, workspaceId));
                return join(pending);
            });
            assertNotNull(claim);
            assertEquals(ChatRunCancellationService.CancelOutcome.CLAIMED, claim.outcome(),
                    "the cancel claim must win while the terminal transaction is blocked");

            assertFalse(terminal.get(20, TimeUnit.SECONDS).committed(),
                    "a claimed run must not commit a competing terminal transition");
        } finally {
            start.countDown();
            executor.shutdownNow();
        }

        assertTrue(terminalService.terminalize(
                requestExpected(fixture.child(), List.of("cancelling"), "cancelled", "cancelled", null,
                        ChatRunTerminalService.TerminalSource.CANCELLATION)).committed());
        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("cancelled", child.getStatus());
        assertNotNull(child.getTerminalAt());
        assertEquals(1, inboxCountForParent(fixture.parent().session().getId()),
                "only the cancellation commits the single Inbox row");
        assertEquals("cancelled", payloadField(fixture.child(), "state"),
                "the cancellation outcome owns the notification");
    }

    @Test
    void terminalWinsAgainstCancelClaimBarrier() throws Exception {
        SpawnFixture fixture = createSpawnFixture(true, "running");
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<ChatRunTerminalService.TerminalResult> terminal = executor.submit(() -> {
                start.await(5, TimeUnit.SECONDS);
                return terminalService.terminalize(request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM));
            });
            TransactionTemplate tx = new TransactionTemplate(transactionManager);
            Future<ChatRunCancellationService.CancelClaim> claimFuture = tx.execute(status -> {
                chatRunRepository.findByIdForUpdate(fixture.child().run().getId()).orElseThrow();
                start.countDown();
                awaitTerminalLockWait(fixture.child().run().getId(), 1);
                Future<ChatRunCancellationService.CancelClaim> pending = executor.submit(
                        () -> cancellationService.claimCancellation(fixture.child().run().getId().toString(),
                                fixture.child().session().getId().toString(), userId, workspaceId));
                awaitLockWaiters(2);
                return pending;
            });
            assertNotNull(claimFuture, "the competing cancel claim must start while the terminal is blocked");
            assertTrue(terminal.get(20, TimeUnit.SECONDS).committed(),
                    "the terminal transaction wins the CAS");
            ChatRunCancellationService.CancelClaim claim = claimFuture.get(20, TimeUnit.SECONDS);
            assertEquals(ChatRunCancellationService.CancelOutcome.NOT_CANCELLABLE, claim.outcome(),
                    "a cancelled-away loser must observe the terminal state");
        } finally {
            start.countDown();
            executor.shutdownNow();
        }

        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("succeeded", child.getStatus());
        assertNotNull(child.getTerminalAt());
        assertEquals(1, inboxCountForParent(fixture.parent().session().getId()),
                "terminal-wins commits exactly one Inbox row");
        assertEquals("success", payloadField(fixture.child(), "state"));
        assertNull(chatRunRepository.findById(fixture.child().run().getId()).orElseThrow().getWaitingOnRunId(),
                "terminal-wins settles the child waiting link");
    }

    // ------------------------------------------------------------------
    // barrier: spawn vs terminal
    // ------------------------------------------------------------------

    @Test
    void spawnWinsThenParentTerminalPreservesLinkAndChildTerminalWritesInbox() throws Exception {
        RunFixture parent = createRun(createSession("spawn-parent", null, null));
        String toolCallId = UUID.randomUUID().toString();
        OperationItem spawnEvent = operationService.appendItem(parent.operationId(), toolCallId, null,
                "tool_call", "spawn_agent", "agent", "{\"prompt\":\"child instruction\"}", null, null);
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository,
                parent.session().getId().toString(), parent.run().getId().toString(), workspaceId, userId,
                toolCallId, "spawn_agent", "{\"prompt\":\"child instruction\"}");
        ChatSubmissionService.SpawnAuthorization authorization = new ChatSubmissionService.SpawnAuthorization(
                spawnAuthorizationBody("child instruction"), null, null);

        CountDownLatch start = new CountDownLatch(1);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        ChatSubmissionService.SpawnResult spawned = null;
        try {
            Future<ChatRunTerminalService.TerminalResult> terminal = executor.submit(() -> {
                start.await(5, TimeUnit.SECONDS);
                return terminalService.terminalize(request(parent, "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM));
            });
            TransactionTemplate tx = new TransactionTemplate(transactionManager);
            spawned = tx.execute(status -> {
                sessionRepository.findByIdForUpdate(parent.session().getId()).orElseThrow();
                start.countDown();
                awaitTerminalLockWait(parent.run().getId(), 1);
                return submissionService.createSpawnFromParent(parent.run().getId().toString(), toolCallId,
                        authorization);
            });
            assertNotNull(spawned);
            assertTrue(terminal.get(20, TimeUnit.SECONDS).committed(),
                    "the parent terminal settles after the spawn transaction commits");
        } finally {
            start.countDown();
            executor.shutdownNow();
        }

        assertNotNull(spawned, "the spawn transaction must commit with the holding transaction");
        ChatRun childRun = chatRunRepository.findById(UUID.fromString(spawned.runId())).orElseThrow();
        assertEquals(ChatRun.ORIGIN_SPAWN, childRun.getOrigin());
        assertEquals(parent.run().getId().toString(), childRun.getWaitingOnRunId(),
                "spawn wins: the waiting link commits exactly once on the child run");
        assertEquals(toolCallId, childRun.getWaitingToolCallId());
        assertNull(operationItemRepository.findById(spawnEvent.getId()).orElseThrow().getWaitingOnRunId(),
                "PLAN-0464: createSpawnFromParent no longer writes the legacy parent item link");
        assertEquals("succeeded", chatRunRepository.findById(parent.run().getId()).orElseThrow().getStatus());
        assertEquals(0, inboxCountForParent(parent.session().getId()),
                "a root parent terminal writes no Inbox row");

        Session childSessionRow = sessionRepository
                .findById(UUID.fromString(childRun.getSessionId())).orElseThrow();
        assertTrue(terminalService.terminalize(
                request(new RunFixture(childSessionRow, childRun, parent.operationId()),
                        "succeeded", "success", null, ChatRunTerminalService.TerminalSource.STREAM)).committed());
        assertEquals(1, inboxCountForParent(parent.session().getId()),
                "the child terminal after the spawn-wins race commits exactly one Inbox row");
        assertEquals(childRun.getId().toString(),
                jdbcTemplate.queryForObject("SELECT ref::text FROM inbox WHERE to_session_id = CAST(? AS UUID)",
                        String.class, parent.session().getId().toString()));
    }

    @Test
    void parentTerminalRejectsConcurrentSpawnWithZeroHalfRows() throws Exception {
        RunFixture parent = createRun(createSession("reject-parent", null, null));
        String toolCallId = UUID.randomUUID().toString();
        OperationItem spawnEvent = operationService.appendItem(parent.operationId(), toolCallId, null,
                "tool_call", "spawn_agent", "agent", "{\"prompt\":\"child instruction\"}", null, null);
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository,
                parent.session().getId().toString(), parent.run().getId().toString(), workspaceId, userId,
                toolCallId, "spawn_agent", "{\"prompt\":\"child instruction\"}");
        ChatSubmissionService.SpawnAuthorization authorization = new ChatSubmissionService.SpawnAuthorization(
                spawnAuthorizationBody("child instruction"), null, null);
        int sessionsBefore = totalSessionRows();

        assertTrue(terminalService.terminalize(
                request(parent, "succeeded", "success", null, ChatRunTerminalService.TerminalSource.STREAM))
                .committed());

        CountDownLatch start = new CountDownLatch(1);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            Future<ChatSubmissionService.SpawnResult> spawn = executor.submit(() -> {
                start.await(5, TimeUnit.SECONDS);
                return submissionService.createSpawnFromParent(parent.run().getId().toString(), toolCallId,
                        authorization);
            });
            TransactionTemplate tx = new TransactionTemplate(transactionManager);
            tx.execute(status -> {
                chatRunRepository.findByIdForUpdate(parent.run().getId()).orElseThrow();
                start.countDown();
                awaitLockWaiters(1);
                return null;
            });
            ExecutionException rejection = assertThrows(ExecutionException.class,
                    () -> spawn.get(20, TimeUnit.SECONDS));
            assertTrue(rejection.getCause() instanceof CpApiException,
                    "a rejected spawn must fail with the admission error");
            assertEquals("SPAWN_PARENT_RUN_NOT_ACTIVE", ((CpApiException) rejection.getCause()).getCode());
        } finally {
            start.countDown();
            executor.shutdownNow();
        }

        assertEquals(0, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM chat_runs WHERE origin = 'spawn'", Integer.class),
                "a rejected spawn must leave zero child ChatRun rows");
        assertNull(operationItemRepository.findById(spawnEvent.getId()).orElseThrow().getWaitingOnRunId(),
                "a rejected spawn must leave no waiting link");
        assertEquals(sessionsBefore, totalSessionRows(),
                "a rejected spawn must not create a Session");
        assertEquals(0, inboxCountForParent(parent.session().getId()));
    }

    // ------------------------------------------------------------------
    // barrier: simultaneous sibling terminals
    // ------------------------------------------------------------------

    @Test
    void siblingChildTerminalsEachCommitExactlyOneInboxRowUnderContention() throws Exception {
        RunFixture parent = createRun(createSession("sibling-parent", null, null));
        SpawnFixture first = attachChild(parent, spawnItem(parent), "sibling-a");
        SpawnFixture second = attachChild(parent, spawnItem(parent), "sibling-b");

        CountDownLatch start = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<ChatRunTerminalService.TerminalResult> firstTerminal = executor.submit(() -> {
                start.await(5, TimeUnit.SECONDS);
                return terminalService.terminalize(request(first.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM));
            });
            Future<ChatRunTerminalService.TerminalResult> secondTerminal = executor.submit(() -> {
                start.await(5, TimeUnit.SECONDS);
                return terminalService.terminalize(request(second.child(), "failed", "error", "SIBLING_ERROR",
                        ChatRunTerminalService.TerminalSource.STREAM));
            });
            TransactionTemplate tx = new TransactionTemplate(transactionManager);
            tx.execute(status -> {
                sessionRepository.findByIdForUpdate(parent.session().getId()).orElseThrow();
                start.countDown();
                awaitTerminalLockWait(first.child().run().getId(), 1);
                awaitTerminalLockWait(second.child().run().getId(), 1);
                return null;
            });
            assertTrue(firstTerminal.get(20, TimeUnit.SECONDS).committed());
            assertTrue(secondTerminal.get(20, TimeUnit.SECONDS).committed());
        } finally {
            start.countDown();
            executor.shutdownNow();
        }

        assertEquals(2, inboxCountForParent(parent.session().getId()),
                "each sibling child terminal closes exactly one Inbox row");
        assertEquals(Set.of(first.child().run().getId().toString(), second.child().run().getId().toString()),
                new LinkedHashSet<>(jdbcTemplate.queryForList(
                        "SELECT ref::text FROM inbox WHERE to_session_id = CAST(? AS UUID) ORDER BY ref",
                        String.class, parent.session().getId().toString())),
                "sibling notices must be distinct rows, never overwriting each other");
        assertEquals("success", payloadField(first.child(), "state"));
        assertEquals("error", payloadField(second.child(), "state"));
        ChatRun firstChild = chatRunRepository.findById(first.child().run().getId()).orElseThrow();
        ChatRun secondChild = chatRunRepository.findById(second.child().run().getId()).orElseThrow();
        assertNull(firstChild.getWaitingOnRunId(), "each sibling settles its own waiting link");
        assertNull(secondChild.getWaitingOnRunId());
        assertEquals(1, historyRepository.findByRunIdOrderBySequenceAsc(firstChild.getId()).size());
        assertEquals(1, historyRepository.findByRunIdOrderBySequenceAsc(secondChild.getId()).size());
    }

    // ------------------------------------------------------------------
    // fixtures
    // ------------------------------------------------------------------

    private RunFixture createRun(Session session) {
        String runId = UUID.randomUUID().toString();
        String requestId = UUID.randomUUID().toString();
        ChatRun run = new ChatRun(runId, session.getId().toString(), userId, workspaceId,
                requestId, "t26b-hash-" + runId,
                "provider", "model", "workspace", "running");
        run = chatRunRepository.saveAndFlush(run);
        OperationService.OperationStartResult started = operationService.startOperation(
                userId, session.getId().toString(), workspaceId, runId, requestId,
                "chat", "ui", "user", userId, "t26b-idem-" + runId, "T2.6b integration");
        operationService.transitionOperation(started.operationId(), "running", null, null);
        return new RunFixture(session, run, started.operationId());
    }

    private OperationItem spawnItem(RunFixture parent) {
        OperationItem item = operationService.appendItem(parent.operationId(), UUID.randomUUID().toString(),
                null, "tool_call", "spawn_agent", "agent", "{}", null, null);
        operationService.transitionItem(item.getId(), "running", null, null, null, null);
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository,
                parent.session().getId().toString(), parent.run().getId().toString(), workspaceId, userId,
                item.getToolCallId(), "spawn_agent", "{}");
        return item;
    }

    private ChatSubmissionService.Submission createParentRun(String runId, Session session) {
        String branchId = branchPathService.ensureRootBranchId(session.getId().toString());
        return submissionService.create(runId, session.getId().toString(), userId, workspaceId,
                branchId, principalId.toString(), "claim-idem-" + runId, "a".repeat(64), "provider", "model",
                "workspace", null, null, "t26b-claim", UUID.randomUUID().toString(),
                "process pending child notices", "[]", List.of());
    }

    private UUID insertPendingInbox(UUID parentSessionId) {
        UUID inboxId = UUID.randomUUID();
        UUID childSessionId = UUID.randomUUID();
        UUID childRunId = UUID.randomUUID();
        String payload = "{\"sessionId\":\"" + childSessionId + "\",\"runId\":\"" + childRunId
                + "\",\"state\":\"success\"}";
        jdbcTemplate.update("INSERT INTO inbox (id, to_session_id, type, ref, payload_pointer) "
                        + "VALUES (?, ?, 'child_terminal', ?, CAST(? AS jsonb))",
                inboxId, parentSessionId, childRunId, payload);
        return inboxId;
    }

    private String claimedRunId(UUID inboxId) {
        return jdbcTemplate.queryForObject("SELECT injected_run_id::text FROM inbox WHERE id = CAST(? AS UUID)",
                String.class, inboxId);
    }

    private SpawnFixture attachChild(RunFixture parent, OperationItem item, String title) {
        Session childSession = createSession(title, Session.KIND_SPAWN, parent);
        RunFixture child = createRun(childSession);
        String assistantMessageId = UUID.randomUUID().toString();
        ChatRun updatedChild = chatRunRepository.findById(child.run().getId()).orElseThrow();
        updatedChild.setAssistantMessageId(assistantMessageId);
        // PLAN-0464 T2.1: the waiting link lives on the child run row.
        updatedChild.setWaitingOnRunId(parent.run().getId().toString());
        updatedChild.setWaitingToolCallId(item.getToolCallId());
        chatRunRepository.saveAndFlush(updatedChild);
        OperationItem linkedItem = operationItemRepository.findById(item.getId()).orElseThrow();
        linkedItem.setWaitingOnRunId(child.run().getId());
        operationItemRepository.saveAndFlush(linkedItem);
        return new SpawnFixture(parent, item.getId(), child, assistantMessageId);
    }

    private SpawnFixture createSpawnFixture(boolean createWaitingLink, String parentItemStatus) {
        RunFixture parent = createRun(createSession("parent", null, null));
        OperationItem item = spawnItem(parent);
        if (!"running".equals(parentItemStatus)) {
            operationService.transitionItem(item.getId(), parentItemStatus, null, null,
                    "early-child-reference", null);
        }
        SpawnFixture fixture = attachChild(parent, item, "child");
        if (!createWaitingLink) {
            ChatRun unlinked = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
            unlinked.setWaitingOnRunId(null);
            unlinked.setWaitingToolCallId(null);
            chatRunRepository.saveAndFlush(unlinked);
        }
        return fixture;
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

    /** Mirrors ChatSubmissionService.createSpawnAuthorizationBody for the MCP spawn path. */
    private static String spawnAuthorizationBody(String prompt) {
        return "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,"
                + "\"params\":{\"name\":\"spawn_agent\",\"arguments\":{\"prompt\":\"" + prompt + "\"}}}";
    }

    private ChatRunTerminalService.TerminalRequest request(RunFixture run, String status, String outcome,
                                                           String errorCode,
                                                           ChatRunTerminalService.TerminalSource mode) {
        return requestExpected(run, List.of(run.run().getStatus()), status, outcome, errorCode, mode);
    }

    private ChatRunTerminalService.TerminalRequest requestExpected(RunFixture run, List<String> expected,
                                                                   String status, String outcome,
                                                                   String errorCode,
                                                                   ChatRunTerminalService.TerminalSource mode) {
        String detail = errorCode == null ? null : "terminal inbox test error";
        return new ChatRunTerminalService.TerminalRequest(run.run().getId().toString(),
                expected, status, outcome, errorCode, detail,
                run.run().getTokenCount(), run.run().getAssistantChars(), mode, List.of());
    }

    private ArrayNode capabilitySnapshot() {
        ArrayNode caps = objectMapper.createArrayNode();
        ObjectNode read = objectMapper.createObjectNode();
        read.put("actionClass", "read");
        caps.add(read);
        return caps;
    }

    // ------------------------------------------------------------------
    // Inbox assertions and barrier helpers
    // ------------------------------------------------------------------

    private int inboxCountForParent(UUID parentSessionId) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM inbox WHERE to_session_id = CAST(? AS UUID)",
                Integer.class, parentSessionId.toString());
    }

    private int inboxCountForRef(UUID childRunId) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM inbox WHERE ref = CAST(? AS UUID)",
                Integer.class, childRunId.toString());
    }

    private int totalSessionRows() {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM sessions", Integer.class);
    }

    private String payloadField(RunFixture fixture, String field) {
        return jdbcTemplate.queryForObject(
                "SELECT payload_pointer->>'" + field + "' FROM inbox WHERE ref = CAST(? AS UUID)",
                String.class, fixture.run().getId().toString());
    }

    private Set<String> payloadKeys(RunFixture fixture) {
        List<String> keys = jdbcTemplate.queryForList(
                "SELECT jsonb_object_keys(payload_pointer::jsonb) FROM inbox WHERE ref = CAST(? AS UUID)",
                String.class, fixture.run().getId().toString());
        return new LinkedHashSet<>(keys);
    }

    private String injectedRunId(RunFixture fixture) {
        return jdbcTemplate.queryForObject("SELECT injected_run_id::text FROM inbox WHERE ref = CAST(? AS UUID)",
                String.class, fixture.run().getId().toString());
    }

    /** Joins a barrier future inside a transactional lambda (checked exceptions wrapped). */
    private static <T> T join(Future<T> future) {
        try {
            return future.get(20, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("barrier future interrupted", e);
        } catch (ExecutionException | TimeoutException e) {
            throw new IllegalStateException("barrier future failed", e);
        }
    }

    private void awaitTerminalLockWait(UUID runId, int minimum) {
        Awaitility.await().atMost(Duration.ofSeconds(3)).pollInterval(Duration.ofMillis(25))
                .untilAsserted(() -> assertTrue(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM pg_stat_activity WHERE application_name = ? "
                                + "AND backend_type = 'client backend' AND state = 'active' "
                                + "AND wait_event_type = 'Lock'",
                        Integer.class, "xihe-terminal-" + runId) >= minimum,
                        "terminal transaction must be blocked on a row lock"));
    }

    private void awaitLockWaiters(int minimum) {
        Awaitility.await().atMost(Duration.ofSeconds(3)).pollInterval(Duration.ofMillis(25))
                .untilAsserted(() -> assertTrue(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' "
                                + "AND state = 'active' AND wait_event_type = 'Lock'",
                        Integer.class) >= minimum,
                        "expected at least " + minimum + " PostgreSQL lock waiters"));
    }

    /** Attaches a Logback appender to capture structured lifecycle diagnostics. */
    private static final class LogCapture implements AutoCloseable {
        private final ch.qos.logback.classic.Logger logger;
        private final ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();

        private LogCapture(Class<?> type) {
            this.logger = (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(type);
            appender.start();
            logger.addAppender(appender);
        }

        private boolean saw(String fragment) {
            for (Iterator<ch.qos.logback.classic.spi.ILoggingEvent> it = appender.list.iterator(); it.hasNext();) {
                if (it.next().getFormattedMessage().contains(fragment)) {
                    return true;
                }
            }
            return false;
        }

        @Override
        public void close() {
            logger.detachAppender(appender);
            appender.stop();
        }
    }

    private record RunFixture(Session session, ChatRun run, UUID operationId) {}

    private record SpawnFixture(RunFixture parent, UUID parentItemId,
                                RunFixture child, String childAssistantMessageId) {}
}
