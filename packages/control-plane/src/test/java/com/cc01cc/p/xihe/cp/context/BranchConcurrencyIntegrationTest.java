package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.context.repository.ContextProjectionRepository;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionBranch;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionBranchRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0410 T3.1: PostgreSQL concurrency matrix for the branch data plane.
 *
 * <p>Every scenario runs real threads against the real PostgreSQL container
 * synchronized by {@link CyclicBarrier} and bounded {@code Future.get}
 * timeouts — no {@code Thread.sleep}, no fixed waits. Assertions cover:
 * unique contiguous Session sequence (no lost/duplicated rows), exactly one
 * root branch under concurrent first binding, a single three-key projection
 * row under concurrent snapshot upserts, and stable cursor reads while
 * writers append. No scenario may surface an unexpected (5xx-class) failure.
 */
class BranchConcurrencyIntegrationTest extends AbstractIntegrationTest {

    private static final int THREADS = 6;
    private static final long TASK_TIMEOUT_SECONDS = 60;

    @Autowired
    private BranchPathService branchPathService;
    @Autowired
    private SessionRepository sessionRepository;
    @Autowired
    private SessionBranchRepository sessionBranchRepository;
    @Autowired
    private MessageRepository messageRepository;
    @Autowired
    private ChatRunRepository chatRunRepository;
    @Autowired
    private EventStoreService eventStoreService;
    @Autowired
    private ContextService contextService;
    @Autowired
    private ContextProjectionRepository projectionRepository;
    @Autowired
    private UserRepository userRepository;
    @Autowired
    private WorkspaceRepository workspaceRepository;
    @Autowired
    private JdbcTemplate jdbcTemplate;
    @Autowired
    private ObjectMapper objectMapper;
    @org.springframework.beans.factory.annotation.Value("${cp.agent-api-token:dev-token-not-secure}")
    private String internalApiToken;

    private String userId;
    private String workspaceId;

    @BeforeEach
    void setUpUser() {
        String email = "branch-cc-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "BranchCcTest");
        ResponseEntity<AuthResponse> regResponse = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        assertTrue(regResponse.getStatusCode().is2xxSuccessful(),
                "registration must succeed, got " + regResponse.getStatusCode());

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow().getId().toString();
    }

    // ------------------------------------------------------------------
    // T3.1 (a): concurrent appends — correlation derivation + sequence lock
    // ------------------------------------------------------------------

    @Test
    void concurrentAppendsSerializeSequenceAndDeriveBranches() throws Exception {
        String sessionId = newSession("cc-append");
        String rootId = rootBranchId(sessionId);

        // Anchor + two sibling branches so appends derive across three branches.
        ChatRun anchorRun = newChatRun(sessionId, rootId, "succeeded");
        Message anchorMessage = newMessage(sessionId, MessageRole.USER, anchorRun.getId().toString());
        long cursor = eventStoreService.append(sessionId, workspaceId, userId, "prompt.admitted",
                Map.of("message", Map.of("role", "human", "content", "anchor")),
                anchorRun.getId().toString()).getSequence();
        String branchA = newChildBranch(sessionId, rootId, anchorMessage, anchorRun, cursor, "cc-a");
        String branchB = newChildBranch(sessionId, rootId, anchorMessage, anchorRun, cursor, "cc-b");

        String runRootId = newChatRun(sessionId, rootId, "running").getId().toString();
        String runAId = newChatRun(sessionId, branchA, "running").getId().toString();
        String runBId = newChatRun(sessionId, branchB, "running").getId().toString();
        List<String> runIds = List.of(runRootId, runAId, runBId);
        Map<String, String> expectedBranch = Map.of(
                runRootId, rootId, runAId, branchA, runBId, branchB);

        int appendsPerThread = 3;
        AtomicInteger cursorIndex = new AtomicInteger();
        runConcurrently(THREADS, () -> {
            for (int i = 0; i < appendsPerThread; i++) {
                String runId = runIds.get(cursorIndex.getAndIncrement() % runIds.size());
                eventStoreService.append(sessionId, workspaceId, userId, "tool.result",
                        Map.of("result", "cc-marker-" + runId, "call_id", "cc"), runId);
            }
            return null;
        });

        int expectedRows = 1 + THREADS * appendsPerThread; // + the anchor prompt.admitted
        List<Long> sequences = jdbcTemplate.queryForList(
                "select sequence from context_events where session_id = ?::uuid order by sequence",
                Long.class, sessionId);
        assertEquals(expectedRows, sequences.size(), "every concurrent append must persist exactly one row");
        assertEquals(expectedRows, new HashSet<>(sequences).size(),
                "ContextEvent.sequence must stay unique under concurrency (no duplicate allocation)");
        for (int i = 0; i < sequences.size(); i++) {
            assertEquals(i + 1L, (long) sequences.get(i),
                    "sequence must remain contiguous — no lost row, no gap");
        }

        for (Map.Entry<String, String> entry : expectedBranch.entrySet()) {
            List<String> branches = jdbcTemplate.queryForList(
                    "select distinct branch_id::text from context_events "
                            + "where session_id = ?::uuid and correlation_id = ?",
                    String.class, sessionId, entry.getKey());
            assertEquals(List.of(entry.getValue()), branches,
                    "correlation_id=" + entry.getKey() + " must derive exactly its durable Run branch");
        }
    }

    // ------------------------------------------------------------------
    // T3.1 (b): concurrent first root binding
    // ------------------------------------------------------------------

    @Test
    void concurrentEnsureRootBranchConvergesOnExactlyOneRoot() throws Exception {
        String sessionId = newSession("cc-root");
        deleteRootBranch(sessionId);

        List<String> roots = runConcurrently(THREADS,
                () -> branchPathService.ensureRootBranchId(sessionId));

        Set<String> distinct = new HashSet<>(roots);
        assertEquals(1, distinct.size(), "all concurrent callers must resolve the same root id");
        assertEquals(1, countRoots(sessionId), "exactly one root row may exist after the race");
        String rootId = roots.get(0);
        assertEquals(rootId, branchPathService.resolvePath(sessionId, rootId),
                "the surviving root must still resolve to itself");
    }

    @Test
    void concurrentFirstMessageBindingConvergesOnSingleRootWithoutError() throws Exception {
        String sessionId = newSession("cc-bind");
        deleteRootBranch(sessionId);

        List<Message> saved = runConcurrently(THREADS, () -> {
            Message message = new Message(sessionId, MessageRole.USER,
                    "cc-binding-" + UUID.randomUUID());
            return messageRepository.save(message);
        });

        String rootId = rootBranchId(sessionId);
        assertEquals(1, countRoots(sessionId), "concurrent lazy binding must create one root only");
        for (Message message : saved) {
            assertEquals(rootId, message.getBranchId(),
                    "every lazily bound Message must carry the same durable root branch");
        }
        Long bound = jdbcTemplate.queryForObject(
                "select count(*) from messages where session_id = ?::uuid and branch_id = cast(? as uuid)",
                Long.class, sessionId, rootId);
        assertEquals((long) THREADS, bound, "all bound rows must persist with the single root branch");
    }

    // ------------------------------------------------------------------
    // T3.1 (c): concurrent three-key projection upsert (HTTP → no 5xx)
    // ------------------------------------------------------------------

    @Test
    void concurrentSnapshotRequestsShareOneProjectionRowWithoutServerError() throws Exception {
        String sessionId = newSession("cc-projection");
        String rootId = rootBranchId(sessionId);
        eventStoreService.append(sessionId, workspaceId, userId, "prompt.admitted",
                Map.of("message", Map.of("role", "human", "content", "cc-projection-prompt")),
                null, rootId);
        long eventsBefore = eventCount(sessionId);

        List<String> bodies = runConcurrently(THREADS, () -> {
            ResponseEntity<String> response = exchange(
                    "/internal/v1/context/" + sessionId + "/snapshot?branchId=" + rootId);
            assertEquals(HttpStatus.OK, response.getStatusCode(),
                    "concurrent snapshot reads must not surface a server error");
            return response.getBody();
        });

        Long rows = jdbcTemplate.queryForObject(
                "select count(*) from context_projections where session_id = ?::uuid",
                Long.class, sessionId);
        assertEquals(1L, rows, "the three-key upsert must converge on a single durable row");
        assertEquals(eventsBefore, eventCount(sessionId), "projection upserts must not write Event rows");

        for (String body : bodies) {
            assertNotNull(body, "every concurrent snapshot must return a payload");
            JsonNode payload = objectMapper.readTree(body);
            assertEquals(rootId, payload.path("branch_id").asText(),
                    "every concurrent snapshot must report the same durable branch");
            assertTrue(payload.toString().contains("cc-projection-prompt"),
                    "the shared projection row must keep the branch content");
        }
        var projection = projectionRepository
                .findBySessionIdAndProjectionTypeAndBranchId(sessionId, "agent_context", rootId);
        assertTrue(projection.isPresent(), "the durable row must be addressable by all three keys");
        assertTrue(projection.get().getPayload().contains("cc-projection-prompt"),
                "the stored payload must not be overwritten by an empty concurrent write");
    }

    // ------------------------------------------------------------------
    // T3.1 (d): concurrent cursor reads while writers append
    // ------------------------------------------------------------------

    @Test
    void concurrentCursorAndSequenceReadsStayStableWhileWritersAppend() throws Exception {
        String sessionId = newSession("cc-cursor");
        String rootId = rootBranchId(sessionId);

        ChatRun anchorRun = newChatRun(sessionId, rootId, "succeeded");
        Message anchorMessage = newMessage(sessionId, MessageRole.USER, anchorRun.getId().toString());
        long cursor = eventStoreService.append(sessionId, workspaceId, userId, "prompt.admitted",
                Map.of("message", Map.of("role", "human", "content", "cursor-anchor")),
                anchorRun.getId().toString()).getSequence();
        ChatRun activeRun = newChatRun(sessionId, rootId, "running");

        int writers = 4;
        int readers = 3;
        int appendsPerWriter = 4;
        ExecutorService pool = Executors.newFixedThreadPool(writers + readers);
        try {
            CyclicBarrier barrier = new CyclicBarrier(writers + readers);
            List<Future<?>> futures = new ArrayList<>();
            for (int w = 0; w < writers; w++) {
                final int writerIndex = w;
                futures.add(pool.submit(() -> {
                    barrier.await(TASK_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                    for (int i = 0; i < appendsPerWriter; i++) {
                        if ((writerIndex + i) % 2 == 0) {
                            eventStoreService.append(sessionId, workspaceId, userId,
                                    "context.env_updated",
                                    Map.of("branch", "main", "head", "h" + writerIndex + "-" + i,
                                            "is_repository", true));
                        } else {
                            eventStoreService.append(sessionId, workspaceId, userId,
                                    "assistant.responded",
                                    Map.of("message", Map.of("role", "ai", "content", "cc-reply")),
                                    activeRun.getId().toString());
                        }
                    }
                    return null;
                }));
            }
            for (int r = 0; r < readers; r++) {
                futures.add(pool.submit(() -> {
                    barrier.await(TASK_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                    long previous = -1;
                    for (int i = 0; i < 10; i++) {
                        Long latest = contextService.getLatestSequence(sessionId);
                        assertNotNull(latest, "cursor reads must answer while writers append");
                        assertTrue(latest >= previous, "sequence cursor reads must never move backwards");
                        previous = latest;

                        BranchPathService.AnchorResolution anchor = branchPathService.resolveAnchor(
                                sessionId, workspaceId, anchorMessage.getId().toString());
                        assertEquals(cursor, anchor.cursor(),
                                "a terminal Run cursor must stay stable under concurrent appends");
                    }
                    return null;
                }));
            }
            for (Future<?> future : futures) {
                future.get(TASK_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }

        assertEquals(1 + writers * appendsPerWriter, eventCount(sessionId),
                "every concurrent writer row must persist exactly once");
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private <T> List<T> runConcurrently(int threads, Callable<T> task) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            CyclicBarrier barrier = new CyclicBarrier(threads);
            List<Future<T>> futures = new ArrayList<>();
            for (int i = 0; i < threads; i++) {
                futures.add(pool.submit(() -> {
                    barrier.await(TASK_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                    return task.call();
                }));
            }
            List<T> results = new ArrayList<>();
            for (Future<T> future : futures) {
                results.add(future.get(TASK_TIMEOUT_SECONDS, TimeUnit.SECONDS));
            }
            return results;
        } finally {
            pool.shutdownNow();
        }
    }

    private String newSession(String title) {
        Session session = new Session(workspaceId, userId, title);
        session.setId(UUID.randomUUID());
        return sessionRepository.save(session).getId().toString();
    }

    private String rootBranchId(String sessionId) {
        String rootId = sessionBranchRepository.findBySessionIdAndParentBranchIdIsNull(sessionId)
                .map(branch -> branch.getId().toString())
                .orElse(null);
        assertNotNull(rootId, "every Session must expose exactly one root branch");
        return rootId;
    }

    private void deleteRootBranch(String sessionId) {
        jdbcTemplate.update(
                "delete from session_branches where session_id = ?::uuid and parent_branch_id is null",
                sessionId);
        assertEquals(0, countRoots(sessionId), "fixture must start without any root row");
    }

    private long countRoots(String sessionId) {
        Long count = jdbcTemplate.queryForObject(
                "select count(*) from session_branches "
                        + "where session_id = ?::uuid and parent_branch_id is null",
                Long.class, sessionId);
        return count == null ? 0L : count;
    }

    private ChatRun newChatRun(String sessionId, String branchId, String status) {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), sessionId, userId, workspaceId,
                "branch-cc-" + UUID.randomUUID(), "a".repeat(64), "test-provider", "test-model",
                "none", status);
        run.setBranchId(branchId);
        return chatRunRepository.save(run);
    }

    private Message newMessage(String sessionId, MessageRole role, String runId) {
        Message message = new Message(sessionId, role, "content-" + UUID.randomUUID());
        message.setRunId(runId);
        return messageRepository.save(message);
    }

    private String newChildBranch(String sessionId, String parentBranchId,
                                   Message anchorMessage, ChatRun anchorRun,
                                   long forkPointSequence, String idempotencyKey) {
        SessionBranch branch = new SessionBranch(UUID.randomUUID(), sessionId);
        branch.setParentBranchId(parentBranchId);
        branch.setForkPointMessageId(anchorMessage.getId().toString());
        branch.setForkPointRunId(anchorRun.getId().toString());
        branch.setForkPointSequence(forkPointSequence);
        branch.setIdempotencyKey(idempotencyKey);
        branch.setRequestHash("hash-" + idempotencyKey);
        return sessionBranchRepository.save(branch).getId().toString();
    }

    private ResponseEntity<String> exchange(String path) {
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.AUTHORIZATION, "Bearer " + internalApiToken);
        return restTemplate.exchange(url(path), HttpMethod.GET, new HttpEntity<>(headers), String.class);
    }

    private long eventCount(String sessionId) {
        Long count = jdbcTemplate.queryForObject(
                "select count(*) from context_events where session_id = ?::uuid",
                Long.class, sessionId);
        return count == null ? 0L : count;
    }
}
