package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.UserQuestion;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserQuestionRepository;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0660 M5-B / T5.9: the question state machine against <b>real PostgreSQL</b>.
 *
 * <p>What a mock cannot prove and this class can:</p>
 * <ul>
 *   <li>two concurrent {@code answer} calls produce exactly one winner — the CAS is one conditional
 *       statement, not a read-then-write window;</li>
 *   <li>the deadline predicate inside that statement refuses an answer that arrives after
 *       {@code expires_at} (and the row is settled lazily to {@code expired});</li>
 *   <li>the run row lock makes the two-table "one pending human interaction" gate atomic against a
 *       real {@code approval_requests} row;</li>
 *   <li>terminal cleanup is idempotent and can never overwrite an {@code answered} row.</li>
 *   <li>a callback the Agent refuses leaves the question <b>pending</b> (T5.12 fail-closed: no
 *       fabricated {@code answered}, and a later retry can still deliver).</li>
 * </ul>
 */
class UserQuestionServiceIntegrationTest extends AbstractIntegrationTest {

    /** Local stand-in for the Agent's {@code /internal/v1/agent/user-question/respond} route. */
    private static com.sun.net.httpserver.HttpServer agentServer;
    private static final AtomicReference<Integer> AGENT_STATUS = new AtomicReference<>(200);
    private static final AtomicReference<String> AGENT_AUTH = new AtomicReference<>("");
    private static final AtomicReference<String> AGENT_BODY = new AtomicReference<>("");

    @DynamicPropertySource
    static void configureAgent(DynamicPropertyRegistry registry) {
        try {
            agentServer = com.sun.net.httpserver.HttpServer.create(new InetSocketAddress(0), 0);
            agentServer.createContext("/internal/v1/agent/user-question/respond", exchange -> {
                String auth = exchange.getRequestHeaders().getFirst("Authorization");
                AGENT_AUTH.set(auth == null ? "" : auth);
                AGENT_BODY.set(new String(exchange.getRequestBody().readAllBytes(),
                        StandardCharsets.UTF_8));
                byte[] body = "{\"status\":\"accepted\"}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
                exchange.sendResponseHeaders(AGENT_STATUS.get(), body.length);
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
    @Autowired private UserQuestionService service;
    @Autowired private UserQuestionRepository questions;
    @Autowired private ChatRunRepository runs;
    @Autowired private ChatApprovalRepository approvals;
    @Autowired private SessionRepository sessions;

    private String ownerId;
    private String workspaceId;

    @BeforeEach
    void fixture() {
        AGENT_STATUS.set(200);
        AGENT_AUTH.set("");
        AGENT_BODY.set("");
        ownerId = register("p660-question-" + UUID.randomUUID()).getUser().getId();
        workspaceId = workspaceFixture
                .createOwnedWorkspace("P660 question ws " + UUID.randomUUID(), ownerId).getId().toString();
    }

    @Test
    void concurrentAnswers_leaveExactlyOneWinner() throws Exception {
        ChatRun run = newRun(newSession(), null);
        UserQuestion asked = ask(run, null);

        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch gate = new CountDownLatch(1);
        List<Future<String>> outcomes = new ArrayList<>();
        try {
            for (int index = 0; index < 2; index++) {
                String answer = "answer-" + index;
                outcomes.add(pool.submit(() -> {
                    gate.await();
                    try {
                        service.answer(asked.getId(), ownerId, answer);
                        return "WON";
                    } catch (CpApiException refused) {
                        return refused.getCode();
                    }
                }));
            }
            gate.countDown();
        } finally {
            pool.shutdown();
        }
        assertTrue(pool.awaitTermination(30, TimeUnit.SECONDS), "both answer attempts must finish");

        List<String> results = new ArrayList<>();
        for (Future<String> outcome : outcomes) {
            results.add(outcome.get());
        }
        assertEquals(1, results.stream().filter("WON"::equals).count(),
                "exactly one conditional update may win: " + results);
        assertEquals(List.of("QUESTION_ALREADY_SETTLED"),
                results.stream().filter(result -> !"WON".equals(result)).toList(),
                "the loser must report a settled question, never a fabricated answer: " + results);
        assertEquals(UserQuestion.STATE_ANSWERED, service.stateOf(asked.getId()).orElseThrow());
        assertNotNull(questions.findById(asked.getId()).orElseThrow().getSettledAt());
    }

    @Test
    void answerAfterTheDeadlineIsRefusedAndTheRowSettlesAsExpired() {
        ChatRun run = newRun(newSession(), null);
        UserQuestion asked = ask(run, Instant.now().minusSeconds(1));

        CpApiException expired = assertThrows(CpApiException.class,
                () -> service.answer(asked.getId(), ownerId, "too late"));

        assertEquals(HttpStatus.CONFLICT, expired.getStatus());
        assertEquals("QUESTION_EXPIRED", expired.getCode());
        assertEquals(UserQuestion.STATE_EXPIRED, service.stateOf(asked.getId()).orElseThrow(),
                "the losing CAS settles the row lazily instead of leaving it pending forever");
    }

    @Test
    void answerKeepsTheBodyDurableButOnlyForTheAddressee() {
        ChatRun run = newRun(newSession(), null);
        UserQuestion asked = ask(run, null);

        UserQuestion answered = service.answer(asked.getId(), ownerId, "rebase onto develop");

        assertEquals("rebase onto develop", answered.getAnswer());
        assertEquals("rebase onto develop",
                questions.findById(asked.getId()).orElseThrow().getAnswer(),
                "the body is durable (only the logs/audit must not carry it)");
        // A second answer, and an answer from a foreign user, are both refused.
        assertEquals("QUESTION_ALREADY_SETTLED", assertThrows(CpApiException.class,
                () -> service.answer(asked.getId(), ownerId, "second thought")).getCode());
        String stranger = register("p660-stranger-" + UUID.randomUUID()).getUser().getId();
        assertEquals("QUESTION_NOT_FOUND", assertThrows(CpApiException.class,
                () -> service.answer(asked.getId(), stranger, "let me answer")).getCode(),
                "a non-addressee must not learn the row exists");
    }

    @Test
    void aRefusedCallbackLeavesTheQuestionPending() {
        ChatRun run = newRun(newSession(), null);
        UserQuestion asked = ask(run, null);
        AGENT_STATUS.set(500);

        CpApiException failure = assertThrows(CpApiException.class,
                () -> service.answer(asked.getId(), ownerId, "rebase onto develop"));

        assertEquals(HttpStatus.BAD_GATEWAY, failure.getStatus());
        assertEquals("AGENT_QUESTION_DELIVERY_FAILED", failure.getCode());
        assertEquals(UserQuestion.STATE_PENDING, service.stateOf(asked.getId()).orElseThrow(),
                "a failed callback must not fabricate answered — the CAS rolls back with the transaction");
        assertNull(questions.findById(asked.getId()).orElseThrow().getAnswer(),
                "no answer becomes durable before the waiting run received it");

        // The question is still answerable: the retry succeeds once the Agent accepts again.
        AGENT_STATUS.set(200);
        assertEquals(UserQuestion.STATE_ANSWERED,
                service.answer(asked.getId(), ownerId, "rebase onto develop").getState());
    }

    @Test
    void theCallbackCarriesTheQuestionAndTheServiceBearer() {
        ChatRun run = newRun(newSession(), null);
        UserQuestion asked = ask(run, null);

        service.answer(asked.getId(), ownerId, "use develop");

        assertTrue(AGENT_AUTH.get().startsWith("Bearer "), "service auth: " + AGENT_AUTH.get());
        assertTrue(AGENT_BODY.get().contains(asked.getId().toString()),
                "the Agent matches its wait on questionId: " + AGENT_BODY.get());
        assertTrue(AGENT_BODY.get().contains("use develop"), "the body travels on the internal wire");
    }

    @Test
    void recordPending_refusesWhenAnApprovalStillOwnsTheRunsHumanSlot() {
        ChatRun run = newRun(newSession(), null);
        approvals.saveAndFlush(new ChatApproval(UUID.randomUUID().toString(),
                run.getId().toString(), run.getSessionId(), ownerId, workspaceId, "write_file",
                "delete README.md", "README.md", "pending", Instant.now().plusSeconds(300)));

        CpApiException conflict = assertThrows(CpApiException.class, () -> ask(run, null));

        assertEquals(HttpStatus.CONFLICT, conflict.getStatus());
        assertEquals("QUESTION_APPROVAL_PENDING", conflict.getCode());
        assertEquals(0, questions.findByRunIdAndStateIn(run.getId(),
                List.of(UserQuestion.STATE_PENDING)).size(),
                "a refused ask must not leave a pending row behind");
    }

    @Test
    void recordPending_refusesAChildRunAndASecondPendingQuestion() {
        ChatRun run = newRun(newSession(), null);
        ask(run, null);

        assertEquals("QUESTION_ALREADY_PENDING", assertThrows(CpApiException.class,
                () -> ask(run, null)).getCode());

        ChatRun child = newRun(newSession(), UUID.randomUUID());
        assertEquals("SUBAGENT_QUESTION_REFUSED", assertThrows(CpApiException.class,
                () -> ask(child, null)).getCode(),
                "only a root run may ask the user (PLAN-0648 decision #13)");
    }

    @Test
    void terminalCleanupIsIdempotentAndNeverOverwritesAnAnswer() {
        ChatRun cancelledRun = newRun(newSession(), null);
        UserQuestion pending = ask(cancelledRun, null);
        ChatRun finishedRun = newRun(newSession(), null);
        UserQuestion answered = ask(finishedRun, null);
        service.answer(answered.getId(), ownerId, "done");

        assertEquals(1, service.cancelPendingForTerminalRun(cancelledRun.getId(), "cancelled"));
        assertEquals(0, service.cancelPendingForTerminalRun(cancelledRun.getId(), "cancelled"),
                "a replayed terminal settle must be a no-op");
        assertEquals(UserQuestion.STATE_CANCELLED, service.stateOf(pending.getId()).orElseThrow());
        assertNotNull(questions.findById(pending.getId()).orElseThrow().getSettledAt());

        assertEquals(0, service.cancelPendingForTerminalRun(finishedRun.getId(), "succeeded"));
        assertEquals(UserQuestion.STATE_ANSWERED, service.stateOf(answered.getId()).orElseThrow(),
                "terminal cleanup can never roll an answered row back");
        assertEquals("done", questions.findById(answered.getId()).orElseThrow().getAnswer());
    }

    @Test
    void pendingCountAndProjectionFollowTheStateTransitions() {
        UserQuestion first = ask(newRun(newSession(), null), null);
        UserQuestion second = ask(newRun(newSession(), null), null);
        assertEquals(2, service.pendingCount(ownerId));
        assertEquals(2, service.findProjection(ownerId, null, 10).size());

        service.answer(first.getId(), ownerId, "first answered");

        assertEquals(1, service.pendingCount(ownerId), "the count is derived from rows, never stored");
        List<UserQuestion> pendingView = service.findProjection(ownerId, null, 10);
        assertEquals(1, pendingView.size());
        assertEquals(second.getId(), pendingView.getFirst().getId());
        assertEquals(UserQuestion.STATE_ANSWERED,
                service.findProjection(ownerId, UserQuestion.STATE_ANSWERED, 10).getFirst().getState());
        assertFalse(service.findProjection(ownerId, null, 10).isEmpty());
    }

    // ---------------------------------------------------------------------------------------
    // fixtures
    // ---------------------------------------------------------------------------------------

    private UUID newSession() {
        Session session = new Session();
        session.setId(UUID.randomUUID());
        session.setWorkspaceId(workspaceId);
        session.setUserId(ownerId);
        session.setTitle("P660 question session");
        return sessions.saveAndFlush(session).getId();
    }

    private ChatRun newRun(UUID sessionId, UUID parentRunId) {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), sessionId.toString(), ownerId,
                workspaceId, "idem-" + UUID.randomUUID(), "hash", "openai", "gpt-test",
                "workspace", "streaming");
        if (parentRunId != null) {
            run.setParentRunId(parentRunId.toString());
        }
        return runs.saveAndFlush(run);
    }

    private UserQuestion ask(ChatRun run, Instant expiresAt) {
        return service.recordPending(run.getSessionId(), run.getId().toString(), ownerId,
                workspaceId, "which branch should I rebase onto?", expiresAt, null);
    }

    private AuthResponse register(String label) {
        // Keep the local part short: the @Email validator caps it at 64 characters.
        String email = "p660q" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        var response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest(email, TestDataFactory.PASSWORD, label), AuthResponse.class);
        assertEquals(201, response.getStatusCode().value(), "registration must succeed for " + email);
        assertNotNull(response.getBody());
        return response.getBody();
    }
}
