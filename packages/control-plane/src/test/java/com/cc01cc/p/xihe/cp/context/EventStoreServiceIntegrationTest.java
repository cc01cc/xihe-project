package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0346 (gap E): context_events sequence allocation runs under the session
 * row lock. These tests use the real PostgreSQL container (not H2) because the
 * behaviour under test is exactly the row-lock/unique-index interaction.
 */
class EventStoreServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private EventStoreService eventStoreService;

    @Autowired
    private com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository eventStoreRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String userId;
    private String workspaceId;
    private String sessionId;

    @BeforeEach
    void setUp() {
        String email = "evt-int-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "EventStoreIntTest");
        ResponseEntity<AuthResponse> regResponse = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        org.junit.jupiter.api.Assertions.assertTrue(regResponse.getStatusCode().is2xxSuccessful(),
                "registration must succeed, got " + regResponse.getStatusCode());

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow().getId().toString();

        Session session = new Session(workspaceId, userId, "Event Store Session");
        session.setId(UUID.randomUUID());
        sessionId = sessionRepository.save(session).getId().toString();
    }

    @Test
    void callerStableEventIdReplaysOriginalRowWithoutInserting() {
        String eventId = UUID.randomUUID().toString();
        var first = eventStoreService.append(sessionId, workspaceId, userId,
                "context.source_changed", java.util.Map.of("marker", "t21"),
                null, null, eventId);
        long countAfterFirst = eventStoreRepository.count();

        var replay = eventStoreService.append(sessionId, workspaceId, userId,
                "context.source_changed", java.util.Map.of("marker", "t21"),
                null, null, eventId);

        assertEquals(first.getId(), replay.getId());
        assertEquals(first.getSequence(), replay.getSequence());
        assertEquals(countAfterFirst, eventStoreRepository.count(),
                "an identical identity replay must not insert a new row");
    }

    @Test
    void callerStableEventIdWithDifferentContentConflictsWithoutInsert() {
        String eventId = UUID.randomUUID().toString();
        eventStoreService.append(sessionId, workspaceId, userId,
                "context.source_changed", java.util.Map.of("marker", "first"),
                null, null, eventId);
        long countAfterFirst = eventStoreRepository.count();

        CpApiException failure = assertThrows(CpApiException.class, () ->
                eventStoreService.append(sessionId, workspaceId, userId,
                        "context.source_changed", java.util.Map.of("marker", "second"),
                        null, null, eventId));

        assertEquals("EVENT_ID_CONFLICT", failure.getCode());
        assertEquals(countAfterFirst, eventStoreRepository.count(),
                "a conflicting identity must not insert a row");
    }

    @Test
    void appendBatchReusesStableIdentitiesAndAllocatesDenseSequences() {
        String reusedId = UUID.randomUUID().toString();
        var first = eventStoreService.appendBatch(sessionId, workspaceId, userId, java.util.List.of(
                new com.cc01cc.p.xihe.cp.context.service.EventStoreService.EventPayload(
                        reusedId, "context.source_changed", java.util.Map.of("marker", "batch-1"), null)));
        long countAfterFirst = eventStoreRepository.count();

        var second = eventStoreService.appendBatch(sessionId, workspaceId, userId, java.util.List.of(
                new com.cc01cc.p.xihe.cp.context.service.EventStoreService.EventPayload(
                        reusedId, "context.source_changed", java.util.Map.of("marker", "batch-1"), null),
                new com.cc01cc.p.xihe.cp.context.service.EventStoreService.EventPayload(
                        null, "context.env_updated", java.util.Map.of("marker", "batch-2"), null)));

        assertEquals(first.get(0).getSequence(), second.get(0).getSequence(),
                "the reused identity replays the original sequence");
        assertEquals(first.get(0).getSequence() + 1, second.get(1).getSequence(),
                "only new payloads consume the next sequence slot");
        assertEquals(countAfterFirst + 1, eventStoreRepository.count());
    }

    @Test
    void singleAndBatchWritesPersistOnlyWithheldToolOutputBodies() throws Exception {
        String canary = "event-store-write-canary-712c";
        var single = eventStoreService.append(sessionId, workspaceId, userId,
                "tool.result", Map.of("call_id", "single-call", "tool_name", "read_file", "result", canary));
        String singlePayload = jdbcTemplate.queryForObject(
                "select payload::text from context_events where id = ?::uuid", String.class, single.getId());
        assertFalse(singlePayload.contains(canary));
        assertTrue(singlePayload.contains("Tool result withheld from durable history"));

        String runId = UUID.randomUUID().toString();
        chatRunRepository.save(new ChatRun(runId, sessionId, userId, workspaceId,
                "event-store-safety-" + UUID.randomUUID(), "a".repeat(64), "fixture", "fixture", "none", "accepted"));
        List<EventStoreService.EventPayload> batch = List.of(
                new EventStoreService.EventPayload("tool.result",
                        Map.of("toolCallId", "batch-call", "toolName", "read_file", "result", canary), runId),
                new EventStoreService.EventPayload("assistant.responded",
                        Map.of("message", Map.of("role", "ai", "content", "done",
                                "apiTypeId", "openai-chat-completions", "apiTypeVersion", 1,
                                "nativeRecords", List.of(
                                        Map.of("role", "assistant", "content", "",
                                                "tool_calls", List.of(Map.of("id", "native-call", "type", "function",
                                                        "function", Map.of("name", "read_file", "arguments", "{}")))),
                                        Map.of("role", "tool", "tool_call_id", "native-call", "content", canary)))), runId));
        var saved = eventStoreService.appendBatch(sessionId, workspaceId, userId, batch);

        String batchToolPayload = storedPayload(saved.get(0).getId());
        assertFalse(batchToolPayload.contains(canary));
        assertTrue(batchToolPayload.contains("Tool result withheld from durable history"));

        String batchCarrierPayload = storedPayload(saved.get(1).getId());
        assertFalse(batchCarrierPayload.contains(canary));
        assertTrue(batchCarrierPayload.contains("Tool result withheld from durable history"));
        assertTrue(batchCarrierPayload.contains("native-call"));

        var prune = eventStoreService.append(sessionId, workspaceId, userId, "context.prune", Map.of(
                "runId", runId,
                "pruned_count", 1,
                "tombstones", List.of(Map.of("tool_call_id", "pruned-call", "sequence", 4,
                        "content_hash", "b".repeat(64), "size", 400, "head", canary,
                        "tail", canary, "reason", "oversized", "pruned", true))));
        String prunePayload = storedPayload(prune.getId());
        assertFalse(prunePayload.contains(canary));
        assertFalse(prunePayload.contains("head"));
        assertFalse(prunePayload.contains("tail"));
        assertTrue(prunePayload.contains("pruned-call"));

        var fork = eventStoreService.append(sessionId, workspaceId, userId, "session.forked", Map.of(
                "source_session_id", sessionId,
                "summary_seed", Map.of("contextEpoch", UUID.randomUUID().toString(),
                        "messages", List.of(Map.of("role", "tool", "tool_name", "read_file",
                                "content", canary, "artifact_ref", "artifact-" + canary)))));
        String forkPayload = storedPayload(fork.getId());
        assertFalse(forkPayload.contains(canary));
        assertTrue(forkPayload.contains("Tool result withheld from durable history"));
        assertFalse(forkPayload.contains("artifact_ref"));
    }

    @Test
    void forkDoesNotCopyLegacyRawToolResultRows() {
        String canary = "legacy-fork-copy-canary-2e9";
        ContextEvent legacy = new ContextEvent(sessionId, workspaceId, userId, "tool.result", 1L,
                "{\"toolName\":\"read_file\",\"result\":\"" + canary + "\"}");
        eventStoreRepository.save(legacy);

        Session child = new Session(workspaceId, userId, "Forked Event Store Session");
        child.setId(UUID.randomUUID());
        String childSessionId = sessionRepository.save(child).getId().toString();

        assertEquals(1L, eventStoreService.fork(sessionId, 1L, childSessionId, workspaceId, userId));

        ContextEvent copied = eventStoreRepository
                .findBySessionIdAndSequenceGreaterThanOrderBySequenceAsc(childSessionId, 0L).getFirst();
        assertFalse(copied.getPayload().contains(canary));
        assertTrue(copied.getPayload().contains("Tool result withheld from durable history"));
    }

    private String storedPayload(UUID eventId) {
        return jdbcTemplate.queryForObject(
                "select payload::text from context_events where id = ?::uuid", String.class, eventId);
    }

    @Test
    void concurrentAppendsToSameSessionAllocateDistinctSequences() throws Exception {
        // Four writers race append() on one session; the session row lock
        // serialises sequence allocation, so every event lands with a distinct
        // sequence (previously an INSERT could die on
        // uq_context_events_session_sequence and the event was lost).
        int writers = 4;
        var executor = Executors.newFixedThreadPool(writers);
        var latch = new CountDownLatch(1);
        List<Future<?>> futures = new ArrayList<>();
        for (int i = 0; i < writers; i++) {
            int writer = i;
            futures.add(executor.submit(() -> {
                latch.await();
                eventStoreService.append(sessionId, workspaceId, userId, "prompt.admitted",
                        Map.of("writer", writer));
                return null;
            }));
        }
        latch.countDown();
        for (Future<?> future : futures) {
            future.get(30, TimeUnit.SECONDS); // a lost race would surface here
        }
        executor.shutdown();

        Integer rows = jdbcTemplate.queryForObject(
                "select count(*) from context_events where session_id = ?::uuid",
                Integer.class, sessionId);
        assertEquals(writers, rows, "every concurrent append must persist");

        List<Long> sequences = jdbcTemplate.queryForList(
                "select sequence from context_events where session_id = ?::uuid order by sequence",
                Long.class, sessionId);
        assertEquals(List.of(1L, 2L, 3L, 4L), sequences, "sequences must be contiguous and unique");
    }
}
