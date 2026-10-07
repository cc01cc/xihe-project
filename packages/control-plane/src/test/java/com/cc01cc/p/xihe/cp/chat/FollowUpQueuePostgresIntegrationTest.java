package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionFollowUpItem;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.LedgerOperationRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionFollowUpItemRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.PayloadApplicationEvent;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Duration;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

// @Order(1) keeps the Agent circuit breaker cold for the pre-dispatch failure
// test: its child one dispatch must take the slow first-failure path so the
// immediately-following second admission deterministically finds the
// single-flight reservation still held.
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class FollowUpQueuePostgresIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private FollowUpQueueService queueService;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private SessionFollowUpItemRepository followUpItemRepository;

    @Autowired
    private MessageRepository messageRepository;

    @Autowired
    private LedgerOperationRepository ledgerOperationRepository;

    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;

    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private ChatSubmissionService chatSubmissionService;

    @Autowired
    private OperationService operationService;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private BranchPathService branchPathService;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private ConfigurableApplicationContext applicationContext;

    @Autowired
    private FileRepository fileRepository;

    @Test
    void concurrentEnqueuesSerializeSequenceAndCapacity() throws Exception {
        Fixture fixture = fixture();
        activeRun(fixture);
        String branchId = branchPathService.ensureRootBranchId(fixture.sessionId());
        int requests = 6;
        ExecutorService executor = Executors.newFixedThreadPool(requests);
        CountDownLatch ready = new CountDownLatch(requests);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<FollowUpQueueService.EnqueueResult>> futures = new ArrayList<>(requests);
        try {
            for (int i = 0; i < requests; i++) {
                int sequence = i;
                futures.add(executor.submit(() -> {
                    TenantContext.setUserId(fixture.userId());
                    TenantContext.setWorkspaceId(fixture.workspaceId());
                    ready.countDown();
                    try {
                        if (!start.await(10, TimeUnit.SECONDS)) {
                            throw new IllegalStateException("Concurrent enqueue start gate timed out");
                        }
                        return queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                                "concurrent-" + sequence, new FollowUpCreateRequest(
                                        "follow-up " + sequence, List.of(), branchId, "none", null, null, null));
                    } finally {
                        TenantContext.clear();
                    }
                }));
            }
            assertTrue(ready.await(10, TimeUnit.SECONDS), "all enqueue workers should reach the start gate");
            start.countDown();

            int accepted = 0;
            int full = 0;
            for (Future<FollowUpQueueService.EnqueueResult> future : futures) {
                try {
                    assertTrue(future.get(20, TimeUnit.SECONDS).snapshot().outstandingCount() <= 5);
                    accepted++;
                } catch (ExecutionException failure) {
                    if (failure.getCause() instanceof CpApiException apiError
                            && "FOLLOW_UP_QUEUE_FULL".equals(apiError.getCode())) {
                        full++;
                    } else {
                        throw failure;
                    }
                }
            }

            assertEquals(5, accepted);
            assertEquals(1, full);
            List<com.cc01cc.p.xihe.cp.entity.SessionFollowUpItem> rows = followUpItemRepository
                    .findBySessionIdAndStatusInOrderByQueueSequenceAsc(
                            fixture.sessionId(), SessionFollowUpItemRepository.OUTSTANDING_STATUSES);
            assertEquals(5, rows.size());
            assertEquals(List.of(1L, 2L, 3L, 4L, 5L), rows.stream()
                    .map(com.cc01cc.p.xihe.cp.entity.SessionFollowUpItem::getQueueSequence).toList());
        } finally {
            start.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void terminalQueueSettlementRollsBackWithTheParentRunTransaction() {
        Fixture fixture = fixture();
        String parentRunId = activeRun(fixture);
        String branchId = branchPathService.ensureRootBranchId(fixture.sessionId());
        TenantContext.setUserId(fixture.userId());
        TenantContext.setWorkspaceId(fixture.workspaceId());
        try {
            queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                    "terminal-rollback", new FollowUpCreateRequest(
                            "follow-up after parent", List.of(), branchId, "none", null, null, null));
        } finally {
            TenantContext.clear();
        }

        String runId = parentRunId;
        TransactionTemplate transaction = new TransactionTemplate(transactionManager);
        assertThrows(RollbackProbe.class, () -> transaction.executeWithoutResult(status -> {
            sessionRepository.findByIdForUpdate(UUID.fromString(fixture.sessionId())).orElseThrow();
            ChatRun parent = chatRunRepository.findByIdForUpdate(UUID.fromString(runId)).orElseThrow();
            parent.setStatus("succeeded");
            chatRunRepository.saveAndFlush(parent);
            queueService.settleTerminal(fixture.sessionId(), runId, "succeeded");
            throw new RollbackProbe();
        }));

        assertEquals("running", chatRunRepository.findById(UUID.fromString(parentRunId)).orElseThrow().getStatus());
        var item = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                fixture.sessionId(), "terminal-rollback").orElseThrow();
        assertEquals("queued", item.getStatus());
    }

    @Test
    void childAdmissionRollbackRemovesChatRunMessageAndOperationAndKeepsQueueItemQueued() {
        Fixture fixture = boundFixture();
        String parentRunId = activeRun(fixture);
        String branchId = branchPathService.ensureRootBranchId(fixture.sessionId());
        withTenant(fixture, () -> queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                "atomic-child-admission", new FollowUpCreateRequest(
                        "follow-up after parent", List.of(), branchId, "none", null, null, null)));

        ChatRun parent = chatRunRepository.findById(UUID.fromString(parentRunId)).orElseThrow();
        parent.setStatus("succeeded");
        chatRunRepository.saveAndFlush(parent);

        var queued = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                fixture.sessionId(), "atomic-child-admission").orElseThrow();
        String childRunId = UUID.randomUUID().toString();
        AtomicReference<UUID> childMessageId = new AtomicReference<>();
        AtomicReference<UUID> childOperationId = new AtomicReference<>();

        assertThrows(RollbackProbe.class, () -> queueService.admitHead(fixture.sessionId(), context -> {
            Session session = context.session();
            var item = context.item();
            ChatSubmissionService.Submission created = chatSubmissionService.createFollowUp(
                    childRunId, fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                    item.getBranchId().toString(), item.getIdempotencyKey(), "child-request-hash",
                    "test-provider", "test-model", item.getToolMode(),
                    session.getProviderConnectionId(), session.getConnectionRevision(),
                    "follow-up-test-lease", UUID.randomUUID().toString(), item.getContent(), "[]",
                    context.attachments().fileIds(), session.getAgentPrincipalId());
            childMessageId.set(created.userMessage().getId());
            childOperationId.set(operationService.findOperationIdByRunId(childRunId));

            assertTrue(chatRunRepository.findById(UUID.fromString(childRunId)).isPresent());
            assertTrue(messageRepository.findById(childMessageId.get()).isPresent());
            assertTrue(ledgerOperationRepository.findByRunId(childRunId).isPresent());
            throw new RollbackProbe();
        }));

        assertTrue(childMessageId.get() != null, "the real child admission callback must write a Message first");
        assertTrue(childOperationId.get() != null, "the real child admission callback must write an Operation first");
        assertTrue(chatRunRepository.findById(UUID.fromString(childRunId)).isEmpty());
        assertTrue(messageRepository.findById(childMessageId.get()).isEmpty());
        assertTrue(ledgerOperationRepository.findByRunId(childRunId).isEmpty());

        var afterRollback = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                fixture.sessionId(), "atomic-child-admission").orElseThrow();
        assertEquals(queued.getId(), afterRollback.getId());
        assertEquals("queued", afterRollback.getStatus());
        assertEquals("follow-up after parent", afterRollback.getContent());
        assertNull(afterRollback.getChildRunId());
        assertNull(afterRollback.getChildMessageId());
        assertNull(afterRollback.getAdmittedAt());
    }

    @Test
    void ordinaryChatSubmissionIsRejectedWhileFollowUpIsOutstanding() {
        Fixture fixture = boundFixture();
        String parentRunId = activeRun(fixture);
        String branchId = branchPathService.ensureRootBranchId(fixture.sessionId());
        String queueKey = "normal-chat-gate";
        withTenant(fixture, () -> queueService.enqueue(
                fixture.sessionId(), fixture.userId(), fixture.workspaceId(), queueKey,
                new FollowUpCreateRequest("queued before normal Chat", List.of(), branchId,
                        "none", null, null, null)));

        ChatRun parent = chatRunRepository.findById(UUID.fromString(parentRunId)).orElseThrow();
        parent.setStatus("succeeded");
        chatRunRepository.saveAndFlush(parent);

        Session session = sessionRepository.findById(UUID.fromString(fixture.sessionId())).orElseThrow();
        String rejectedRunId = UUID.randomUUID().toString();
        CpApiException error = assertThrows(CpApiException.class, () -> chatSubmissionService.create(
                rejectedRunId, fixture.sessionId(), fixture.userId(), fixture.workspaceId(), branchId,
                session.getAgentPrincipalId(), "normal-chat-idem", "normal-chat-hash",
                "test-provider", "test-model", "none", null, null, "normal-chat-lease",
                UUID.randomUUID().toString(), "ordinary message", "[]", List.of()));

        assertEquals("FOLLOW_UP_QUEUE_NOT_EMPTY", error.getCode());
        assertTrue(chatRunRepository.findById(UUID.fromString(rejectedRunId)).isEmpty());
        assertTrue(messageRepository.findBySessionIdOrderByCreatedAtAsc(fixture.sessionId()).isEmpty());
        assertTrue(ledgerOperationRepository.findByRunId(rejectedRunId).isEmpty());
        var queued = followUpItemRepository.findBySessionIdAndIdempotencyKey(fixture.sessionId(), queueKey)
                .orElseThrow();
        assertEquals("queued", queued.getStatus());
        assertEquals("queued before normal Chat", queued.getContent());
    }

    @Test
    void withdrawWinsWhenItHoldsTheSessionLockBeforeAdmission() throws Exception {
        RaceFixture race = raceFixture("withdraw-first");
        CountDownLatch withdrawHeld = new CountDownLatch(1);
        CountDownLatch releaseWithdraw = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        TransactionTemplate transaction = new TransactionTemplate(transactionManager);
        Future<?> holder = executor.submit(() -> {
            TenantContext.setUserId(race.fixture().userId());
            TenantContext.setWorkspaceId(race.fixture().workspaceId());
            try {
                return transaction.execute(status -> {
                    queueService.withdraw(race.fixture().sessionId(), race.fixture().userId(),
                            race.fixture().workspaceId(), race.itemId());
                    withdrawHeld.countDown();
                    awaitLatch(releaseWithdraw, "withdraw transaction release");
                    return null;
                });
            } finally {
                TenantContext.clear();
            }
        });
        try {
            assertTrue(withdrawHeld.await(5, TimeUnit.SECONDS));
            Future<FollowUpQueueService.AdmissionResult> admission = executor.submit(() ->
                    queueService.admitHead(race.fixture().sessionId(),
                            context -> childAdmission(race.fixture(), race.childRunId(), context)));
            awaitSessionLockWait();
            releaseWithdraw.countDown();
            holder.get(10, TimeUnit.SECONDS);

            FollowUpQueueService.AdmissionResult result = admission.get(20, TimeUnit.SECONDS);
            assertFalse(result.admitted(), "an item withdrawn before claim must not be admitted");
            var row = followUpItemRepository.findById(race.itemId()).orElseThrow();
            assertEquals("withdrawn", row.getStatus());
            assertNull(row.getChildRunId());
            assertNull(row.getChildMessageId());
            assertTrue(chatRunRepository.findById(race.childRunId()).isEmpty());
            assertTrue(messageRepository.findBySessionIdOrderByCreatedAtAsc(
                    race.fixture().sessionId()).isEmpty());
            assertTrue(ledgerOperationRepository.findByRunId(race.childRunId().toString()).isEmpty());
        } finally {
            releaseWithdraw.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void admissionWinsWhenItHoldsTheSessionLockBeforeWithdraw() throws Exception {
        RaceFixture race = raceFixture("admission-first");
        CountDownLatch admissionHeld = new CountDownLatch(1);
        CountDownLatch releaseAdmission = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        Future<FollowUpQueueService.AdmissionResult> admission = executor.submit(() ->
                queueService.admitHead(race.fixture().sessionId(), context -> {
                    admissionHeld.countDown();
                    awaitLatch(releaseAdmission, "admission transaction release");
                    return childAdmission(race.fixture(), race.childRunId(), context);
                }));
        Future<CpApiException> withdrawal = null;
        try {
            assertTrue(admissionHeld.await(5, TimeUnit.SECONDS));
            withdrawal = executor.submit(() -> {
                TenantContext.setUserId(race.fixture().userId());
                TenantContext.setWorkspaceId(race.fixture().workspaceId());
                try {
                    queueService.withdraw(race.fixture().sessionId(), race.fixture().userId(),
                            race.fixture().workspaceId(), race.itemId());
                    return null;
                } catch (CpApiException conflict) {
                    return conflict;
                } finally {
                    TenantContext.clear();
                }
            });
            awaitSessionLockWait();
            releaseAdmission.countDown();

            FollowUpQueueService.AdmissionResult winner = admission.get(20, TimeUnit.SECONDS);
            CpApiException conflict = withdrawal.get(20, TimeUnit.SECONDS);
            assertTrue(winner.admitted());
            assertNotNull(conflict, "withdraw must not succeed once the item is admitted");
            assertEquals("FOLLOW_UP_ALREADY_ADMITTED", conflict.getCode());
            // The admitted child's async dispatch always fails in CP tests, settling the
            // item to its deterministic terminal `completed`; assert that instead of
            // racing the transient `admitted` window.
            Awaitility.await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                    assertEquals(SessionFollowUpItem.STATUS_COMPLETED,
                            followUpItemRepository.findById(race.itemId()).orElseThrow().getStatus()));
            var row = followUpItemRepository.findById(race.itemId()).orElseThrow();
            assertEquals(race.childRunId(), row.getChildRunId());
            assertTrue(chatRunRepository.findById(race.childRunId()).isPresent());
            assertEquals(1, messageRepository.findBySessionIdOrderByCreatedAtAsc(
                    race.fixture().sessionId()).size());
            assertTrue(ledgerOperationRepository.findByRunId(race.childRunId().toString()).isPresent());
        } finally {
            releaseAdmission.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void startupRecoveryPausesAdmittedItemWithMissingChildAndItsTail() {
        Fixture fixture = fixture();
        String parentRunId = activeRun(fixture);
        String branchId = branchPathService.ensureRootBranchId(fixture.sessionId());
        withTenant(fixture, () -> {
            queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                    "restart-missing-child-1", new FollowUpCreateRequest(
                            "first restart item", List.of(), branchId, "none", null, null, null));
            queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                    "restart-missing-child-2", new FollowUpCreateRequest(
                            "second restart item", List.of(), branchId, "none", null, null, null));
        });

        ChatRun parent = chatRunRepository.findById(UUID.fromString(parentRunId)).orElseThrow();
        parent.setStatus("succeeded");
        chatRunRepository.saveAndFlush(parent);

        var head = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                fixture.sessionId(), "restart-missing-child-1").orElseThrow();
        ChatRun child = chatRunRepository.saveAndFlush(new ChatRun(
                UUID.randomUUID().toString(), fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                "restart-child-" + UUID.randomUUID(), "a".repeat(64),
                "test-provider", "test-model", "none", "running"));
        head.setStatus(SessionFollowUpItem.STATUS_ADMITTED);
        head.setChildRunId(child.getId());
        head.setAdmittedAt(Instant.now());
        followUpItemRepository.saveAndFlush(head);

        chatRunRepository.delete(child);
        chatRunRepository.flush();

        var missing = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                fixture.sessionId(), "restart-missing-child-1").orElseThrow();
        assertEquals(SessionFollowUpItem.STATUS_ADMITTED, missing.getStatus());
        assertNull(missing.getChildRunId());

        List<String> firstRunWakes = recoverAndCaptureWakes();

        List<SessionFollowUpItem> paused = followUpItemRepository
                .findBySessionIdAndStatusInOrderByQueueSequenceAsc(
                        fixture.sessionId(), SessionFollowUpItemRepository.OUTSTANDING_STATUSES);
        assertEquals(2, paused.size());
        assertEquals(SessionFollowUpItem.STATUS_PAUSED, paused.get(0).getStatus());
        assertEquals(SessionFollowUpItem.PAUSE_CHILD_MISSING, paused.get(0).getPauseReason());
        assertNull(paused.get(0).getPauseRunId());
        assertNull(paused.get(0).getChildRunId());
        assertEquals(SessionFollowUpItem.STATUS_PAUSED, paused.get(1).getStatus());
        assertEquals(SessionFollowUpItem.PAUSE_CHILD_MISSING, paused.get(1).getPauseReason());
        assertNull(paused.get(1).getChildRunId());
        assertFalse(firstRunWakes.contains(fixture.sessionId()));

        List<String> secondRunWakes = recoverAndCaptureWakes();
        List<SessionFollowUpItem> afterSecond = followUpItemRepository
                .findBySessionIdAndStatusInOrderByQueueSequenceAsc(
                        fixture.sessionId(), SessionFollowUpItemRepository.OUTSTANDING_STATUSES);
        assertEquals(2, afterSecond.size());
        assertTrue(afterSecond.stream().allMatch(item ->
                SessionFollowUpItem.STATUS_PAUSED.equals(item.getStatus())
                        && SessionFollowUpItem.PAUSE_CHILD_MISSING.equals(item.getPauseReason())));
        assertFalse(secondRunWakes.contains(fixture.sessionId()));
    }

    @Test
    void startupRecoveryPublishesWakeupForQueuedHeadSession() {
        Fixture fixture = fixture();
        activeRun(fixture);
        String branchId = branchPathService.ensureRootBranchId(fixture.sessionId());
        withTenant(fixture, () -> queueService.enqueue(fixture.sessionId(), fixture.userId(),
                fixture.workspaceId(), "restart-wakeup-1", new FollowUpCreateRequest(
                        "queued across restart", List.of(), branchId, "none", null, null, null)));

        List<String> woken = recoverAndCaptureWakes();

        assertTrue(woken.contains(fixture.sessionId()),
                "startup recovery must wake a session whose queue head is still queued");
        var row = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                fixture.sessionId(), "restart-wakeup-1").orElseThrow();
        assertEquals(SessionFollowUpItem.STATUS_QUEUED, row.getStatus());
        assertNull(row.getChildRunId());
        assertNull(row.getAdmittedAt());
    }

    @Test
    void foreignUserAndTenantMismatchCannotTouchAnotherSessionQueue() {
        Fixture owner = fixture();
        Fixture intruder = fixture();
        activeRun(owner);
        String branchId = branchPathService.ensureRootBranchId(owner.sessionId());
        withTenant(owner, () -> queueService.enqueue(owner.sessionId(), owner.userId(), owner.workspaceId(),
                "isolation-item", new FollowUpCreateRequest(
                        "owner only", List.of(), branchId, "none", null, null, null)));
        UUID ownedItem = followUpItemRepository.findBySessionIdAndIdempotencyKey(owner.sessionId(), "isolation-item")
                .orElseThrow().getId();

        withTenant(intruder, () -> {
            CpApiException enqueueError = assertThrows(CpApiException.class, () -> queueService.enqueue(
                    owner.sessionId(), intruder.userId(), intruder.workspaceId(), "intruder-enqueue",
                    new FollowUpCreateRequest("intruder", List.of(), branchId, "none", null, null, null)));
            assertEquals("SESSION_NOT_FOUND", enqueueError.getCode());
            CpApiException withdrawError = assertThrows(CpApiException.class, () -> queueService.withdraw(
                    owner.sessionId(), intruder.userId(), intruder.workspaceId(), ownedItem));
            assertEquals("SESSION_NOT_FOUND", withdrawError.getCode());
        });

        TenantContext.setUserId(owner.userId());
        TenantContext.setWorkspaceId(owner.workspaceId());
        try {
            CpApiException mismatchError = assertThrows(CpApiException.class, () -> queueService.enqueue(
                    owner.sessionId(), intruder.userId(), intruder.workspaceId(), "tenant-mismatch",
                    new FollowUpCreateRequest("mismatch", List.of(), branchId, "none", null, null, null)));
            assertEquals("SESSION_NOT_FOUND", mismatchError.getCode());
        } finally {
            TenantContext.clear();
        }

        var ownerRows = followUpItemRepository.findBySessionIdAndStatusInOrderByQueueSequenceAsc(
                owner.sessionId(), SessionFollowUpItemRepository.OUTSTANDING_STATUSES);
        assertEquals(1, ownerRows.size());
        assertEquals(SessionFollowUpItem.STATUS_QUEUED, ownerRows.get(0).getStatus());
        assertTrue(followUpItemRepository.findBySessionIdAndStatusInOrderByQueueSequenceAsc(
                intruder.sessionId(), SessionFollowUpItemRepository.OUTSTANDING_STATUSES).isEmpty());
    }

    @Test
    void sessionDeleteIntentRejectsQueueAndNormalChatMutations() {
        Fixture fixture = boundFixture();
        activeRun(fixture);
        String branchId = branchPathService.ensureRootBranchId(fixture.sessionId());
        withTenant(fixture, () -> queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                "deleting-item", new FollowUpCreateRequest(
                        "queued before delete intent", List.of(), branchId, "none", null, null, null)));
        UUID itemId = followUpItemRepository.findBySessionIdAndIdempotencyKey(fixture.sessionId(), "deleting-item")
                .orElseThrow().getId();

        Session session = sessionRepository.findById(UUID.fromString(fixture.sessionId())).orElseThrow();
        session.setDeleteRequestedAt(Instant.now());
        sessionRepository.saveAndFlush(session);

        withTenant(fixture, () -> {
            CpApiException enqueueError = assertThrows(CpApiException.class, () -> queueService.enqueue(
                    fixture.sessionId(), fixture.userId(), fixture.workspaceId(), "during-delete",
                    new FollowUpCreateRequest("blocked", List.of(), branchId, "none", null, null, null)));
            assertEquals("SESSION_DELETING", enqueueError.getCode());
            CpApiException withdrawError = assertThrows(CpApiException.class, () -> queueService.withdraw(
                    fixture.sessionId(), fixture.userId(), fixture.workspaceId(), itemId));
            assertEquals("SESSION_DELETING", withdrawError.getCode());
        });

        Session current = sessionRepository.findById(UUID.fromString(fixture.sessionId())).orElseThrow();
        String rejectedRunId = UUID.randomUUID().toString();
        CpApiException chatError = assertThrows(CpApiException.class, () -> chatSubmissionService.create(
                rejectedRunId, fixture.sessionId(), fixture.userId(), fixture.workspaceId(), branchId,
                current.getAgentPrincipalId(), "deleting-chat-idem", "deleting-chat-hash",
                "test-provider", "test-model", "none", null, null, "deleting-lease",
                UUID.randomUUID().toString(), "blocked message", "[]", List.of()));
        assertEquals("SESSION_DELETING", chatError.getCode());

        assertTrue(chatRunRepository.findById(UUID.fromString(rejectedRunId)).isEmpty());
        assertTrue(messageRepository.findBySessionIdOrderByCreatedAtAsc(fixture.sessionId()).isEmpty());
        var rows = followUpItemRepository.findBySessionIdAndStatusInOrderByQueueSequenceAsc(
                fixture.sessionId(), SessionFollowUpItemRepository.OUTSTANDING_STATUSES);
        assertEquals(1, rows.size());
        assertEquals(SessionFollowUpItem.STATUS_QUEUED, rows.get(0).getStatus());
    }

    @Test
    void fifoAdmitsSingleChildAndAdvancesNextAfterChildSucceeded() throws Exception {
        Fixture fixture = boundFixture();
        String parentRunId = activeRun(fixture);
        String branchId = branchPathService.ensureRootBranchId(fixture.sessionId());
        withTenant(fixture, () -> {
            queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                    "fifo-first", new FollowUpCreateRequest(
                            "first follow-up", List.of(), branchId, "none", null, null, null));
            queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                    "fifo-second", new FollowUpCreateRequest(
                            "second follow-up", List.of(), branchId, "none", null, null, null));
        });

        ChatRun parent = chatRunRepository.findById(UUID.fromString(parentRunId)).orElseThrow();
        parent.setStatus("failed");
        chatRunRepository.saveAndFlush(parent);

        List<String> woken = new ArrayList<>();
        try (AutoCloseable wakeCapture = captureWakesInto(woken)) {
            UUID childOneId = UUID.randomUUID();
            var first = queueService.admitHead(fixture.sessionId(),
                    context -> childAdmission(fixture, childOneId, context));
            assertTrue(first.admitted());
            assertEquals(childOneId, first.childRunId());
            var admitted = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                    fixture.sessionId(), "fifo-first").orElseThrow();
            assertEquals("first follow-up",
                    messageRepository.findById(admitted.getChildMessageId()).orElseThrow().getContent());
            assertNull(admitted.getContent());

            var blockedAttempt = queueService.admitHead(fixture.sessionId(),
                    context -> childAdmission(fixture, UUID.randomUUID(), context));
            assertFalse(blockedAttempt.admitted());
            assertEquals(2, runsFor(fixture));

            ChatRun childOne = chatRunRepository.findById(childOneId).orElseThrow();
            childOne.setStatus("succeeded");
            childOne.setLeaseOwner(null);
            childOne.setLeaseExpiresAt(null);
            chatRunRepository.saveAndFlush(childOne);
            queueService.settleTerminal(fixture.sessionId(), childOneId.toString(), "succeeded");

            var settled = followUpItemRepository.findBySessionIdAndStatusInOrderByQueueSequenceAsc(
                    fixture.sessionId(), SessionFollowUpItemRepository.OUTSTANDING_STATUSES);
            assertEquals(1, settled.size());
            assertEquals("second follow-up", settled.get(0).getContent());

            // Contract: releaseRun frees the local single-flight slot and only then
            // publishes the queue wake. Child one's async dispatch failure publishes it;
            // the wake listener may already have admitted the tail, so follow with one
            // explicit idempotent admission attempt once the reservation is provably free.
            Awaitility.await().atMost(Duration.ofSeconds(10))
                    .until(() -> woken.contains(fixture.sessionId()));
            queueService.admitHead(fixture.sessionId(),
                    context -> childAdmission(fixture, UUID.randomUUID(), context));

            // The tail's dispatch runs asynchronously and always fails in CP tests
            // (no reachable Agent), so its child Run converges terminal and the item
            // settles to `completed`. Assert that deterministic end state instead of
            // racing the transient `admitted` window (full-suite load reproduced the
            // race: expected <admitted> but was <completed>).
            Awaitility.await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
                var next = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                        fixture.sessionId(), "fifo-second").orElseThrow();
                assertEquals(SessionFollowUpItem.STATUS_COMPLETED, next.getStatus());
                assertNotNull(next.getChildRunId());
                assertNotEquals(childOneId, next.getChildRunId());
            });
            var next = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                    fixture.sessionId(), "fifo-second").orElseThrow();
            assertEquals("second follow-up",
                    messageRepository.findById(next.getChildMessageId()).orElseThrow().getContent());
            assertEquals(3, runsFor(fixture));

            var done = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                    fixture.sessionId(), "fifo-first").orElseThrow();
            assertEquals(SessionFollowUpItem.STATUS_COMPLETED, done.getStatus());
            assertNotNull(done.getCompletedAt());
        }
    }

    @Test
    void capacityCountsQueuedAdmittedAndPausedAndReleasesOnWithdrawAndCompletion() {
        Fixture fixture = boundFixture();
        String parentRunId = activeRun(fixture);
        String branchId = branchPathService.ensureRootBranchId(fixture.sessionId());
        for (int i = 1; i <= 5; i++) {
            int sequence = i;
            withTenant(fixture, () -> queueService.enqueue(fixture.sessionId(), fixture.userId(),
                    fixture.workspaceId(), "cap-" + sequence, new FollowUpCreateRequest(
                            "capacity " + sequence, List.of(), branchId, "none", null, null, null)));
        }
        CpApiException fullError = assertThrows(CpApiException.class, () -> withTenant(fixture,
                () -> queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                        "cap-6", new FollowUpCreateRequest(
                                "capacity 6", List.of(), branchId, "none", null, null, null))));
        assertEquals("FOLLOW_UP_QUEUE_FULL", fullError.getCode());
        assertEquals(5, snapshotAs(fixture).outstandingCount());
        assertEquals("queued", snapshotAs(fixture).queueState());

        ChatRun parent = chatRunRepository.findById(UUID.fromString(parentRunId)).orElseThrow();
        parent.setStatus("failed");
        chatRunRepository.saveAndFlush(parent);
        UUID childOneId = UUID.randomUUID();
        assertTrue(queueService.admitHead(fixture.sessionId(),
                context -> childAdmission(fixture, childOneId, context)).admitted());
        assertEquals(5, snapshotAs(fixture).outstandingCount());

        ChatRun childOne = chatRunRepository.findById(childOneId).orElseThrow();
        childOne.setStatus("succeeded");
        chatRunRepository.saveAndFlush(childOne);
        queueService.settleTerminal(fixture.sessionId(), childOneId.toString(), "succeeded");
        assertEquals(4, snapshotAs(fixture).outstandingCount());
        withTenant(fixture, () -> queueService.enqueue(fixture.sessionId(), fixture.userId(),
                fixture.workspaceId(), "cap-6", new FollowUpCreateRequest(
                        "capacity 6", List.of(), branchId, "none", null, null, null)));
        assertEquals(5, snapshotAs(fixture).outstandingCount());
        CpApiException fullAgain = assertThrows(CpApiException.class, () -> withTenant(fixture,
                () -> queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                        "cap-7", new FollowUpCreateRequest(
                                "capacity 7", List.of(), branchId, "none", null, null, null))));
        assertEquals("FOLLOW_UP_QUEUE_FULL", fullAgain.getCode());

        String pausedRunId = activeRun(fixture);
        ChatRun pausedRun = chatRunRepository.findById(UUID.fromString(pausedRunId)).orElseThrow();
        pausedRun.setStatus("cancelled");
        chatRunRepository.saveAndFlush(pausedRun);
        queueService.settleTerminal(fixture.sessionId(), pausedRunId, "cancelled");
        assertEquals(5, snapshotAs(fixture).outstandingCount());
        assertEquals("paused", snapshotAs(fixture).queueState());

        UUID withdrawable = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                fixture.sessionId(), "cap-3").orElseThrow().getId();
        withTenant(fixture, () -> queueService.withdraw(
                fixture.sessionId(), fixture.userId(), fixture.workspaceId(), withdrawable));
        assertEquals(4, snapshotAs(fixture).outstandingCount());
        withTenant(fixture, () -> queueService.enqueue(fixture.sessionId(), fixture.userId(),
                fixture.workspaceId(), "cap-7", new FollowUpCreateRequest(
                        "capacity 7", List.of(), branchId, "none", null, null, null)));
        assertEquals(5, snapshotAs(fixture).outstandingCount());
    }

    @Test
    void ambiguousChildTerminalizePausesQueueAndContinueOnlyAdvancesTail() throws Exception {
        Fixture fixture = boundFixture();
        String parentRunId = activeRun(fixture);
        String branchId = branchPathService.ensureRootBranchId(fixture.sessionId());
        withTenant(fixture, () -> {
            queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                    "ambiguous-first", new FollowUpCreateRequest(
                            "first follow-up", List.of(), branchId, "none", null, null, null));
            queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                    "ambiguous-second", new FollowUpCreateRequest(
                            "second follow-up", List.of(), branchId, "none", null, null, null));
        });
        ChatRun parent = chatRunRepository.findById(UUID.fromString(parentRunId)).orElseThrow();
        parent.setStatus("failed");
        chatRunRepository.saveAndFlush(parent);

        List<String> woken = new ArrayList<>();
        try (AutoCloseable wakeCapture = captureWakesInto(woken)) {
            UUID childOneId = UUID.randomUUID();
            assertTrue(queueService.admitHead(fixture.sessionId(),
                    context -> childAdmission(fixture, childOneId, context)).admitted());

            ChatRun childOne = chatRunRepository.findById(childOneId).orElseThrow();
            childOne.setStatus("ambiguous");
            childOne.setLeaseOwner(null);
            childOne.setLeaseExpiresAt(null);
            chatRunRepository.saveAndFlush(childOne);
            queueService.settleTerminal(fixture.sessionId(), childOneId.toString(), "ambiguous");

            assertEquals("ambiguous", chatRunRepository.findById(childOneId).orElseThrow().getStatus());
            var paused = followUpItemRepository.findBySessionIdAndStatusInOrderByQueueSequenceAsc(
                    fixture.sessionId(), SessionFollowUpItemRepository.OUTSTANDING_STATUSES);
            assertEquals(2, paused.size());
            for (SessionFollowUpItem item : paused) {
                assertEquals(SessionFollowUpItem.STATUS_PAUSED, item.getStatus());
                assertEquals(SessionFollowUpItem.PAUSE_CHILD_AMBIGUOUS, item.getPauseReason());
                assertEquals(childOneId, item.getPauseRunId());
            }

            // Wait for child one's dispatch reservation to be released (its async
            // failure publishes the wake only after freeing the single-flight slot);
            // otherwise the Continue wake cannot admit the tail.
            Awaitility.await().atMost(Duration.ofSeconds(10))
                    .until(() -> woken.contains(fixture.sessionId()));

            TenantContext.setUserId(fixture.userId());
            TenantContext.setWorkspaceId(fixture.workspaceId());
            try {
                queueService.continueQueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId());
            } finally {
                TenantContext.clear();
            }
            var consumed = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                    fixture.sessionId(), "ambiguous-first").orElseThrow();
            assertEquals(SessionFollowUpItem.STATUS_COMPLETED, consumed.getStatus());
            assertEquals(childOneId, consumed.getChildRunId());

            queueService.admitHead(fixture.sessionId(),
                    context -> childAdmission(fixture, UUID.randomUUID(), context));
            // Deterministic end state: the tail child's async dispatch always fails in
            // CP tests, settling this item to `completed`; do not race `admitted`.
            Awaitility.await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
                var tail = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                        fixture.sessionId(), "ambiguous-second").orElseThrow();
                assertEquals(SessionFollowUpItem.STATUS_COMPLETED, tail.getStatus());
                assertNotNull(tail.getChildRunId());
                assertNotEquals(childOneId, tail.getChildRunId());
            });
            assertEquals(3, runsFor(fixture));
            assertEquals("ambiguous", chatRunRepository.findById(childOneId).orElseThrow().getStatus());
            assertEquals(1, messageRepository.findBySessionIdOrderByCreatedAtAsc(fixture.sessionId()).stream()
                    .filter(message -> "first follow-up".equals(message.getContent())).count());
        }
    }

    @Test
    void staleAttachmentOwnershipFailsClosedAndPausesQueue() {
        Fixture fixture = boundFixture();
        User otherOwner = userRepository.saveAndFlush(new User(
                "stale-owner-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "Stale owner"));
        File file = new File(fixture.userId(), "stale.txt", "unused-test-path");
        file.setWorkspaceId(fixture.workspaceId());
        file.setSessionId(fixture.sessionId());
        file.setMimeType("text/plain");
        file.setSizeBytes(1L);
        File savedFile = fileRepository.saveAndFlush(file);

        String parentRunId = activeRun(fixture);
        String branchId = branchPathService.ensureRootBranchId(fixture.sessionId());
        withTenant(fixture, () -> queueService.enqueue(fixture.sessionId(), fixture.userId(),
                fixture.workspaceId(), "stale-attach", new FollowUpCreateRequest(
                        "with attachment", List.of(savedFile.getId().toString()),
                        branchId, "none", null, null, null)));
        ChatRun parent = chatRunRepository.findById(UUID.fromString(parentRunId)).orElseThrow();
        parent.setStatus("failed");
        chatRunRepository.saveAndFlush(parent);

        savedFile.setUserId(otherOwner.getId().toString());
        fileRepository.saveAndFlush(savedFile);

        UUID rejectedChildId = UUID.randomUUID();
        var result = queueService.admitHead(fixture.sessionId(),
                context -> childAdmission(fixture, rejectedChildId, context));
        assertFalse(result.admitted());
        assertEquals(SessionFollowUpItem.PAUSE_ATTACHMENT_UNAVAILABLE, result.blockedReason());
        var item = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                fixture.sessionId(), "stale-attach").orElseThrow();
        assertEquals(SessionFollowUpItem.STATUS_PAUSED, item.getStatus());
        assertEquals(SessionFollowUpItem.PAUSE_ATTACHMENT_UNAVAILABLE, item.getPauseReason());
        assertTrue(chatRunRepository.findById(rejectedChildId).isEmpty());
        assertEquals(1, runsFor(fixture));
        assertTrue(messageRepository.findBySessionIdOrderByCreatedAtAsc(fixture.sessionId()).isEmpty());
    }

    @Test
    void sessionDeletionCascadesQueueItemsRunsAndMessages() {
        Fixture fixture = boundFixture();
        String parentRunId = activeRun(fixture);
        String branchId = branchPathService.ensureRootBranchId(fixture.sessionId());
        withTenant(fixture, () -> {
            queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                    "delete-cascade-1", new FollowUpCreateRequest(
                            "first to delete", List.of(), branchId, "none", null, null, null));
            queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                    "delete-cascade-2", new FollowUpCreateRequest(
                            "second to delete", List.of(), branchId, "none", null, null, null));
        });
        assertTrue(runsFor(fixture) > 0);

        Session session = sessionRepository.findById(UUID.fromString(fixture.sessionId())).orElseThrow();
        sessionRepository.delete(session);
        sessionRepository.flush();

        assertTrue(sessionRepository.findById(UUID.fromString(fixture.sessionId())).isEmpty());
        assertTrue(followUpItemRepository.findBySessionIdAndStatusInOrderByQueueSequenceAsc(
                fixture.sessionId(), SessionFollowUpItemRepository.OUTSTANDING_STATUSES).isEmpty());
        assertEquals(0, runsFor(fixture));
        assertTrue(messageRepository.findBySessionIdOrderByCreatedAtAsc(fixture.sessionId()).isEmpty());
    }

    @Test
    @Order(1)
    void preDispatchFailureTerminalizesChildAmbiguouslyAndPausesQueue() {
        Fixture fixture = boundFixture();
        String parentRunId = activeRun(fixture);
        String branchId = branchPathService.ensureRootBranchId(fixture.sessionId());
        withTenant(fixture, () -> {
            queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                    "failure-first", new FollowUpCreateRequest(
                            "first follow-up", List.of(), branchId, "none", null, null, null));
            queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                    "failure-second", new FollowUpCreateRequest(
                            "second follow-up", List.of(), branchId, "none", null, null, null));
        });
        ChatRun parent = chatRunRepository.findById(UUID.fromString(parentRunId)).orElseThrow();
        parent.setStatus("failed");
        chatRunRepository.saveAndFlush(parent);

        UUID childOneId = UUID.randomUUID();
        assertTrue(queueService.admitHead(fixture.sessionId(),
                context -> childAdmission(fixture, childOneId, context)).admitted());
        ChatRun childOne = chatRunRepository.findById(childOneId).orElseThrow();
        childOne.setStatus("succeeded");
        childOne.setLeaseOwner(null);
        childOne.setLeaseExpiresAt(null);
        chatRunRepository.saveAndFlush(childOne);
        queueService.settleTerminal(fixture.sessionId(), childOneId.toString(), "succeeded");

        // Immediately admit the tail while child one's dispatch reservation is still
        // held: the ChildAdmitted listener takes the not-owned branch, which is the
        // contract's pre-dispatch Agent-unreachable path ("child commit后、Agent dispatch
        // 前→收敛 ambiguous、queue 暂停、不重放"). This test runs first (@Order(1)) so the
        // Agent circuit breaker is cold and child one's async failure cannot free the
        // slot inside this sub-millisecond window.
        UUID childTwoId = UUID.randomUUID();
        var second = queueService.admitHead(fixture.sessionId(),
                context -> childAdmission(fixture, childTwoId, context));
        assertTrue(second.admitted());

        ChatRun childTwo = chatRunRepository.findById(childTwoId).orElseThrow();
        assertEquals("ambiguous", childTwo.getStatus());
        assertEquals("FOLLOW_UP_DISPATCH_FAILED", childTwo.getErrorCode());
        var failedItem = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                fixture.sessionId(), "failure-second").orElseThrow();
        assertEquals(SessionFollowUpItem.STATUS_PAUSED, failedItem.getStatus());
        assertEquals(SessionFollowUpItem.PAUSE_CHILD_AMBIGUOUS, failedItem.getPauseReason());
        assertEquals(childTwoId, failedItem.getPauseRunId());
        assertEquals(childTwoId, failedItem.getChildRunId());
        assertEquals(3, runsFor(fixture));
        var consumed = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                fixture.sessionId(), "failure-first").orElseThrow();
        assertEquals(SessionFollowUpItem.STATUS_COMPLETED, consumed.getStatus());
    }

    @Test
    void stalePrincipalBindingFailsClosedAtAdmissionWithoutChild() {
        Fixture fixture = boundFixture();
        String parentRunId = activeRun(fixture);
        String branchId = branchPathService.ensureRootBranchId(fixture.sessionId());
        withTenant(fixture, () -> queueService.enqueue(fixture.sessionId(), fixture.userId(),
                fixture.workspaceId(), "stale-principal", new FollowUpCreateRequest(
                        "queued before the binding is revoked", List.of(),
                        branchId, "none", null, null, null)));
        ChatRun parent = chatRunRepository.findById(UUID.fromString(parentRunId)).orElseThrow();
        parent.setStatus("failed");
        chatRunRepository.saveAndFlush(parent);

        Session session = sessionRepository.findById(UUID.fromString(fixture.sessionId())).orElseThrow();
        session.setAgentPrincipalId(null);
        sessionRepository.saveAndFlush(session);

        UUID rejectedChildId = UUID.randomUUID();
        CpApiException error = assertThrows(CpApiException.class, () -> queueService.admitHead(
                fixture.sessionId(), context -> childAdmission(fixture, rejectedChildId, context)));
        assertEquals("FORBIDDEN", error.getCode());

        assertTrue(chatRunRepository.findById(rejectedChildId).isEmpty());
        assertEquals(1, runsFor(fixture));
        assertTrue(messageRepository.findBySessionIdOrderByCreatedAtAsc(fixture.sessionId()).isEmpty());
        var item = followUpItemRepository.findBySessionIdAndIdempotencyKey(
                fixture.sessionId(), "stale-principal").orElseThrow();
        assertEquals(SessionFollowUpItem.STATUS_QUEUED, item.getStatus());
        assertNull(item.getChildRunId());
        assertNull(item.getAdmittedAt());
    }

    @Test
    void cancelledParentPausesFifoAndContinueRollbackKeepsItPaused() {
        Fixture fixture = fixture();
        String parentRunId = activeRun(fixture);
        String branchId = branchPathService.ensureRootBranchId(fixture.sessionId());
        withTenant(fixture, () -> {
            queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                    "cancelled-tail-1", new FollowUpCreateRequest(
                            "first follow-up", List.of(), branchId, "none", null, null, null));
            queueService.enqueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                    "cancelled-tail-2", new FollowUpCreateRequest(
                            "second follow-up", List.of(), branchId, "none", null, null, null));
        });

        TransactionTemplate transaction = new TransactionTemplate(transactionManager);
        transaction.executeWithoutResult(status -> {
            sessionRepository.findByIdForUpdate(UUID.fromString(fixture.sessionId())).orElseThrow();
            ChatRun parent = chatRunRepository.findByIdForUpdate(UUID.fromString(parentRunId)).orElseThrow();
            parent.setStatus("cancelled");
            chatRunRepository.saveAndFlush(parent);
            queueService.settleTerminal(fixture.sessionId(), parentRunId, "cancelled");
        });

        List<com.cc01cc.p.xihe.cp.entity.SessionFollowUpItem> paused = followUpItemRepository
                .findBySessionIdAndStatusInOrderByQueueSequenceAsc(
                        fixture.sessionId(), SessionFollowUpItemRepository.OUTSTANDING_STATUSES);
        assertEquals(2, paused.size());
        assertTrue(paused.stream().allMatch((item) -> "paused".equals(item.getStatus())));
        assertTrue(paused.stream().allMatch((item) -> "parent_cancelled".equals(item.getPauseReason())));
        assertTrue(paused.stream().allMatch((item) -> parentRunId.equals(item.getPauseRunId().toString())));

        withTenant(fixture, () -> assertThrows(RollbackProbe.class,
                () -> transaction.executeWithoutResult(status -> {
                    queueService.continueQueue(fixture.sessionId(), fixture.userId(), fixture.workspaceId());
                    throw new RollbackProbe();
                })));

        List<com.cc01cc.p.xihe.cp.entity.SessionFollowUpItem> afterRollback = followUpItemRepository
                .findBySessionIdAndStatusInOrderByQueueSequenceAsc(
                        fixture.sessionId(), SessionFollowUpItemRepository.OUTSTANDING_STATUSES);
        assertEquals(2, afterRollback.size());
        assertTrue(afterRollback.stream().allMatch((item) -> "paused".equals(item.getStatus())));
    }

    private Fixture fixture() {
        User user = userRepository.saveAndFlush(new User(
                "follow-up-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "Follow-up test"));
        String userId = user.getId().toString();
        Workspace workspace = workspaceRepository.saveAndFlush(new Workspace(
                "Follow-up " + UUID.randomUUID(), userId));
        String workspaceId = workspace.getId().toString();
        Session session = new Session(workspaceId, userId, "Follow-up session");
        session.setId(UUID.randomUUID());
        Session persisted = sessionRepository.saveAndFlush(session);
        return new Fixture(userId, workspaceId, persisted.getId().toString());
    }

    private Fixture boundFixture() {
        User user = userRepository.saveAndFlush(new User(
                "follow-up-bound-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "Follow-up test"));
        String userId = user.getId().toString();
        Workspace workspace = workspaceRepository.saveAndFlush(new Workspace(
                "Follow-up " + UUID.randomUUID(), userId));
        String workspaceId = workspace.getId().toString();

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Follow-up admission principal");
        principal.setCreatedByUserId(userId);
        var principalSnapshot = objectMapper.createObjectNode();
        principalSnapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(principalSnapshot);
        principal = agentPrincipalRepository.saveAndFlush(principal);
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(
                principal.getId().toString(), workspaceId, objectMapper.createArrayNode()));
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));

        Session session = new Session(workspaceId, userId, "Follow-up session");
        session.setId(UUID.randomUUID());
        session.setAgentPrincipalId(principal.getId().toString());
        session.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        Session persisted = sessionRepository.saveAndFlush(session);
        return new Fixture(userId, workspaceId, persisted.getId().toString());
    }

    private String activeRun(Fixture fixture) {
        String runId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(runId, fixture.sessionId(), fixture.userId(),
                fixture.workspaceId(), "parent-" + UUID.randomUUID(), "a".repeat(64),
                "test-provider", "test-model", "none", "running"));
        return runId;
    }

    private static void withTenant(Fixture fixture, Runnable action) {
        TenantContext.setUserId(fixture.userId());
        TenantContext.setWorkspaceId(fixture.workspaceId());
        try {
            action.run();
        } finally {
            TenantContext.clear();
        }
    }

    private RaceFixture raceFixture(String suffix) {
        Fixture fixture = boundFixture();
        String parentRunId = activeRun(fixture);
        String branchId = branchPathService.ensureRootBranchId(fixture.sessionId());
        String queueKey = "race-" + suffix;
        withTenant(fixture, () -> queueService.enqueue(fixture.sessionId(), fixture.userId(),
                fixture.workspaceId(), queueKey, new FollowUpCreateRequest(
                        "race " + suffix, List.of(), branchId, "none", null, null, null)));
        ChatRun parent = chatRunRepository.findById(UUID.fromString(parentRunId)).orElseThrow();
        parent.setStatus("succeeded");
        chatRunRepository.saveAndFlush(parent);
        var row = followUpItemRepository.findBySessionIdAndIdempotencyKey(fixture.sessionId(), queueKey)
                .orElseThrow();
        return new RaceFixture(fixture, row.getId(), UUID.randomUUID());
    }

    private FollowUpQueueService.ChildAdmission childAdmission(Fixture fixture, UUID childRunId,
                                                               FollowUpQueueService.AdmissionContext context) {
        Session session = context.session();
        var item = context.item();
        ChatSubmissionService.Submission created = chatSubmissionService.createFollowUp(
                childRunId.toString(), fixture.sessionId(), fixture.userId(), fixture.workspaceId(),
                item.getBranchId().toString(), item.getIdempotencyKey(), "child-request-hash",
                "test-provider", "test-model", item.getToolMode(),
                session.getProviderConnectionId(), session.getConnectionRevision(),
                "follow-up-test-lease", UUID.randomUUID().toString(), item.getContent(), "[]",
                context.attachments().fileIds(), session.getAgentPrincipalId());
        return new FollowUpQueueService.ChildAdmission(
                created.run().getId(), created.userMessage().getId());
    }

    private void awaitSessionLockWait() {
        Awaitility.await().atMost(Duration.ofSeconds(3)).pollInterval(Duration.ofMillis(25))
                .untilAsserted(() -> assertTrue(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() "
                                + "AND state = 'active' AND wait_event_type = 'Lock' "
                                + "AND query ILIKE '%sessions%'",
                        Integer.class) > 0,
                        "the contender must be blocked on the Session row lock"));
    }

    private AutoCloseable captureWakesInto(List<String> woken) {
        ApplicationListener<ApplicationEvent> listener = event -> {
            if (event instanceof PayloadApplicationEvent<?> payload
                    && payload.getPayload() instanceof FollowUpQueueWakeupEvent wake) {
                woken.add(wake.sessionId());
            }
        };
        applicationContext.addApplicationListener(listener);
        return () -> applicationContext.removeApplicationListener(listener);
    }

    private List<String> recoverAndCaptureWakes() {
        List<String> woken = new ArrayList<>();
        try (AutoCloseable wakeCapture = captureWakesInto(woken)) {
            queueService.recoverQueueOnStartup(new ApplicationReadyEvent(
                    new SpringApplication(), new String[0], applicationContext, Duration.ZERO));
        } catch (Exception recoveryFailure) {
            throw new IllegalStateException("startup recovery raised an exception", recoveryFailure);
        }
        return woken;
    }

    private FollowUpQueueSnapshot snapshotAs(Fixture fixture) {
        TenantContext.setUserId(fixture.userId());
        TenantContext.setWorkspaceId(fixture.workspaceId());
        try {
            return queueService.snapshot(fixture.sessionId(), fixture.userId(), fixture.workspaceId());
        } finally {
            TenantContext.clear();
        }
    }

    private long runsFor(Fixture fixture) {
        return chatRunRepository.findAll().stream()
                .filter(run -> fixture.sessionId().equals(run.getSessionId()))
                .count();
    }

    private static void awaitLatch(CountDownLatch latch, String label) {
        try {
            if (!latch.await(10, TimeUnit.SECONDS)) {
                throw new IllegalStateException(label + " timed out");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(label + " was interrupted", interrupted);
        }
    }

    private record Fixture(String userId, String workspaceId, String sessionId) {}

    private record RaceFixture(Fixture fixture, UUID itemId, UUID childRunId) {}

    private static final class RollbackProbe extends RuntimeException {}
}
