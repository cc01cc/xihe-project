package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionBranchRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
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

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0410 T1.2/T1.4: BranchPathService anchor/cursor validation and the
 * fail-closed Event append derivation on real PostgreSQL.
 *
 * <p>Acceptance covered here: valid User/Assistant anchors resolve their
 * cursor; forged branch ids, cross-Session branches, cross-Workspace anchors,
 * unmappable cursors and active anchor Runs are rejected with explicit domain
 * errors; a forged branch id writes ZERO Event rows; {@code correlation_id}
 * double verification derives the branch or aborts the append; the fork copy
 * loop aborts when a copied correlation cannot resolve in the target Session;
 * a request-body {@code branch_id} override is rejected.
 */
class BranchPathServiceIntegrationTest extends AbstractIntegrationTest {

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
    private UserRepository userRepository;
    @Autowired
    private WorkspaceRepository workspaceRepository;
    @Autowired
    private JdbcTemplate jdbcTemplate;
    @org.springframework.beans.factory.annotation.Value("${cp.agent-api-token:dev-token-not-secure}")
    private String internalApiToken;

    private String userId;
    private String workspaceId;

    @BeforeEach
    void setUpUser() {
        String email = "branch-path-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "BranchPathTest");
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
    // valid anchors (spec §2 / round-13 cursor formula)
    // ------------------------------------------------------------------

    @Test
    void validUserAnchorResolvesPromptAdmittedCursor() {
        String sessionId = newSession("anchor-user");
        ChatRun run = newRun(sessionId, "succeeded");
        Message message = newMessage(sessionId, MessageRole.USER, run.getId().toString());
        long admittedSequence = eventStoreService.append(
                sessionId, workspaceId, userId, "prompt.admitted",
                Map.of("message", Map.of("role", "human", "content", "hi")),
                run.getId().toString()).getSequence();

        BranchPathService.AnchorResolution anchor = branchPathService.resolveAnchor(
                sessionId, workspaceId, message.getId().toString());

        assertEquals(rootBranchId(sessionId), anchor.branchId());
        assertEquals(run.getId().toString(), anchor.runId());
        assertEquals(message.getId().toString(), anchor.messageId());
        assertEquals(admittedSequence, anchor.cursor());
    }

    @Test
    void validAssistantAnchorUsesMaxCorrelatedSequence() {
        String sessionId = newSession("anchor-assistant");
        ChatRun run = newRun(sessionId, "succeeded");
        Message message = newMessage(sessionId, MessageRole.ASSISTANT, run.getId().toString());
        long toolSequence = eventStoreService.append(
                sessionId, workspaceId, userId, "tool.result",
                Map.of("result", "ok"), run.getId().toString()).getSequence();
        long respondedSequence = eventStoreService.append(
                sessionId, workspaceId, userId, "assistant.responded",
                Map.of("message", Map.of("role", "ai", "content", "done")),
                run.getId().toString()).getSequence();
        // A later Session/global event must not extend the Run cursor.
        eventStoreService.append(sessionId, workspaceId, userId, "context.source_changed",
                Map.of("status", "updated"), null);

        BranchPathService.AnchorResolution anchor = branchPathService.resolveAnchor(
                sessionId, workspaceId, message.getId().toString());

        assertTrue(respondedSequence > toolSequence);
        assertEquals(respondedSequence, anchor.cursor(),
                "cursor is the Run's max correlated sequence, ignoring later global events");
    }

    @Test
    void activeSessionRunDoesNotBlockEarlierTerminalAnchor() {
        String sessionId = newSession("anchor-active");
        ChatRun terminalRun = newRun(sessionId, "succeeded");
        Message terminalMessage = newMessage(sessionId, MessageRole.USER, terminalRun.getId().toString());
        eventStoreService.append(sessionId, workspaceId, userId, "prompt.admitted",
                Map.of("message", Map.of("role", "human", "content", "earlier")),
                terminalRun.getId().toString());

        ChatRun activeRun = newRun(sessionId, "running");
        Message activeMessage = newMessage(sessionId, MessageRole.USER, activeRun.getId().toString());

        // The Session holds an active Run, yet the earlier terminal anchor works.
        BranchPathService.AnchorResolution anchor = branchPathService.resolveAnchor(
                sessionId, workspaceId, terminalMessage.getId().toString());
        assertEquals(terminalRun.getId().toString(), anchor.runId());

        // The active Run itself is not an anchor (409, explicit code).
        CpApiException activeFailure = assertThrows(CpApiException.class,
                () -> branchPathService.resolveAnchor(
                        sessionId, workspaceId, activeMessage.getId().toString()));
        assertEquals("BRANCH_ANCHOR_RUN_ACTIVE", activeFailure.getCode());
        assertEquals(HttpStatus.CONFLICT, activeFailure.getStatus());
    }

    // ------------------------------------------------------------------
    // fail-closed rejections
    // ------------------------------------------------------------------

    @Test
    void unmappableCursorsAndLegacyMessagesFailClosed() {
        String sessionId = newSession("anchor-unmappable");

        // Legacy content without a Run cannot produce a cursor.
        Message runless = newMessage(sessionId, MessageRole.USER, null);
        CpApiException runlessFailure = assertThrows(CpApiException.class,
                () -> branchPathService.resolveAnchor(
                        sessionId, workspaceId, runless.getId().toString()));
        assertEquals("BRANCH_ANCHOR_UNAVAILABLE", runlessFailure.getCode());

        // Terminal Run without any correlated prompt.admitted event: no trusted
        // cursor exists — reject instead of guessing (spec §2, no wall-clock).
        ChatRun silentRun = newRun(sessionId, "succeeded");
        Message silentMessage = newMessage(sessionId, MessageRole.USER, silentRun.getId().toString());
        CpApiException cursorFailure = assertThrows(CpApiException.class,
                () -> branchPathService.resolveAnchor(
                        sessionId, workspaceId, silentMessage.getId().toString()));
        assertEquals("BRANCH_ANCHOR_UNAVAILABLE", cursorFailure.getCode());
        assertEquals(HttpStatus.CONFLICT, cursorFailure.getStatus());
    }

    @Test
    void crossWorkspaceAnchorFailsClosed() {
        String sessionId = newSession("anchor-workspace");
        ChatRun run = newRun(sessionId, "succeeded");
        Message message = newMessage(sessionId, MessageRole.USER, run.getId().toString());
        eventStoreService.append(sessionId, workspaceId, userId, "prompt.admitted",
                Map.of("message", Map.of("role", "human", "content", "hi")),
                run.getId().toString());

        CpApiException failure = assertThrows(CpApiException.class,
                () -> branchPathService.resolveAnchor(
                        sessionId, UUID.randomUUID().toString(), message.getId().toString()));
        assertEquals("SESSION_NOT_FOUND", failure.getCode(),
                "a foreign Workspace must not learn that the Session exists");
    }

    @Test
    void forgedAndCrossSessionBranchesFailClosedWithoutEventRows() {
        String sessionA = newSession("path-a");
        String sessionB = newSession("path-b");
        String rootB = rootBranchId(sessionB);
        long eventsBefore = eventCount(sessionA) + eventCount(sessionB);

        CpApiException forged = assertThrows(CpApiException.class,
                () -> branchPathService.resolvePath(sessionA, UUID.randomUUID().toString()));
        assertEquals("BRANCH_NOT_FOUND", forged.getCode());

        CpApiException malformed = assertThrows(CpApiException.class,
                () -> branchPathService.resolvePath(sessionA, "not-a-uuid"));
        assertEquals("BRANCH_NOT_FOUND", malformed.getCode());

        CpApiException crossSession = assertThrows(CpApiException.class,
                () -> branchPathService.resolvePath(sessionA, rootB));
        assertEquals("BRANCH_CROSS_SESSION", crossSession.getCode());

        // Valid path still resolves after the rejected attempts.
        assertEquals(rootBranchId(sessionA), branchPathService.resolvePath(sessionA, rootBranchId(sessionA)));

        assertEquals(eventsBefore, eventCount(sessionA) + eventCount(sessionB),
                "a forged branch id must not write any Event row");
    }

    // ------------------------------------------------------------------
    // T1.4 append derivation + fork guard + payload diff
    // ------------------------------------------------------------------

    @Test
    void appendDerivesBranchAndRejectsUnresolvableCorrelation() {
        String sessionId = newSession("append-derive");
        ChatRun run = newRun(sessionId, "running");
        String rootId = rootBranchId(sessionId);
        long before = eventCount(sessionId);

        var derived = eventStoreService.append(sessionId, workspaceId, userId, "prompt.admitted",
                Map.of("message", Map.of("role", "human", "content", "hi")),
                run.getId().toString());
        assertEquals(rootId, derived.getBranchId());
        assertEquals(run.getId().toString(), derived.getCorrelationId());

        // Unknown Run id: fail-closed, zero rows.
        CpApiException unknownRun = assertThrows(CpApiException.class,
                () -> eventStoreService.append(sessionId, workspaceId, userId, "assistant.responded",
                        Map.of("message", Map.of("role", "ai", "content", "x")),
                        UUID.randomUUID().toString()));
        assertEquals("RUN_NOT_FOUND", unknownRun.getCode());

        // Run of a different Session (cross-Session correlation): fail-closed.
        String otherSessionId = newSession("append-other");
        ChatRun otherRun = newRun(otherSessionId, "succeeded");
        CpApiException crossSessionRun = assertThrows(CpApiException.class,
                () -> eventStoreService.append(sessionId, workspaceId, userId, "assistant.responded",
                        Map.of("message", Map.of("role", "ai", "content", "x")),
                        otherRun.getId().toString()));
        assertEquals("RUN_NOT_FOUND", crossSessionRun.getCode());

        assertEquals(before + 1, eventCount(sessionId),
                "only the valid append may write a row; both rejected appends write zero rows");
        assertEquals(0, eventCount(otherSessionId));
    }

    @Test
    void forkAbortsWhenCopiedCorrelationCannotResolveInTargetSession() {
        String sourceSessionId = newSession("fork-source");
        String targetSessionId = newSession("fork-target");
        ChatRun sourceRun = newRun(sourceSessionId, "succeeded");
        eventStoreService.append(sourceSessionId, workspaceId, userId, "assistant.responded",
                Map.of("message", Map.of("role", "ai", "content", "done")),
                sourceRun.getId().toString());
        assertEquals(1, eventCount(sourceSessionId));

        CpApiException failure = assertThrows(CpApiException.class,
                () -> eventStoreService.fork(sourceSessionId, 100L, targetSessionId,
                        workspaceId, userId));
        assertEquals("RUN_NOT_FOUND", failure.getCode(),
                "a copied correlation must resolve inside the target Session or abort the fork");

        assertEquals(0, eventCount(targetSessionId),
                "an aborted fork must leave zero copied rows in the target Session");
        assertEquals(1, eventCount(sourceSessionId), "the source Session must stay untouched");
    }

    @Test
    void internalAppendRejectsRequestBodyBranchIdOverride() {
        String sessionId = newSession("append-body");
        long before = eventCount(sessionId);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set(HttpHeaders.AUTHORIZATION, "Bearer " + internalApiToken);
        Map<String, Object> body = new HashMap<>();
        body.put("type", "prompt.admitted");
        body.put("payload", Map.of("message", Map.of("role", "human", "content", "hi")));
        body.put("branch_id", UUID.randomUUID().toString());

        ResponseEntity<String> response = restTemplate.exchange(
                url("/internal/v1/context/" + sessionId + "/events"),
                HttpMethod.POST, new HttpEntity<>(body, headers), String.class);

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode(),
                "the request body must never choose the branch");
        assertEquals(before, eventCount(sessionId), "the rejected append writes zero rows");
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private String newSession(String title) {
        Session session = new Session(workspaceId, userId, title);
        session.setId(UUID.randomUUID());
        return sessionRepository.save(session).getId().toString();
    }

    private ChatRun newRun(String sessionId, String status) {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), sessionId, userId, workspaceId,
                "branch-path-" + UUID.randomUUID(), "a".repeat(64), "test-provider", "test-model",
                "none", status);
        return chatRunRepository.save(run);
    }

    private Message newMessage(String sessionId, MessageRole role, String runId) {
        Message message = new Message(sessionId, role, "content-" + UUID.randomUUID());
        message.setRunId(runId);
        return messageRepository.save(message);
    }

    private String rootBranchId(String sessionId) {
        String rootId = sessionBranchRepository.findBySessionIdAndParentBranchIdIsNull(sessionId)
                .map(branch -> branch.getId().toString())
                .orElse(null);
        assertNotNull(rootId, "every Session must expose exactly one root branch");
        return rootId;
    }

    private long eventCount(String sessionId) {
        Long count = jdbcTemplate.queryForObject(
                "select count(*) from context_events where session_id = ?::uuid",
                Long.class, sessionId);
        return count == null ? 0L : count;
    }
}
