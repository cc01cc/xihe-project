package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
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
import jakarta.persistence.EntityManager;
import jakarta.persistence.PersistenceContext;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0410 T3.2: error and security fail-closed matrix on real PostgreSQL.
 *
 * <p>Every error face named by tasks T3.2 and spec §7 is asserted with its
 * frozen status/code, and EVERY failure additionally proves zero side effects:
 * no {@code context_events} row, no {@code session_branches} row, no
 * {@code context_projections} row may appear because of a rejected call.
 * Codes that must not leak existence (unknown vs cross-Session/cross-Workspace)
 * are asserted equal.
 */
class BranchFailClosedMatrixIntegrationTest extends AbstractIntegrationTest {

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
    private UserRepository userRepository;
    @Autowired
    private WorkspaceRepository workspaceRepository;
    @Autowired
    private JdbcTemplate jdbcTemplate;
    @Autowired
    private PlatformTransactionManager transactionManager;
    @Autowired
    private ObjectMapper objectMapper;
    @PersistenceContext
    private EntityManager entityManager;
    @org.springframework.beans.factory.annotation.Value("${cp.agent-api-token:dev-token-not-secure}")
    private String internalApiToken;

    private String userId;
    private String workspaceId;

    @BeforeEach
    void setUpUser() {
        String email = "branch-fc-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "BranchFcTest");
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
    // (1) snapshot selectors: unknown / forged / cross-Session / mismatch
    // ------------------------------------------------------------------

    @Test
    void snapshotSelectorMatrixFailsClosedWithoutSideEffects() throws Exception {
        Fixture fx = newFixture("fc-snapshot");
        long eventsBefore = eventCount(fx.sessionId);
        long projectionsBefore = projectionCount(fx.sessionId);

        // Unknown + malformed branch → 404 BRANCH_NOT_FOUND (never a root fallback).
        assertProblem(getSnapshot(fx.sessionId, "?branchId=" + UUID.randomUUID()),
                HttpStatus.NOT_FOUND, "BRANCH_NOT_FOUND");
        assertProblem(getSnapshot(fx.sessionId, "?branchId=not-a-uuid"),
                HttpStatus.NOT_FOUND, "BRANCH_NOT_FOUND");

        // Branch of another Session → 404 BRANCH_CROSS_SESSION (existence only, no data).
        assertProblem(getSnapshot(fx.sessionId, "?branchId=" + fx.otherRootBranchId),
                HttpStatus.NOT_FOUND, "BRANCH_CROSS_SESSION");

        // Unknown Run vs cross-Session Run → the SAME code: no existence leak.
        JsonNode unknownRun = assertProblem(getSnapshot(fx.sessionId, "?runId=" + UUID.randomUUID()),
                HttpStatus.NOT_FOUND, "RUN_NOT_FOUND");
        JsonNode foreignRun = assertProblem(getSnapshot(fx.sessionId, "?runId=" + fx.otherRunId),
                HttpStatus.NOT_FOUND, "RUN_NOT_FOUND");
        assertEquals(code(unknownRun), code(foreignRun),
                "an unknown Run and another Session's Run must be indistinguishable");

        // branchId/runId disagreement → 409 BRANCH_RUN_MISMATCH (no silent precedence).
        assertProblem(getSnapshot(fx.sessionId, "?branchId=" + fx.branchA + "&runId=" + fx.rootRunId),
                HttpStatus.CONFLICT, "BRANCH_RUN_MISMATCH");

        // Unknown Session on the internal face → 403 FORBIDDEN, no Session detail.
        ResponseEntity<String> unknownSession = getSnapshot(
                UUID.randomUUID().toString(), "?branchId=" + UUID.randomUUID());
        assertEquals(HttpStatus.FORBIDDEN, unknownSession.getStatusCode());
        assertEquals("FORBIDDEN", code(objectMapper.readTree(unknownSession.getBody())));

        // Zero side effects for the whole matrix.
        assertEquals(eventsBefore, eventCount(fx.sessionId),
                "rejected snapshot selectors must not append Event rows");
        assertEquals(projectionsBefore, projectionCount(fx.sessionId),
                "rejected snapshot selectors must not create projection rows");
        assertEquals(2, countRootsAndChildren(fx.sessionId),
                "rejected snapshot selectors must not create branch rows");
    }

    // ------------------------------------------------------------------
    // (2) internal append: body injection + correlation fail-closed
    // ------------------------------------------------------------------

    @Test
    void internalAppendInjectionAndCorrelationMatrixFailsClosed() throws Exception {
        Fixture fx = newFixture("fc-append");
        long eventsBefore = eventCount(fx.sessionId);
        long otherEventsBefore = eventCount(fx.otherSessionId);

        // Body branch_id override → 400, zero rows.
        Map<String, Object> branchOverride = new HashMap<>();
        branchOverride.put("type", "prompt.admitted");
        branchOverride.put("payload", Map.of("message", Map.of("role", "human", "content", "x")));
        branchOverride.put("branch_id", UUID.randomUUID().toString());
        assertProblem(postEvent(fx.sessionId, branchOverride), HttpStatus.BAD_REQUEST, "INVALID_REQUEST");

        // session_id/workspace_id injection is never read: the row lands on the
        // addressed Session with THAT Session's Workspace.
        Map<String, Object> identityOverride = new HashMap<>();
        identityOverride.put("type", "context.env_updated");
        identityOverride.put("payload", Map.of("branch", "main", "head", "h", "is_repository", true));
        identityOverride.put("session_id", fx.otherSessionId);
        identityOverride.put("workspace_id", UUID.randomUUID().toString());
        ResponseEntity<String> injected = postEvent(fx.sessionId, identityOverride);
        assertEquals(HttpStatus.OK, injected.getStatusCode(),
                "un-read identity fields must not turn a valid append into an error");
        assertEquals(eventsBefore + 1, eventCount(fx.sessionId),
                "exactly the valid append may write a row");
        assertEquals(otherEventsBefore, eventCount(fx.otherSessionId),
                "the injected session_id must never receive the event");
        List<String> workspaces = jdbcTemplate.queryForList(
                "select distinct workspace_id::text from context_events where session_id = ?::uuid",
                String.class, fx.sessionId);
        assertEquals(List.of(workspaceId), workspaces,
                "the event must carry the addressed Session's Workspace, not the injected one");

        // Unknown correlation → 404 RUN_NOT_FOUND, zero rows.
        Map<String, Object> unknownCorrelation = new HashMap<>();
        unknownCorrelation.put("type", "assistant.responded");
        unknownCorrelation.put("payload", Map.of("message", Map.of("role", "ai", "content", "x")));
        unknownCorrelation.put("correlation_id", UUID.randomUUID().toString());
        assertProblem(postEvent(fx.sessionId, unknownCorrelation), HttpStatus.NOT_FOUND, "RUN_NOT_FOUND");

        // Cross-Session correlation → the SAME code, zero rows.
        Map<String, Object> foreignCorrelation = new HashMap<>();
        foreignCorrelation.put("type", "assistant.responded");
        foreignCorrelation.put("payload", Map.of("message", Map.of("role", "ai", "content", "x")));
        foreignCorrelation.put("correlation_id", fx.otherRunId);
        assertProblem(postEvent(fx.sessionId, foreignCorrelation), HttpStatus.NOT_FOUND, "RUN_NOT_FOUND");

        // Batch with one bad correlation → the WHOLE batch is rejected, zero rows.
        Map<String, Object> good = new HashMap<>();
        good.put("type", "prompt.admitted");
        good.put("payload", Map.of("message", Map.of("role", "human", "content", "batch-ok")));
        good.put("correlation_id", fx.rootRunId);
        Map<String, Object> bad = new HashMap<>();
        bad.put("type", "assistant.responded");
        bad.put("payload", Map.of("message", Map.of("role", "ai", "content", "batch-bad")));
        bad.put("correlation_id", UUID.randomUUID().toString());
        HttpHeaders headers = internalHeaders();
        ResponseEntity<String> batch = restTemplate.exchange(
                url("/internal/v1/context/" + fx.sessionId + "/events/batch"),
                HttpMethod.POST, new HttpEntity<>(List.of(good, bad), headers), String.class);
        assertEquals(HttpStatus.NOT_FOUND, batch.getStatusCode(),
                "one unresolvable correlation must abort the whole batch");
        assertEquals(eventsBefore + 1, eventCount(fx.sessionId),
                "only the single valid non-batch append may exist; the rejected batch writes zero rows");
    }

    // ------------------------------------------------------------------
    // (3) correlation vs explicit branch conflicts (service level)
    // ------------------------------------------------------------------

    @Test
    void correlationAndExplicitBranchConflictFailsClosed() {
        Fixture fx = newFixture("fc-conflict");
        long eventsBefore = eventCount(fx.sessionId);

        // correlation resolves branchA, caller demands root → 409, zero rows.
        CpApiException appendConflict = assertThrows(CpApiException.class,
                () -> eventStoreService.append(fx.sessionId, workspaceId, userId,
                        "assistant.responded",
                        Map.of("message", Map.of("role", "ai", "content", "x")),
                        fx.runAId, fx.rootBranchId));
        assertEquals("BRANCH_RUN_MISMATCH", appendConflict.getCode());
        assertEquals(HttpStatus.CONFLICT, appendConflict.getStatus());

        // Explicit branch of another Session without correlation → 404, zero rows.
        CpApiException crossSessionBranch = assertThrows(CpApiException.class,
                () -> eventStoreService.append(fx.sessionId, workspaceId, userId,
                        "prompt.admitted",
                        Map.of("message", Map.of("role", "human", "content", "x")),
                        null, fx.otherRootBranchId));
        assertEquals("BRANCH_CROSS_SESSION", crossSessionBranch.getCode());
        assertEquals(HttpStatus.NOT_FOUND, crossSessionBranch.getStatus());

        // Explicit unknown branch without correlation → 404, zero rows.
        CpApiException unknownBranch = assertThrows(CpApiException.class,
                () -> eventStoreService.append(fx.sessionId, workspaceId, userId,
                        "prompt.admitted",
                        Map.of("message", Map.of("role", "human", "content", "x")),
                        null, UUID.randomUUID().toString()));
        assertEquals("BRANCH_NOT_FOUND", unknownBranch.getCode());
        assertEquals(HttpStatus.NOT_FOUND, unknownBranch.getStatus());

        // Compaction scope conflict (run-derived vs requested branch) → 409,
        // no compaction/summary Event row may be written.
        CpApiException compactConflict = assertThrows(CpApiException.class,
                () -> contextService.compact(fx.sessionId, workspaceId, userId, null,
                        "auto", fx.runAId, fx.rootBranchId));
        assertEquals("BRANCH_RUN_MISMATCH", compactConflict.getCode());
        assertEquals(HttpStatus.CONFLICT, compactConflict.getStatus());

        assertEquals(eventsBefore, eventCount(fx.sessionId),
                "every conflicting selector must leave the EventStore untouched");
        assertEquals(0L, jdbcTemplate.queryForObject(
                "select count(*) from context_events where session_id = ?::uuid "
                        + "and event_type in ('compaction.applied','context.compaction_ineffective')",
                Long.class, fx.sessionId),
                "a rejected compaction must not write summary or diagnostic rows");
    }

    // ------------------------------------------------------------------
    // (4) anchor error faces (spec §2 / §7, 0409 hand-off contract)
    // ------------------------------------------------------------------

    @Test
    void anchorErrorMatrixFailsClosedWithoutSideEffects() {
        Fixture fx = newFixture("fc-anchor");
        long eventsBefore = eventCount(fx.sessionId);
        long branchesBefore = countRootsAndChildren(fx.sessionId);

        // Unknown Session and cross-Workspace Session → the SAME 404 code.
        CpApiException unknownSession = assertThrows(CpApiException.class,
                () -> branchPathService.resolveAnchor(
                        UUID.randomUUID().toString(), workspaceId, fx.anchorMessageId));
        CpApiException foreignWorkspace = assertThrows(CpApiException.class,
                () -> branchPathService.resolveAnchor(
                        fx.sessionId, UUID.randomUUID().toString(), fx.anchorMessageId));
        assertEquals("SESSION_NOT_FOUND", unknownSession.getCode());
        assertEquals("SESSION_NOT_FOUND", foreignWorkspace.getCode(),
                "a foreign Workspace must not learn that the Session exists");

        // Unknown anchor message and another Session's message → the SAME code.
        CpApiException unknownMessage = assertThrows(CpApiException.class,
                () -> branchPathService.resolveAnchor(
                        fx.sessionId, workspaceId, UUID.randomUUID().toString()));
        CpApiException foreignMessage = assertThrows(CpApiException.class,
                () -> branchPathService.resolveAnchor(
                        fx.sessionId, workspaceId, fx.otherMessageId));
        assertEquals("BRANCH_ANCHOR_NOT_FOUND", unknownMessage.getCode());
        assertEquals("BRANCH_ANCHOR_NOT_FOUND", foreignMessage.getCode(),
                "another Session's message must be indistinguishable from an unknown id");

        // Unsupported anchor role → 409.
        ChatRun systemRun = newChatRun(fx.sessionId, fx.rootBranchId, "succeeded");
        Message systemMessage = newMessage(fx.sessionId, MessageRole.SYSTEM,
                systemRun.getId().toString());
        CpApiException roleFailure = assertThrows(CpApiException.class,
                () -> branchPathService.resolveAnchor(
                        fx.sessionId, workspaceId, systemMessage.getId().toString()));
        assertEquals("BRANCH_ANCHOR_ROLE_UNSUPPORTED", roleFailure.getCode());
        assertEquals(HttpStatus.CONFLICT, roleFailure.getStatus());

        // Legacy runless message → 409 (no trusted cursor, never wall-clock).
        Message runless = newMessage(fx.sessionId, MessageRole.USER, null);
        CpApiException runlessFailure = assertThrows(CpApiException.class,
                () -> branchPathService.resolveAnchor(
                        fx.sessionId, workspaceId, runless.getId().toString()));
        assertEquals("BRANCH_ANCHOR_UNAVAILABLE", runlessFailure.getCode());

        // Active anchor Run → 409.
        ChatRun activeRun = newChatRun(fx.sessionId, fx.rootBranchId, "running");
        Message activeMessage = newMessage(fx.sessionId, MessageRole.USER,
                activeRun.getId().toString());
        CpApiException activeFailure = assertThrows(CpApiException.class,
                () -> branchPathService.resolveAnchor(
                        fx.sessionId, workspaceId, activeMessage.getId().toString()));
        assertEquals("BRANCH_ANCHOR_RUN_ACTIVE", activeFailure.getCode());
        assertEquals(HttpStatus.CONFLICT, activeFailure.getStatus());

        // prompt.admitted written WITHOUT correlation (spec §7) is unanchorable.
        ChatRun uncorrelatedRun = newChatRun(fx.sessionId, fx.rootBranchId, "succeeded");
        Message uncorrelatedMessage = newMessage(fx.sessionId, MessageRole.USER,
                uncorrelatedRun.getId().toString());
        eventStoreService.append(fx.sessionId, workspaceId, userId, "prompt.admitted",
                Map.of("message", Map.of("role", "human", "content", "legacy")));
        CpApiException uncorrelatedFailure = assertThrows(CpApiException.class,
                () -> branchPathService.resolveAnchor(
                        fx.sessionId, workspaceId, uncorrelatedMessage.getId().toString()));
        assertEquals("BRANCH_ANCHOR_UNAVAILABLE", uncorrelatedFailure.getCode());

        assertEquals(eventsBefore + 1, eventCount(fx.sessionId),
                "only the deliberately written legacy row may exist; failed anchors write nothing");
        assertEquals(branchesBefore, countRootsAndChildren(fx.sessionId),
                "failed anchor resolution must not create branch rows");
    }

    // ------------------------------------------------------------------
    // (5) cross-Session fork point rejected by the anchor composite FK
    // ------------------------------------------------------------------

    @Test
    void crossSessionForkPointIsRejectedByCompositeForeignKey() {
        Fixture fx = newFixture("fc-forkpoint");
        long branchesBefore = countRootsAndChildren(fx.sessionId);

        SessionBranch crossSessionForkPoint = new SessionBranch(UUID.randomUUID(), fx.sessionId);
        crossSessionForkPoint.setParentBranchId(fx.rootBranchId);
        crossSessionForkPoint.setForkPointMessageId(fx.otherMessageId);
        crossSessionForkPoint.setForkPointRunId(fx.otherRunId);
        crossSessionForkPoint.setForkPointSequence(1L);
        crossSessionForkPoint.setIdempotencyKey("fc-cross-session");
        crossSessionForkPoint.setRequestHash("hash-fc-cross-session");

        assertThrows(DataIntegrityViolationException.class,
                () -> sessionBranchRepository.saveAndFlush(crossSessionForkPoint),
                "the (session, message, run) composite FK must reject a foreign fork point");

        assertEquals(branchesBefore, countRootsAndChildren(fx.sessionId),
                "the rejected fork point must not leave a branch row");
    }

    // ------------------------------------------------------------------
    // (6) V3: injected mid-transaction failure → zero half-written rows
    // ------------------------------------------------------------------

    /**
     * PLAN-0410 V3: "any failure ⇒ zero partial writes".
     *
     * <p>The M1/M2 write path is replayed inside ONE explicit transaction and
     * aborted after every INSERT has physically landed — the in-transaction
     * counts prove the partial rows existed, so the clean post-state below can
     * only be explained by a real rollback. The failure must also reach the
     * caller: a swallowed exception would fake a pass. Every assertion after
     * the throw is read OUTSIDE the transaction.
     */
    @Test
    void injectedMidTransactionFailureLeavesZeroRowsBehind() {
        Fixture fx = newFixture("fc-rollback");

        long branchesTotalBefore = countAllRows("session_branches");
        long messagesTotalBefore = countAllRows("messages");
        long runsTotalBefore = countAllRows("chat_runs");
        long fixtureBranchesBefore = countRootsAndChildren(fx.sessionId);
        long fixtureMessagesBefore = countSessionRows("messages", fx.sessionId);
        long fixtureRunsBefore = countSessionRows("chat_runs", fx.sessionId);

        // Created INSIDE the aborted transaction: its root-branch bootstrap must
        // not survive either, so no orphan session_branches row may remain.
        UUID doomedSessionId = UUID.randomUUID();
        String marker = "rollback-" + UUID.randomUUID();

        TransactionTemplate transaction = new TransactionTemplate(transactionManager);
        RuntimeException injected = assertThrows(RuntimeException.class, () ->
                transaction.executeWithoutResult(status -> {
                    // M1 write path: Session row + root Branch bootstrap hook.
                    Session doomed = new Session(workspaceId, userId, "fc-rollback-doomed");
                    doomed.setId(doomedSessionId);
                    sessionRepository.saveAndFlush(doomed);
                    assertNotNull(rootBranchId(doomedSessionId.toString()),
                            "the Session must bootstrap its root Branch in this transaction");

                    // M2 write path: Message + ChatRun bound to the fixture root branch.
                    Message message = new Message(fx.sessionId, MessageRole.USER, marker);
                    message.setBranchId(fx.rootBranchId);
                    messageRepository.saveAndFlush(message);
                    ChatRun run = new ChatRun(UUID.randomUUID().toString(), fx.sessionId, userId,
                            workspaceId, "fc-rollback-" + UUID.randomUUID(), "a".repeat(64),
                            "test-provider", "test-model", "none", "running");
                    run.setBranchId(fx.rootBranchId);
                    chatRunRepository.saveAndFlush(run);

                    // Partial rows are physically present on THIS transaction's
                    // connection: an early abort cannot explain the clean state.
                    assertEquals(fixtureMessagesBefore + 1,
                            countSessionRows("messages", fx.sessionId),
                            "the Message INSERT must have landed before the failure");
                    assertEquals(fixtureRunsBefore + 1,
                            countSessionRows("chat_runs", fx.sessionId),
                            "the ChatRun INSERT must have landed before the failure");
                    assertEquals(branchesTotalBefore + 1, countAllRows("session_branches"),
                            "the doomed Session's root Branch must have landed before the failure");

                    throw new RuntimeException("V3 deliberate mid-transaction failure");
                }));
        assertEquals("V3 deliberate mid-transaction failure", injected.getMessage(),
                "the failure must propagate to the caller; a swallowed exception would fake a pass");

        // Reads OUTSIDE the transaction: zero half rows, zero orphan branches.
        assertEquals(branchesTotalBefore, countAllRows("session_branches"),
                "a rolled back write path must leave no session_branches row behind");
        assertEquals(messagesTotalBefore, countAllRows("messages"),
                "a rolled back write path must leave no messages row behind");
        assertEquals(runsTotalBefore, countAllRows("chat_runs"),
                "a rolled back write path must leave no chat_runs row behind");
        assertEquals(fixtureBranchesBefore, countRootsAndChildren(fx.sessionId),
                "the addressed Session must keep exactly its pre-transaction branches");
        assertEquals(fixtureMessagesBefore, countSessionRows("messages", fx.sessionId),
                "the addressed Session must keep exactly its pre-transaction messages");
        assertEquals(fixtureRunsBefore, countSessionRows("chat_runs", fx.sessionId),
                "the addressed Session must keep exactly its pre-transaction runs");
        assertEquals(0L, countSessionRows("sessions", doomedSessionId.toString(), "id"),
                "the doomed Session row itself must be rolled back");
        assertEquals(0L, countRootsAndChildren(doomedSessionId.toString()),
                "the doomed Session must not leave an orphan root branch");
        assertEquals(0L, countSessionRows("messages", doomedSessionId.toString()),
                "the doomed Session must not leave an orphan message");
        assertEquals(0L, countSessionRows("chat_runs", doomedSessionId.toString()),
                "the doomed Session must not leave an orphan run");
    }

    // ------------------------------------------------------------------
    // (7) V8: Run.branchId immutable after creation (ORM level)
    // ------------------------------------------------------------------

    /**
     * PLAN-0410 V8: "Run.branchId 创建后不可更新".
     *
     * <p>The mapping carries {@code updatable=false}, so the UPDATE generated
     * for a dirty run never contains the branch column. The probe targets a
     * NON-ANCHOR run: the composite {@code fk_session_branches_anchor_run}
     * only covers fork anchors, so before this mapping fix such a rewrite
     * committed successfully. The rewrite target is a legal same-Session
     * branch, i.e. {@code fk_chat_runs_session_branch} could not reject it
     * either — only the ORM mapping can keep the value.
     *
     * <p>The first-level cache is cleared before the reload so the assertion
     * reads the database, not the persistence context, and a genuinely
     * updatable column ({@code assistant_message_id}) is rewritten in the
     * same flush: without a sibling column that really persists, the branch
     * assertion could pass vacuously (no UPDATE issued at all).
     */
    @Test
    void runBranchIdIsImmutableAfterCreationWhileOtherColumnsStillUpdate() {
        Fixture fx = newFixture("fc-immutable");
        assertEquals(0L, anchorReferenceCount(fx.runAId),
                "the probe run must NOT be a fork anchor, otherwise "
                        + "fk_session_branches_anchor_run would mask the ORM-level gap");
        assertEquals(fx.branchA, branchIdInDb(fx.runAId),
                "precondition: the probe run starts bound to its own branch");

        String rewrittenAssistantMessageId = UUID.randomUUID().toString();

        TransactionTemplate transaction = new TransactionTemplate(transactionManager);
        transaction.executeWithoutResult(status -> {
            ChatRun run = chatRunRepository.findById(UUID.fromString(fx.runAId)).orElseThrow();
            String originalBranchId = run.getBranchId();
            assertEquals(fx.branchA, originalBranchId, "precondition on the managed entity");

            // Both targets are legal rows, so no constraint — only
            // updatable=false — can keep this rewrite out of chat_runs.
            run.setBranchId(fx.rootBranchId);
            run.setAssistantMessageId(rewrittenAssistantMessageId);
            chatRunRepository.saveAndFlush(run);

            // Drop the first-level cache: the reload below must hit the DB.
            entityManager.clear();

            ChatRun reloaded = chatRunRepository.findById(UUID.fromString(fx.runAId)).orElseThrow();
            assertEquals(originalBranchId, reloaded.getBranchId(),
                    "updatable=false must keep the persisted branch_id despite a flushed rewrite");
            assertEquals(rewrittenAssistantMessageId, reloaded.getAssistantMessageId(),
                    "an updatable column must still persist in the same UPDATE, otherwise "
                            + "the branch assertion above would be vacuously green");
        });

        assertEquals(fx.branchA, branchIdInDb(fx.runAId),
                "the chat_runs row itself must still carry the original branch_id");
        assertEquals(rewrittenAssistantMessageId, assistantMessageIdInDb(fx.runAId),
                "the sibling rewrite must be committed, proving the UPDATE really ran");
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private final class Fixture {
        final String sessionId;
        final String rootBranchId;
        final String rootRunId;
        final String runAId;
        final String branchA;
        final String anchorMessageId;
        final String otherSessionId;
        final String otherRootBranchId;
        final String otherRunId;
        final String otherMessageId;

        Fixture(String sessionId, String rootBranchId, String rootRunId, String runAId,
                String branchA, String anchorMessageId, String otherSessionId,
                String otherRootBranchId, String otherRunId, String otherMessageId) {
            this.sessionId = sessionId;
            this.rootBranchId = rootBranchId;
            this.rootRunId = rootRunId;
            this.runAId = runAId;
            this.branchA = branchA;
            this.anchorMessageId = anchorMessageId;
            this.otherSessionId = otherSessionId;
            this.otherRootBranchId = otherRootBranchId;
            this.otherRunId = otherRunId;
            this.otherMessageId = otherMessageId;
        }
    }

    /** One Session with a sibling branch + a second Session used as the foreign face. */
    private Fixture newFixture(String title) {
        String sessionId = newSession(title);
        String rootId = rootBranchId(sessionId);

        ChatRun rootRun = newChatRun(sessionId, rootId, "succeeded");
        Message anchorMessage = newMessage(sessionId, MessageRole.USER, rootRun.getId().toString());
        long cursor = eventStoreService.append(sessionId, workspaceId, userId, "prompt.admitted",
                Map.of("message", Map.of("role", "human", "content", "anchor")),
                rootRun.getId().toString()).getSequence();

        SessionBranch branch = new SessionBranch(UUID.randomUUID(), sessionId);
        branch.setParentBranchId(rootId);
        branch.setForkPointMessageId(anchorMessage.getId().toString());
        branch.setForkPointRunId(rootRun.getId().toString());
        branch.setForkPointSequence(cursor);
        branch.setIdempotencyKey("fc-" + title);
        branch.setRequestHash("hash-fc-" + title);
        String branchA = sessionBranchRepository.save(branch).getId().toString();
        String runAId = newChatRun(sessionId, branchA, "succeeded").getId().toString();

        String otherSessionId = newSession(title + "-other");
        String otherRootId = rootBranchId(otherSessionId);
        ChatRun otherRun = newChatRun(otherSessionId, otherRootId, "succeeded");
        Message otherMessage = newMessage(otherSessionId, MessageRole.USER,
                otherRun.getId().toString());

        return new Fixture(sessionId, rootId, rootRun.getId().toString(), runAId, branchA,
                anchorMessage.getId().toString(), otherSessionId, otherRootId,
                otherRun.getId().toString(), otherMessage.getId().toString());
    }

    private HttpHeaders internalHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set(HttpHeaders.AUTHORIZATION, "Bearer " + internalApiToken);
        return headers;
    }

    private ResponseEntity<String> getSnapshot(String sessionId, String query) {
        return restTemplate.exchange(
                url("/internal/v1/context/" + sessionId + "/snapshot" + query),
                HttpMethod.GET, new HttpEntity<>(internalHeaders()), String.class);
    }

    private ResponseEntity<String> postEvent(String sessionId, Map<String, Object> body) {
        return restTemplate.exchange(
                url("/internal/v1/context/" + sessionId + "/events"),
                HttpMethod.POST, new HttpEntity<>(body, internalHeaders()), String.class);
    }

    private JsonNode assertProblem(ResponseEntity<String> response,
                                   HttpStatus expectedStatus, String expectedCode) throws Exception {
        assertEquals(expectedStatus, response.getStatusCode(),
                "expected " + expectedStatus + " for the fail-closed face");
        JsonNode body = objectMapper.readTree(response.getBody());
        assertEquals(expectedCode, code(body),
                "the Problem Details code must be the frozen domain code");
        return body;
    }

    private static String code(JsonNode problem) {
        return problem.path("code").asText("");
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
                "branch-fc-" + UUID.randomUUID(), "a".repeat(64), "test-provider", "test-model",
                "none", status);
        run.setBranchId(branchId);
        return chatRunRepository.save(run);
    }

    private Message newMessage(String sessionId, MessageRole role, String runId) {
        Message message = new Message(sessionId, role, "content-" + UUID.randomUUID());
        message.setRunId(runId);
        return messageRepository.save(message);
    }

    private long eventCount(String sessionId) {
        Long count = jdbcTemplate.queryForObject(
                "select count(*) from context_events where session_id = ?::uuid",
                Long.class, sessionId);
        return count == null ? 0L : count;
    }

    private long projectionCount(String sessionId) {
        Long count = jdbcTemplate.queryForObject(
                "select count(*) from context_projections where session_id = ?::uuid",
                Long.class, sessionId);
        return count == null ? 0L : count;
    }

    private long countRootsAndChildren(String sessionId) {
        Long count = jdbcTemplate.queryForObject(
                "select count(*) from session_branches where session_id = ?::uuid",
                Long.class, sessionId);
        return count == null ? 0L : count;
    }

    private long countAllRows(String table) {
        Long count = jdbcTemplate.queryForObject("select count(*) from " + table, Long.class);
        return count == null ? 0L : count;
    }

    private long countSessionRows(String table, String sessionId) {
        return countSessionRows(table, sessionId, "session_id");
    }

    private long countSessionRows(String table, String id, String column) {
        Long count = jdbcTemplate.queryForObject(
                "select count(*) from " + table + " where " + column + " = ?::uuid",
                Long.class, id);
        return count == null ? 0L : count;
    }

    private long anchorReferenceCount(String runId) {
        Long count = jdbcTemplate.queryForObject(
                "select count(*) from session_branches where fork_point_run_id = ?::uuid",
                Long.class, runId);
        return count == null ? 0L : count;
    }

    private String branchIdInDb(String runId) {
        return jdbcTemplate.queryForObject(
                "select branch_id::text from chat_runs where id = ?::uuid", String.class, runId);
    }

    private String assistantMessageIdInDb(String runId) {
        return jdbcTemplate.queryForObject(
                "select assistant_message_id::text from chat_runs where id = ?::uuid",
                String.class, runId);
    }
}
