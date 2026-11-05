package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.entity.UserQuestion;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0660 M5-B / T5.10: the three public question routes over real HTTP + real PostgreSQL.
 *
 * <p>The point of this class is the <b>visibility matrix</b>, not the happy path:</p>
 * <ul>
 *   <li>the list is the caller's own inbound questions ({@code addressee_user_id = caller}) and its
 *       {@code pendingCount} uses the same filter — never "all questions in sessions I can see";</li>
 *   <li>a single read additionally accepts the frozen session-visibility rule (invited enabled HUMAN
 *       participant) and returns the <b>same projection</b> without the answer right;</li>
 *   <li>everything else is one indistinguishable {@code 404 QUESTION_NOT_FOUND} — there is no 403
 *       branch, and a malformed id is a 404 too, never a 400;</li>
 *   <li>conflicts keep their frozen codes: {@code QUESTION_ALREADY_SETTLED} / {@code QUESTION_EXPIRED}.</li>
 * </ul>
 */
class UserQuestionControllerIntegrationTest extends AbstractIntegrationTest {

    /** Stand-in for the Agent's respond route: a 200 keeps the answer deliverable. */
    private static com.sun.net.httpserver.HttpServer agentServer;

    @DynamicPropertySource
    static void configureAgent(DynamicPropertyRegistry registry) {
        try {
            agentServer = com.sun.net.httpserver.HttpServer.create(new InetSocketAddress(0), 0);
            agentServer.createContext("/internal/v1/agent/user-question/respond", exchange -> {
                exchange.getRequestBody().readAllBytes();
                byte[] body = "{\"status\":\"accepted\"}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
                exchange.sendResponseHeaders(200, body.length);
                try (OutputStream output = exchange.getResponseBody()) {
                    output.write(body);
                }
            });
            agentServer.start();
        } catch (IOException e) {
            throw new ExceptionInInitializerError(e);
        }
        registry.add("cp.agent-base-url", () -> "http://localhost:" + agentServer.getAddress().getPort());
    }

    @AfterAll
    static void stopAgentServer() {
        if (agentServer != null) {
            agentServer.stop(0);
        }
    }

    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private UserQuestionService questionsService;
    @Autowired private SessionRepository sessions;
    @Autowired private ChatRunRepository runs;
    @Autowired private SessionParticipantRepository participants;
    @Autowired private JwtTokenProvider jwtTokenProvider;

    private String addresseeId;
    private String participantId;
    private String strangerId;
    private String workspaceId;
    private String addresseeToken;
    private String participantToken;
    private String strangerToken;

    @BeforeEach
    void fixture() {
        AuthResponse addressee = register("q-addressee");
        AuthResponse participant = register("q-participant");
        AuthResponse stranger = register("q-stranger");
        addresseeId = addressee.getUser().getId();
        participantId = participant.getUser().getId();
        strangerId = stranger.getUser().getId();
        workspaceId = workspaceFixture
                .createOwnedWorkspace("T510 ws " + UUID.randomUUID(), addresseeId).getId().toString();
        addresseeToken = token(addressee);
        participantToken = token(participant);
        strangerToken = token(stranger);
    }

    // ---------------------------------------------------------------------------------------
    // list: addressee-only, count and items share one filter
    // ---------------------------------------------------------------------------------------

    @Test
    void listReturnsOnlyMyInboundQuestionsWithAMatchingPendingCount() {
        String sessionId = newSession();
        UserQuestion first = ask(sessionId, addresseeId, null);
        UserQuestion second = ask(sessionId, addresseeId, null);
        ask(sessionId, participantId, null);

        Map<String, Object> body = listJson("/api/v1/user-questions", addresseeToken);

        assertEquals(2, ((List<?>) body.get("items")).size(),
                "only the caller's own inbound questions: " + body);
        assertEquals(2, ((Number) body.get("pendingCount")).intValue(),
                "the count uses the same filter as the items");
        assertTrue(readIds(body).containsAll(List.of(first.getId().toString(), second.getId().toString())));

        // After one answer the badge drops by exactly one — the count is derived, never stored.
        postJson("/api/v1/user-questions/" + first.getId() + "/answer",
                "{\"answer\":\"rebase onto develop\"}", addresseeToken);
        Map<String, Object> after = listJson("/api/v1/user-questions", addresseeToken);
        assertEquals(1, ((List<?>) after.get("items")).size());
        assertEquals(1, ((Number) after.get("pendingCount")).intValue());

        Map<String, Object> participantList = listJson("/api/v1/user-questions", participantToken);
        assertEquals(1, ((List<?>) participantList.get("items")).size(),
                "each addressee only ever sees their own inbox");
    }

    @Test
    void listRejectsAnyStateOtherThanPendingAndAnyLimitBelowOne() {
        assertEquals(HttpStatus.BAD_REQUEST, error("/api/v1/user-questions?state=answered",
                addresseeToken).getStatusCode());
        assertTrue(body("/api/v1/user-questions?state=answered", addresseeToken)
                .contains("INVALID_REQUEST"), "an unsupported filter must not be silently ignored");
        assertEquals(HttpStatus.BAD_REQUEST,
                error("/api/v1/user-questions?state=bogus", addresseeToken).getStatusCode());
        assertEquals(HttpStatus.BAD_REQUEST,
                error("/api/v1/user-questions?limit=0", addresseeToken).getStatusCode());
    }

    @Test
    void listClampsAnOversizedLimitInsteadOfRejectingIt() {
        String sessionId = newSession();
        ask(sessionId, addresseeId, null);

        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/user-questions?limit=1000"), HttpMethod.GET,
                new HttpEntity<>(headers(addresseeToken)), String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode(),
                "an oversized page is clamped, not a contract violation: " + response.getBody());
    }

    // ---------------------------------------------------------------------------------------
    // single read: addressee or session-visible reader; everybody else the uniform 404
    // ---------------------------------------------------------------------------------------

    @Test
    void singleReadAcceptsTheAddresseeAndASessionVisibleReaderOnly() {
        String sessionId = newSession();
        UserQuestion question = ask(sessionId, addresseeId, null);
        inviteHuman(sessionId, participantId);

        ResponseEntity<String> own = restTemplate.exchange(url("/api/v1/user-questions/" + question.getId()),
                HttpMethod.GET, new HttpEntity<>(headers(addresseeToken)), String.class);
        assertEquals(HttpStatus.OK, own.getStatusCode());
        assertTrue(own.getBody().contains("\"prompt\""), "the projection carries the question body");

        ResponseEntity<String> visible = restTemplate.exchange(
                url("/api/v1/user-questions/" + question.getId()), HttpMethod.GET,
                new HttpEntity<>(headers(participantToken)), String.class);
        assertEquals(HttpStatus.OK, visible.getStatusCode(),
                "an invited enabled HUMAN participant reads the projection: " + visible.getBody());
        assertTrue(visible.getBody().contains("\"state\":\"pending\""));
        assertEquals(own.getBody().replaceAll("\"", ""), visible.getBody().replaceAll("\"", ""),
                "same projection shape for both readers — the only difference is the answer right");

        assert404(question.getId().toString(), strangerToken);
        assert404(UUID.randomUUID().toString(), participantToken);
        // A malformed id is the same 404, never a 400: no "format vs missing" oracle.
        assert404("not-a-uuid", addresseeToken);
        // The same 404 for a session-visible reader trying to answer.
        assertEquals(HttpStatus.NOT_FOUND, postError("/api/v1/user-questions/" + question.getId()
                + "/answer", "{\"answer\":\"let me answer\"}", participantToken).getStatusCode());
    }

    // ---------------------------------------------------------------------------------------
    // answer: addressee only, settled projection back, frozen conflict codes
    // ---------------------------------------------------------------------------------------

    @Test
    void answerReturnsTheSettledProjectionAndKeepsTheFrozenConflictCodes() {
        String sessionId = newSession();
        UserQuestion question = ask(sessionId, addresseeId, null);

        ResponseEntity<String> answered = restTemplate.exchange(
                url("/api/v1/user-questions/" + question.getId() + "/answer"), HttpMethod.POST,
                new HttpEntity<>("{\"answer\":\"rebase onto develop\"}", jsonHeaders(addresseeToken)),
                String.class);

        assertEquals(HttpStatus.OK, answered.getStatusCode());
        assertTrue(answered.getBody().contains("\"state\":\"answered\""), answered.getBody());
        assertTrue(answered.getBody().contains("\"answer\":\"rebase onto develop\""));
        assertTrue(answered.getBody().contains("\"settledAt\":\""),
                "the response is the settled projection, not an empty body: " + answered.getBody());

        ResponseEntity<String> second = postError("/api/v1/user-questions/" + question.getId()
                + "/answer", "{\"answer\":\"again\"}", addresseeToken);
        assertEquals(HttpStatus.CONFLICT, second.getStatusCode());
        assertTrue(second.getBody().contains("QUESTION_ALREADY_SETTLED"), second.getBody());

        UserQuestion expired = ask(sessionId, addresseeId, Instant.now().minusSeconds(1));
        ResponseEntity<String> tooLate = postError("/api/v1/user-questions/" + expired.getId()
                + "/answer", "{\"answer\":\"too late\"}", addresseeToken);
        assertEquals(HttpStatus.CONFLICT, tooLate.getStatusCode());
        assertTrue(tooLate.getBody().contains("QUESTION_EXPIRED"), tooLate.getBody());

        ResponseEntity<String> blank = restTemplate.exchange(
                url("/api/v1/user-questions/" + question.getId() + "/answer"), HttpMethod.POST,
                new HttpEntity<>("{\"answer\":\"   \"}", jsonHeaders(strangerToken)), String.class);
        assertEquals(HttpStatus.NOT_FOUND, blank.getStatusCode(),
                "a blank body must not turn the stranger's refusal into a validation error");
    }

    @Test
    void answerByANonAddresseeIsTheSame404AndLeavesTheRowPending() {
        String sessionId = newSession();
        UserQuestion question = ask(sessionId, addresseeId, null);

        ResponseEntity<String> refused = postError("/api/v1/user-questions/" + question.getId()
                + "/answer", "{\"answer\":\"hijack\"}", strangerToken);

        assertEquals(HttpStatus.NOT_FOUND, refused.getStatusCode());
        assertTrue(refused.getBody().contains("QUESTION_NOT_FOUND"), refused.getBody());
        assertEquals(UserQuestion.STATE_PENDING, questionsService.stateOf(question.getId()).orElseThrow());
        assertNull(questionsService.findForAddressee(question.getId(), addresseeId).getAnswer());
    }

    // ---------------------------------------------------------------------------------------
    // fixtures / helpers
    // ---------------------------------------------------------------------------------------

    private void assert404(String id, String token) {
        ResponseEntity<String> refused = error("/api/v1/user-questions/" + id, token);
        assertEquals(HttpStatus.NOT_FOUND, refused.getStatusCode(),
                "expected the uniform 404 for id " + id);
        assertTrue(refused.getBody().contains("QUESTION_NOT_FOUND"), refused.getBody());
    }

    private String newSession() {
        Session session = new Session();
        session.setId(UUID.randomUUID());
        session.setWorkspaceId(workspaceId);
        session.setUserId(addresseeId);
        session.setTitle("T510 session");
        return sessions.saveAndFlush(session).getId().toString();
    }

    private UserQuestion ask(String sessionId, String addressee, Instant expiresAt) {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), sessionId, addressee, workspaceId,
                "idem-" + UUID.randomUUID(), "hash", "openai", "gpt-test", "workspace", "streaming");
        ChatRun saved = runs.saveAndFlush(run);
        return questionsService.recordPending(sessionId, saved.getId().toString(), addressee,
                workspaceId, "which branch should I rebase onto?", expiresAt, null);
    }

    private void inviteHuman(String sessionId, String humanUserId) {
        participants.saveAndFlush(new SessionParticipant(UUID.fromString(sessionId),
                SessionParticipant.KIND_HUMAN, UUID.fromString(humanUserId),
                SessionParticipant.ROLE_MEMBER, 20, SessionParticipant.WAKE_MENTION,
                SessionParticipant.RESPOND_WHEN_MENTIONED));
    }

    private AuthResponse register(String label) {
        String email = "p660t510" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        var response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest(email, TestDataFactory.PASSWORD, label), AuthResponse.class);
        assertEquals(201, response.getStatusCode().value(), "registration must succeed for " + email);
        assertNotNull(response.getBody());
        return response.getBody();
    }

    private String token(AuthResponse auth) {
        // Fresh registration ⇒ token_version 0; these routes are user-level (no workspace claim).
        return jwtTokenProvider.createAccessToken(auth.getUser().getId(),
                auth.getUser().getEmail(), 0);
    }

    private HttpHeaders headers(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private HttpHeaders jsonHeaders(String token) {
        HttpHeaders headers = headers(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    private ResponseEntity<String> error(String path, String token) {
        return restTemplate.exchange(url(path), HttpMethod.GET, new HttpEntity<>(headers(token)),
                String.class);
    }

    private String body(String path, String token) {
        return error(path, token).getBody();
    }

    private ResponseEntity<String> postError(String path, String json, String token) {
        return restTemplate.exchange(url(path), HttpMethod.POST,
                new HttpEntity<>(json, jsonHeaders(token)), String.class);
    }

    private ResponseEntity<String> postJson(String path, String json, String token) {
        return postError(path, json, token);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> listJson(String path, String token) {
        ResponseEntity<Map> response = restTemplate.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(headers(token)), Map.class);
        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertNotNull(response.getBody());
        return (Map<String, Object>) response.getBody();
    }

    private static List<String> readIds(Map<String, Object> body) {
        return ((List<Map<String, Object>>) body.get("items")).stream()
                .map(item -> String.valueOf(item.get("id")))
                .toList();
    }
}
