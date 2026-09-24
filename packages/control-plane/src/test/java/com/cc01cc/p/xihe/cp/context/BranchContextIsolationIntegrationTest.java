package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
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
import com.cc01cc.p.xihe.cp.usage.UsageAggregator;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0410 T2.1–T2.4: branch-scoped projection / compaction / usage /
 * circuit / snapshot isolation on real PostgreSQL.
 *
 * <p>Two sibling branches (A/B) are constructed directly through
 * {@link SessionBranchRepository} + the anchor primitives of
 * {@link BranchPathService} (fork/public branch creation API belongs to
 * PLAN-0409 — this PLAN does not build it). Every isolation assertion runs in
 * BOTH directions: A's facts never appear on B's path and vice versa.
 */
class BranchContextIsolationIntegrationTest extends AbstractIntegrationTest {

    private static final String MARKER_A = "A-only-marker";
    private static final String MARKER_B = "B-only-marker";

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
    private UsageAggregator usageAggregator;
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
        String email = "branch-iso-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "BranchIsoTest");
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
    // T2.1/T2.3: per-branch projection + snapshot isolation (both ways)
    // ------------------------------------------------------------------

    @Test
    void siblingSnapshotsAndProjectionRowsIsolateInBothDirections() throws Exception {
        Fixture fx = newFixture("iso-projection");

        ObjectNode snapshotA = contextService.getSnapshot(
                fx.sessionId, workspaceId, userId, 0L, fx.branchA, null);
        ObjectNode snapshotB = contextService.getSnapshot(
                fx.sessionId, workspaceId, userId, 0L, fx.branchB, null);

        List<String> a = contents(snapshotA);
        List<String> b = contents(snapshotB);

        // A sees its own facts, never B's (messages, tool results, replies).
        assertTrue(contains(a, MARKER_A), "branch A snapshot must contain its own prompt");
        assertTrue(contains(a, "A-only-tool-result"), "branch A snapshot must contain its own tool result");
        assertFalse(contains(a, MARKER_B), "branch A must not see branch B messages");
        assertFalse(contains(a, "B-only-tool-result"), "branch A must not see branch B tool results");

        // Reverse direction.
        assertTrue(contains(b, MARKER_B), "branch B snapshot must contain its own prompt");
        assertTrue(contains(b, "B-only-tool-result"), "branch B snapshot must contain its own tool result");
        assertFalse(contains(b, MARKER_A), "branch B must not see branch A messages");
        assertFalse(contains(b, "A-only-tool-result"), "branch B must not see branch A tool results");

        // CP-given branch rides the snapshot payload (Agent-side T2.3 input).
        assertEquals(fx.branchA, snapshotA.get("branch_id").asText());
        assertEquals(fx.branchB, snapshotB.get("branch_id").asText());

        // Session/global facts stay visible on BOTH paths (frozen taxonomy §5).
        assertEquals("main", snapshotA.path("epoch").path("env_branch").asText());
        assertEquals("main", snapshotB.path("epoch").path("env_branch").asText());
        // Root-baseline (uncorrelated) content is shared baseline on both paths.
        assertTrue(contains(a, "root-baseline-message"));
        assertTrue(contains(b, "root-baseline-message"));

        // Cache key includes branchId: two distinct durable projection rows.
        JsonNode rowA = projectionRow(fx.sessionId, fx.branchA);
        JsonNode rowB = projectionRow(fx.sessionId, fx.branchB);
        assertNotNull(rowA, "branch A must own its projection row");
        assertNotNull(rowB, "branch B must own its projection row");
        assertFalse(rowA.toString().contains(MARKER_B),
                "the stored A projection payload must not contain B facts");
        assertFalse(rowB.toString().contains(MARKER_A),
                "the stored B projection payload must not contain A facts");
        Long rowCount = jdbcTemplate.queryForObject(
                "select count(*) from context_projections where session_id = ?::uuid",
                Long.class, fx.sessionId);
        assertEquals(2L, rowCount, "exactly one projection row per branch (3-key cache)");
    }

    // ------------------------------------------------------------------
    // T2.2: compaction summary on the same branch path (both ways)
    // ------------------------------------------------------------------

    @Test
    void compactionSummaryStaysOnItsOwnBranchInBothDirections() throws Exception {
        Fixture fx = newFixture("iso-compaction");

        contextService.compact(fx.sessionId, workspaceId, userId, null, "auto", fx.runAId, null);
        JsonNode compactionA = contextService.latestCompaction(fx.sessionId, fx.branchA);
        assertNotNull(compactionA, "compaction on run A must be visible on branch A");
        String summaryA = compactionA.path("summary").asText();
        assertTrue(summaryA.contains(MARKER_A), "A's summary must summarize A's history");
        assertFalse(summaryA.contains(MARKER_B), "A's summary must not contain B history");

        // B has no summary of its own yet — A's compaction never leaks.
        assertNull(contextService.latestCompaction(fx.sessionId, fx.branchB),
                "branch B must not inherit A's compaction summary");

        // B compacts its own history; both summaries stay distinct afterwards.
        contextService.compact(fx.sessionId, workspaceId, userId, null, "auto", fx.runBId, null);
        JsonNode compactionB = contextService.latestCompaction(fx.sessionId, fx.branchB);
        assertNotNull(compactionB, "compaction on run B must be visible on branch B");
        String summaryB = compactionB.path("summary").asText();
        assertTrue(summaryB.contains(MARKER_B), "B's summary must summarize B's history");
        assertFalse(summaryB.contains(MARKER_A), "B's summary must not contain A history");

        // Reverse: A's stored summary is still A's own after B compacted.
        compactionA = contextService.latestCompaction(fx.sessionId, fx.branchA);
        summaryA = compactionA.path("summary").asText();
        assertTrue(summaryA.contains(MARKER_A), "A's summary must survive B's compaction");
        assertFalse(summaryA.contains(MARKER_B), "A's summary must stay free of B history");

        // B's projection messages were NOT truncated by A's compaction.
        ObjectNode snapshotB = contextService.getSnapshot(
                fx.sessionId, workspaceId, userId, 0L, fx.branchB, null);
        assertTrue(contains(contents(snapshotB), MARKER_B),
                "B's own history survives its own keep-recent window");

        // Every compaction.applied row is branch-tagged (spec §3: never global).
        List<String> compactionBranches = jdbcTemplate.queryForList(
                "select branch_id::text from context_events "
                        + "where session_id = ?::uuid and event_type = 'compaction.applied' "
                        + "order by sequence",
                String.class, fx.sessionId);
        assertEquals(List.of(fx.branchA, fx.branchB), compactionBranches,
                "compaction.applied events must carry their Run's branch, never NULL");
    }

    // ------------------------------------------------------------------
    // T2.2: usage aggregation + recovery circuit on the same branch path
    // ------------------------------------------------------------------

    @Test
    void usageAggregationAndCircuitStayOnOwnBranchInBothDirections() throws Exception {
        Fixture fx = newFixture("iso-usage");

        // Sibling usage signals: A would trip the 70% token gate, B would not.
        eventStoreService.append(fx.sessionId, workspaceId, userId, "llm.usage", Map.of(
                "usage", Map.of("inputTokens", 100_000L, "windowTokens", 128_000L)), fx.runAId);
        eventStoreService.append(fx.sessionId, workspaceId, userId, "llm.usage", Map.of(
                "usage", Map.of("inputTokens", 100L, "windowTokens", 128_000L)), fx.runBId);

        assertEquals(100_000L, contextService.latestUsage(fx.sessionId, fx.branchA)
                .path("usage").path("inputTokens").asLong(), "A reads its own usage");
        assertEquals(100L, contextService.latestUsage(fx.sessionId, fx.branchB)
                .path("usage").path("inputTokens").asLong(), "B reads its own usage");

        assertEquals(100_000L, usageAggregator.aggregate(UUID.fromString(fx.sessionId), fx.branchA)
                .sumInputTokens(), "A's aggregate counts only A's usage");
        assertEquals(100L, usageAggregator.aggregate(UUID.fromString(fx.sessionId), fx.branchB)
                .sumInputTokens(), "B's aggregate counts only B's usage");

        // Circuit opened on A only.
        eventStoreService.append(fx.sessionId, workspaceId, userId, "context.compaction_circuit", Map.of(
                "state", "open",
                "reason", "recovery_band",
                "residualTokens", 111_000_000L), fx.runAId);

        JsonNode circuitA = contextService.latestOpenCircuit(fx.sessionId, fx.branchA);
        assertNotNull(circuitA, "A's own open circuit is visible on A");
        assertEquals(111_000_000L, circuitA.path("residualTokens").asLong());
        assertNull(contextService.latestOpenCircuit(fx.sessionId, fx.branchB),
                "A's circuit must not appear on B's path");

        // Volume gate on B (60 messages) fires — A's circuit cannot pause it.
        for (int i = 0; i < 60; i++) {
            eventStoreService.append(fx.sessionId, workspaceId, userId, "prompt.admitted", Map.of(
                    "message", Map.of("role", "human", "content", "B volume " + i)), fx.runBId);
        }
        assertTrue(contextService.shouldAutoCompact(fx.sessionId, fx.runBId),
                "A's open circuit must not block B's volume gate");
        assertFalse(contextService.shouldAutoCompact(fx.sessionId, fx.runAId),
                "A's own circuit must still block A's gate");

        // Reverse direction: B opens its own circuit — A's state unchanged.
        eventStoreService.append(fx.sessionId, workspaceId, userId, "context.compaction_circuit", Map.of(
                "state", "open",
                "reason", "recovery_band",
                "residualTokens", 222_000_000L), fx.runBId);
        JsonNode circuitB = contextService.latestOpenCircuit(fx.sessionId, fx.branchB);
        assertNotNull(circuitB);
        assertEquals(222_000_000L, circuitB.path("residualTokens").asLong(),
                "B sees its own circuit");
        JsonNode circuitAAfter = contextService.latestOpenCircuit(fx.sessionId, fx.branchA);
        assertEquals(111_000_000L, circuitAAfter.path("residualTokens").asLong(),
                "B's circuit must not replace A's circuit state");
    }

    // ------------------------------------------------------------------
    // T2.3 (spec §7): uncorrelated prompt.admitted is explicitly unanchorable
    // ------------------------------------------------------------------

    @Test
    void promptAdmittedWithoutRunCorrelationIsExplicitlyUnanchorable() {
        String sessionId = newSession("anchor-failclosed");

        // Legacy/pre-writer row: prompt.admitted WITHOUT correlation_id.
        ChatRun legacyRun = newChatRun(sessionId, rootBranchId(sessionId), "succeeded");
        Message legacyMessage = newMessage(sessionId, MessageRole.USER, legacyRun.getId().toString());
        eventStoreService.append(sessionId, workspaceId, userId, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", "legacy prompt")));

        CpApiException failure = assertThrows(CpApiException.class,
                () -> branchPathService.resolveAnchor(
                        sessionId, workspaceId, legacyMessage.getId().toString()));
        assertEquals("BRANCH_ANCHOR_UNAVAILABLE", failure.getCode(),
                "an uncorrelated prompt.admitted must be explicitly unanchorable, never a root guess");
        assertEquals(HttpStatus.CONFLICT, failure.getStatus());

        // Contrast: the V43 writer contract (correlation_id=runId) anchors.
        ChatRun wiredRun = newChatRun(sessionId, rootBranchId(sessionId), "succeeded");
        Message wiredMessage = newMessage(sessionId, MessageRole.USER, wiredRun.getId().toString());
        long admitted = eventStoreService.append(sessionId, workspaceId, userId, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", "wired prompt")),
                wiredRun.getId().toString()).getSequence();
        BranchPathService.AnchorResolution anchor =
                branchPathService.resolveAnchor(sessionId, workspaceId, wiredMessage.getId().toString());
        assertEquals(admitted, anchor.cursor());
    }

    // ------------------------------------------------------------------
    // T2.3: internal snapshot/compact API carries the branch selector
    // ------------------------------------------------------------------

    @Test
    void internalSnapshotApiResolvesAndValidatesBranchSelector() throws Exception {
        Fixture fx = newFixture("iso-http");

        // branchId selector (field-matrix §6): branch-filtered payload.
        ResponseEntity<String> byBranch = exchange(
                "/internal/v1/context/" + fx.sessionId + "/snapshot?branchId=" + fx.branchA);
        assertEquals(HttpStatus.OK, byBranch.getStatusCode());
        JsonNode payloadA = objectMapper.readTree(byBranch.getBody());
        assertEquals(fx.branchA, payloadA.path("branch_id").asText());
        assertTrue(payloadA.toString().contains(MARKER_A));
        assertFalse(payloadA.toString().contains(MARKER_B));

        // runId selector: CP derives the same branch from the durable run.
        ResponseEntity<String> byRun = exchange(
                "/internal/v1/context/" + fx.sessionId + "/snapshot?runId=" + fx.runBId);
        assertEquals(HttpStatus.OK, byRun.getStatusCode());
        JsonNode payloadB = objectMapper.readTree(byRun.getBody());
        assertEquals(fx.branchB, payloadB.path("branch_id").asText());
        assertTrue(payloadB.toString().contains(MARKER_B));
        assertFalse(payloadB.toString().contains(MARKER_A));

        // Both selectors must agree (409) — no silent precedence.
        ResponseEntity<String> mismatch = exchange(
                "/internal/v1/context/" + fx.sessionId + "/snapshot?branchId=" + fx.branchA
                        + "&runId=" + fx.runBId);
        assertEquals(HttpStatus.CONFLICT, mismatch.getStatusCode());

        // Unknown/foreign branch fails closed (404), never the root snapshot.
        ResponseEntity<String> forged = exchange(
                "/internal/v1/context/" + fx.sessionId + "/snapshot?branchId=" + UUID.randomUUID());
        assertEquals(HttpStatus.NOT_FOUND, forged.getStatusCode());
    }

    @Test
    void internalCompactApiWritesOnlyTheRequestedBranch() throws Exception {
        Fixture fx = newFixture("iso-http-compact");

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set(HttpHeaders.AUTHORIZATION, "Bearer " + internalApiToken);
        Map<String, Object> body = new HashMap<>();
        body.put("branchId", fx.branchB);

        ResponseEntity<String> response = restTemplate.exchange(
                url("/internal/v1/context/" + fx.sessionId + "/compact"),
                HttpMethod.POST, new HttpEntity<>(body, headers), String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode());

        assertNotNull(contextService.latestCompaction(fx.sessionId, fx.branchB),
                "manual compact with branchId writes on that branch");
        assertNull(contextService.latestCompaction(fx.sessionId, fx.branchA),
                "the sibling branch receives no summary");

        // A forged branchId is rejected without any event row.
        Map<String, Object> forgedBody = new HashMap<>();
        forgedBody.put("branchId", UUID.randomUUID().toString());
        long eventsBefore = eventCount(fx.sessionId);
        ResponseEntity<String> forged = restTemplate.exchange(
                url("/internal/v1/context/" + fx.sessionId + "/compact"),
                HttpMethod.POST, new HttpEntity<>(forgedBody, headers), String.class);
        assertEquals(HttpStatus.NOT_FOUND, forged.getStatusCode());
        assertEquals(eventsBefore, eventCount(fx.sessionId), "the rejected compact writes zero rows");
    }

    // ------------------------------------------------------------------
    // fixture: one Session, root baseline, sibling branches A and B
    // ------------------------------------------------------------------

    private final class Fixture {
        final String sessionId;
        final String branchA;
        final String branchB;
        final String runAId;
        final String runBId;

        Fixture(String sessionId, String branchA, String branchB, String runAId, String runBId) {
            this.sessionId = sessionId;
            this.branchA = branchA;
            this.branchB = branchB;
            this.runAId = runAId;
            this.runBId = runBId;
        }
    }

    private Fixture newFixture(String title) {
        String sessionId = newSession(title);
        String rootId = rootBranchId(sessionId);

        // Shared root baseline BEFORE the fork cursor — models a V43-backfilled
        // root row (branch=root, correlation NULL): visible on both children
        // only through the ancestor segment (sequence <= fork_point_sequence).
        eventStoreService.append(sessionId, workspaceId, userId, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", "root-baseline-message")), null, rootId);

        // Anchor on the root path: terminal run + USER message + the run's
        // unique prompt.admitted cursor (spec §2).
        ChatRun anchorRun = newChatRun(sessionId, rootId, "succeeded");
        Message anchorMessage = newMessage(sessionId, MessageRole.USER, anchorRun.getId().toString());
        long cursor = eventStoreService.append(sessionId, workspaceId, userId, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", "anchor prompt")),
                anchorRun.getId().toString()).getSequence();

        // Session/global fact (visible on every path per frozen taxonomy §5).
        eventStoreService.append(sessionId, workspaceId, userId, "context.env_updated", Map.of(
                "branch", "main", "head", "abc123", "is_repository", true));

        // Sibling branches from the same anchor (0409 fork API not built here).
        String branchA = newChildBranch(sessionId, rootId, anchorMessage, anchorRun, cursor, "sib-a");
        String branchB = newChildBranch(sessionId, rootId, anchorMessage, anchorRun, cursor, "sib-b");

        String runAId = newRunOnBranch(sessionId, branchA);
        String runBId = newRunOnBranch(sessionId, branchB);

        appendOnBranch(sessionId, runAId, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", MARKER_A)));
        appendOnBranch(sessionId, runAId, "tool.result", Map.of(
                "result", "A-only-tool-result", "call_id", "call-a"));
        appendOnBranch(sessionId, runAId, "assistant.responded", Map.of(
                "message", Map.of("role", "ai", "content", "A-only-reply")));

        appendOnBranch(sessionId, runBId, "prompt.admitted", Map.of(
                "message", Map.of("role", "human", "content", MARKER_B)));
        appendOnBranch(sessionId, runBId, "tool.result", Map.of(
                "result", "B-only-tool-result", "call_id", "call-b"));
        appendOnBranch(sessionId, runBId, "assistant.responded", Map.of(
                "message", Map.of("role", "ai", "content", "B-only-reply")));

        return new Fixture(sessionId, branchA, branchB, runAId, runBId);
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

    private ChatRun newChatRun(String sessionId, String branchId, String status) {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), sessionId, userId, workspaceId,
                "branch-iso-" + UUID.randomUUID(), "a".repeat(64), "test-provider", "test-model",
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

    private String newRunOnBranch(String sessionId, String branchId) {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), sessionId, userId, workspaceId,
                "branch-iso-" + UUID.randomUUID(), "b".repeat(64), "test-provider", "test-model",
                "none", "succeeded");
        run.setBranchId(branchId);
        return chatRunRepository.save(run).getId().toString();
    }

    private void appendOnBranch(String sessionId, String runId, String type, Map<String, Object> payload) {
        eventStoreService.append(sessionId, workspaceId, userId, type, payload, runId);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private ResponseEntity<String> exchange(String path) {
        HttpHeaders headers = new HttpHeaders();
        headers.set(HttpHeaders.AUTHORIZATION, "Bearer " + internalApiToken);
        return restTemplate.exchange(url(path), HttpMethod.GET, new HttpEntity<>(headers), String.class);
    }

    private static List<String> contents(ObjectNode snapshot) {
        List<String> out = new ArrayList<>();
        for (JsonNode message : snapshot.get("messages")) {
            out.add(message.path("content").asText(""));
        }
        return out;
    }

    private static boolean contains(List<String> values, String needle) {
        return values.stream().anyMatch(value -> value.contains(needle));
    }

    private JsonNode projectionRow(String sessionId, String branchId) throws Exception {
        return projectionRepository
                .findBySessionIdAndProjectionTypeAndBranchId(sessionId, "agent_context", branchId)
                .map(row -> {
                    try {
                        return objectMapper.readTree(row.getPayload());
                    } catch (Exception e) {
                        throw new IllegalStateException("projection payload is not JSON", e);
                    }
                })
                .orElse(null);
    }

    private long eventCount(String sessionId) {
        Long count = jdbcTemplate.queryForObject(
                "select count(*) from context_events where session_id = ?::uuid",
                Long.class, sessionId);
        return count == null ? 0L : count;
    }
}
