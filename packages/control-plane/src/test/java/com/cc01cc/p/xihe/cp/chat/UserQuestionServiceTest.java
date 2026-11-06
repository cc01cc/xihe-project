package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.UserQuestion;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserQuestionRepository;
import com.cc01cc.p.xihe.cp.service.SessionReadAccess;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.SimpleTransactionStatus;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0660 M5-B / T5.9: the question state machine, its 409 vocabulary, and the run-level lock that
 * makes the two-table "one pending human interaction" gate atomic.
 *
 * <p>These are the branch-level assertions (mocked persistence). The real CAS, the real lock and the
 * real concurrency live in {@code UserQuestionServiceIntegrationTest} (PostgreSQL lane) — this class
 * must not pretend a mock proves SQL semantics.</p>
 */
class UserQuestionServiceTest {

    private static final String RUN_ID = "11111111-1111-1111-1111-111111111111";
    private static final String SESSION_ID = "55555555-5555-5555-5555-555555555555";
    private static final String USER_ID = "33333333-3333-3333-3333-333333333333";
    private static final String OTHER_USER_ID = "66666666-6666-6666-6666-666666666666";
    private static final String WORKSPACE_ID = "44444444-4444-4444-4444-444444444444";
    private static final String PARENT_RUN_ID = "77777777-7777-7777-7777-777777777777";
    private static final String PROMPT = "which branch should I rebase onto?";
    private static final String ANSWER = "rebase onto develop";
    /** BL-423: frozen instant for the clock-seam tests (nothing here depends on wall time). */
    private static final java.time.Instant PROJECTION_INSTANT =
            java.time.Instant.parse("2026-11-07T00:00:00Z");

    private final UserQuestionRepository questions = mock(UserQuestionRepository.class);
    private final ChatRunRepository runs = mock(ChatRunRepository.class);
    private final ChatApprovalRepository approvals = mock(ChatApprovalRepository.class);
    private final SessionRepository sessions = mock(SessionRepository.class);
    private final SessionReadAccess sessionReadAccess = mock(SessionReadAccess.class);
    private final AuditLogger audit = mock(AuditLogger.class);
    private final UserQuestionAgentClient agentClient = mock(UserQuestionAgentClient.class);
    /** No-op transaction manager: this lane asserts branch behaviour, not rollback semantics. */
    private static final PlatformTransactionManager TX_MANAGER = new PlatformTransactionManager() {
        @Override
        public TransactionStatus getTransaction(TransactionDefinition definition) {
            return new SimpleTransactionStatus();
        }

        @Override
        public void commit(TransactionStatus status) { }

        @Override
        public void rollback(TransactionStatus status) { }
    };
    private final UserQuestionService service = new UserQuestionService(questions, runs, approvals,
            sessions, agentClient, sessionReadAccess, audit, TX_MANAGER);

    // ---------------------------------------------------------------------------------------
    // recordPending
    // ---------------------------------------------------------------------------------------

    @Test
    void recordPending_locksTheRunBeforeReadingTheTwoTables() {
        when(runs.findByIdForUpdate(UUID.fromString(RUN_ID))).thenReturn(Optional.of(rootRun()));
        when(approvals.findByRunIdAndStateIn(eq(RUN_ID), any())).thenReturn(List.of());
        when(questions.existsByRunIdAndState(UUID.fromString(RUN_ID), UserQuestion.STATE_PENDING))
                .thenReturn(false);
        when(questions.save(any(UserQuestion.class))).thenAnswer(call -> call.getArgument(0));

        UserQuestion saved = service.recordPending(SESSION_ID, RUN_ID, USER_ID, WORKSPACE_ID,
                "  " + PROMPT + "  ", Instant.now().plusSeconds(600), null);

        // The run row is the serialisation point of the cross-table gate: it must be a lock, and the
        // unlocked read must never be used here.
        verify(runs).findByIdForUpdate(UUID.fromString(RUN_ID));
        verify(runs, never()).findById(any());
        assertEquals(UserQuestion.STATE_PENDING, saved.getState());
        assertEquals(PROMPT, saved.getPrompt(), "the writer trims the body before persisting it");
        assertEquals(UUID.fromString(USER_ID), saved.getAddresseeUserId(),
                "v1 addressee is the run owner (PLAN-0648 decision #14)");
        assertEquals(UUID.fromString(RUN_ID), saved.getRunId());
        assertEquals(UUID.fromString(SESSION_ID), saved.getSessionId());
    }

    @Test
    void recordPending_refusesAChildRunWithTheFrozenCode() {
        ChatRun child = rootRun();
        child.setParentRunId(PARENT_RUN_ID);
        when(runs.findByIdForUpdate(UUID.fromString(RUN_ID))).thenReturn(Optional.of(child));

        CpApiException refused = assertThrows(CpApiException.class, () -> service.recordPending(
                SESSION_ID, RUN_ID, USER_ID, WORKSPACE_ID, PROMPT, null, null));

        assertEquals(HttpStatus.CONFLICT, refused.getStatus());
        assertEquals("SUBAGENT_QUESTION_REFUSED", refused.getCode());
        verify(questions, never()).save(any());
    }

    @Test
    void recordPending_refusesWhenAnApprovalStillOwnsTheHumanSlot() {
        when(runs.findByIdForUpdate(UUID.fromString(RUN_ID))).thenReturn(Optional.of(rootRun()));
        when(approvals.findByRunIdAndStateIn(eq(RUN_ID), any()))
                .thenReturn(List.of(mock(ChatApproval.class)));

        CpApiException conflict = assertThrows(CpApiException.class, () -> service.recordPending(
                SESSION_ID, RUN_ID, USER_ID, WORKSPACE_ID, PROMPT, null, null));

        assertEquals(HttpStatus.CONFLICT, conflict.getStatus());
        assertEquals("QUESTION_APPROVAL_PENDING", conflict.getCode());
        verify(questions, never()).save(any());
    }

    @Test
    void recordPending_refusesASecondPendingQuestionOfTheSameRun() {
        when(runs.findByIdForUpdate(UUID.fromString(RUN_ID))).thenReturn(Optional.of(rootRun()));
        when(approvals.findByRunIdAndStateIn(eq(RUN_ID), any())).thenReturn(List.of());
        when(questions.existsByRunIdAndState(UUID.fromString(RUN_ID), UserQuestion.STATE_PENDING))
                .thenReturn(true);

        CpApiException conflict = assertThrows(CpApiException.class, () -> service.recordPending(
                SESSION_ID, RUN_ID, USER_ID, WORKSPACE_ID, PROMPT, null, null));

        assertEquals("QUESTION_ALREADY_PENDING", conflict.getCode());
        verify(questions, never()).save(any());
    }

    @Test
    void recordPending_failsClosedOnBadInputsBeforeWritingAnything() {
        when(runs.findByIdForUpdate(UUID.fromString(RUN_ID))).thenReturn(Optional.empty());
        CpApiException unknownRun = assertThrows(CpApiException.class, () -> service.recordPending(
                SESSION_ID, RUN_ID, USER_ID, WORKSPACE_ID, PROMPT, null, null));
        assertEquals("AGENT_EVENT_ID_MISMATCH", unknownRun.getCode());

        when(runs.findByIdForUpdate(UUID.fromString(RUN_ID))).thenReturn(Optional.of(rootRun()));
        CpApiException blank = assertThrows(CpApiException.class, () -> service.recordPending(
                SESSION_ID, RUN_ID, USER_ID, WORKSPACE_ID, "   ", null, null));
        assertEquals("AGENT_EVENT_INVALID", blank.getCode());

        String tooLong = "x".repeat(UserQuestionService.MAX_PROMPT_LENGTH + 1);
        CpApiException oversize = assertThrows(CpApiException.class, () -> service.recordPending(
                SESSION_ID, RUN_ID, USER_ID, WORKSPACE_ID, tooLong, null, null));
        assertEquals("AGENT_EVENT_INVALID", oversize.getCode());

        CpApiException foreignUser = assertThrows(CpApiException.class, () -> service.recordPending(
                SESSION_ID, RUN_ID, OTHER_USER_ID, WORKSPACE_ID, PROMPT, null, null));
        assertEquals("AGENT_EVENT_ID_MISMATCH", foreignUser.getCode(),
                "the event must belong to the active run");
        verify(questions, never()).save(any());
    }

    // ---------------------------------------------------------------------------------------
    // answer
    // ---------------------------------------------------------------------------------------

    @Test
    void answer_isAddresseeOnlyAndNeverLeaksExistence() {
        UserQuestion row = pendingRow();
        when(questions.findById(row.getId())).thenReturn(Optional.of(row));

        CpApiException notYours = assertThrows(CpApiException.class,
                () -> service.answer(row.getId(), OTHER_USER_ID, ANSWER));

        assertEquals(HttpStatus.NOT_FOUND, notYours.getStatus(),
                "a non-addressee must see the same 404 as a nonexistent question");
        assertEquals("QUESTION_NOT_FOUND", notYours.getCode());
        verify(questions, never()).markAnswered(any(), anyString(), any());
    }

    @Test
    void answer_winsThePendingRowAndAuditsWithoutTheBody() {
        UserQuestion row = pendingRow();
        when(questions.findById(row.getId())).thenReturn(Optional.of(row));
        when(questions.markAnswered(eq(row.getId()), eq(ANSWER), any())).thenReturn(1);

        UserQuestion answered = service.answer(row.getId(), USER_ID, ANSWER);

        assertEquals(UserQuestion.STATE_ANSWERED, answered.getState());
        assertEquals(ANSWER, answered.getAnswer());
        assertNotNull(answered.getSettledAt());
        ArgumentCaptor<String> detail = ArgumentCaptor.forClass(String.class);
        verify(audit).recordDurableChange(eq(USER_ID), isNull(), eq("user_question_answered"),
                eq("user_question"), eq(row.getId().toString()), detail.capture());
        assertFalse(detail.getValue().contains(ANSWER),
                "the answer body must never reach the audit stream: " + detail.getValue());
        assertTrue(detail.getValue().contains(row.getId().toString()));
        assertTrue(detail.getValue().contains("\"answerLength\":" + ANSWER.length()));
    }

    @Test
    void answer_reportsAlreadySettledWhenTheCasLosesToAnotherActor() {
        UserQuestion row = pendingRow();
        when(questions.findById(row.getId())).thenReturn(Optional.of(row));
        when(questions.markAnswered(eq(row.getId()), anyString(), any())).thenReturn(0);
        when(questions.findStateById(row.getId())).thenReturn(Optional.of(UserQuestion.STATE_ANSWERED));

        CpApiException conflict = assertThrows(CpApiException.class,
                () -> service.answer(row.getId(), USER_ID, ANSWER));

        assertEquals(HttpStatus.CONFLICT, conflict.getStatus());
        assertEquals("QUESTION_ALREADY_SETTLED", conflict.getCode());
        verify(questions, never()).settlePending(any(), anyString(), any());
    }

    @Test
    void answer_reportsExpiredAndSettlesLazilyWhenTheDeadlineWon() {
        UserQuestion row = pendingRow();
        when(questions.findById(row.getId())).thenReturn(Optional.of(row));
        when(questions.markAnswered(eq(row.getId()), anyString(), any())).thenReturn(0);
        when(questions.findStateById(row.getId())).thenReturn(Optional.of(UserQuestion.STATE_PENDING));

        CpApiException conflict = assertThrows(CpApiException.class,
                () -> service.answer(row.getId(), USER_ID, ANSWER));

        assertEquals(HttpStatus.CONFLICT, conflict.getStatus());
        assertEquals("QUESTION_EXPIRED", conflict.getCode());
        verify(questions).settlePending(eq(row.getId()), eq(UserQuestion.STATE_EXPIRED), any());
    }

    /**
     * V13: after a list/badge read lazily settled the row, the late answer still belongs to the
     * <b>deadline</b> conflict vocabulary. It must not degrade into a generic
     * {@code QUESTION_ALREADY_SETTLED} just because a read persisted the expiry first.
     */
    @Test
    void answer_reportsExpiredWhenAReadAlreadySettledTheOverdueRow() {
        UserQuestion row = pendingRow();
        row.setState(UserQuestion.STATE_EXPIRED);
        row.setExpiresAt(Instant.now().minusSeconds(1));
        when(questions.findById(row.getId())).thenReturn(Optional.of(row));
        when(questions.markAnswered(eq(row.getId()), anyString(), any())).thenReturn(0);
        when(questions.findStateById(row.getId())).thenReturn(Optional.of(UserQuestion.STATE_EXPIRED));

        CpApiException conflict = assertThrows(CpApiException.class,
                () -> service.answer(row.getId(), USER_ID, ANSWER));

        assertEquals(HttpStatus.CONFLICT, conflict.getStatus());
        assertEquals("QUESTION_EXPIRED", conflict.getCode());
        verify(questions, never()).settlePending(any(), anyString(), any());
        verify(agentClient, never()).respond(any(), any(), any(), any());
    }

    @Test
    void answer_validatesTheBodyOnlyForTheAddressee() {
        UserQuestion row = pendingRow();
        when(questions.findById(row.getId())).thenReturn(Optional.of(row));

        // The addressee with a blank body: an honest 400 about their own request, nothing written.
        CpApiException blank = assertThrows(CpApiException.class,
                () -> service.answer(row.getId(), USER_ID, "  "));

        assertEquals(HttpStatus.BAD_REQUEST, blank.getStatus());
        assertEquals("INVALID_REQUEST", blank.getCode());
        verify(questions, never()).markAnswered(any(), anyString(), any());
        verify(agentClient, never()).respond(any(), any(), any(), any());

        // A stranger with the same blank body: still the uniform 404 — visibility is decided first,
        // so the route can never be used as a body-validation oracle.
        CpApiException stranger = assertThrows(CpApiException.class,
                () -> service.answer(row.getId(), OTHER_USER_ID, "  "));
        assertEquals(HttpStatus.NOT_FOUND, stranger.getStatus());
        assertEquals("QUESTION_NOT_FOUND", stranger.getCode());
    }

    // ---------------------------------------------------------------------------------------
    // T5.12: the callback is part of the answer
    // ---------------------------------------------------------------------------------------

    @Test
    void answer_deliversToTheAgentOnlyAfterTheCasWins() {
        UserQuestion row = pendingRow();
        when(questions.findById(row.getId())).thenReturn(Optional.of(row));
        when(questions.markAnswered(eq(row.getId()), eq(ANSWER), any())).thenReturn(1);

        service.answer(row.getId(), USER_ID, ANSWER);

        ArgumentCaptor<String> delivered = ArgumentCaptor.forClass(String.class);
        verify(agentClient).respond(eq(row.getId().toString()), eq(SESSION_ID), eq(RUN_ID),
                delivered.capture());
        assertEquals(ANSWER, delivered.getValue(),
                "the internal call carries the body — that is its whole purpose");
    }

    @Test
    void answer_doesNotCallTheAgentWhenTheCasLost() {
        UserQuestion row = pendingRow();
        when(questions.findById(row.getId())).thenReturn(Optional.of(row));
        when(questions.markAnswered(eq(row.getId()), anyString(), any())).thenReturn(0);
        when(questions.findStateById(row.getId())).thenReturn(Optional.of(UserQuestion.STATE_ANSWERED));

        assertThrows(CpApiException.class, () -> service.answer(row.getId(), USER_ID, ANSWER));

        verify(agentClient, never()).respond(any(), any(), any(), any());
    }

    @Test
    void answer_surfacesADeliveryFailureAndWritesNoAudit() {
        UserQuestion row = pendingRow();
        when(questions.findById(row.getId())).thenReturn(Optional.of(row));
        when(questions.markAnswered(eq(row.getId()), eq(ANSWER), any())).thenReturn(1);
        org.mockito.Mockito.doThrow(new CpApiException(HttpStatus.BAD_GATEWAY,
                        "AGENT_QUESTION_DELIVERY_FAILED", "Agent did not accept the answer (status 500)"))
                .when(agentClient).respond(any(), any(), any(), any());

        CpApiException failure = assertThrows(CpApiException.class,
                () -> service.answer(row.getId(), USER_ID, ANSWER));

        assertEquals("AGENT_QUESTION_DELIVERY_FAILED", failure.getCode());
        assertEquals(HttpStatus.BAD_GATEWAY, failure.getStatus());
        verify(audit, never()).recordDurableChange(any(), any(), any(), any(), any(), any());
        // The real rollback (row stays pending) is asserted on PostgreSQL in the integration test.
    }

    // ---------------------------------------------------------------------------------------
    // settle
    // ---------------------------------------------------------------------------------------

    @Test
    void settle_onlyAcceptsTheTwoTerminalTargetsAndIsIdempotent() {
        UUID id = UUID.randomUUID();
        assertThrows(IllegalArgumentException.class,
                () -> service.settle(id, UserQuestion.STATE_ANSWERED),
                "answered is reachable only through answer()");
        assertThrows(IllegalArgumentException.class, () -> service.settle(id, "nonsense"));

        when(questions.settlePending(eq(id), eq(UserQuestion.STATE_EXPIRED), any())).thenReturn(0);
        assertEquals(0, service.settle(id, UserQuestion.STATE_EXPIRED),
                "nothing pending means nothing to do — a repeat must not fail the caller");
    }

    @Test
    void cancelPendingForTerminalRun_mapsCancelledRunsToCancelledAndTheRestToExpired() {
        UUID runId = UUID.fromString(RUN_ID);
        when(questions.settlePendingForRun(eq(runId), eq(UserQuestion.STATE_CANCELLED), any()))
                .thenReturn(2);
        when(questions.settlePendingForRun(eq(runId), eq(UserQuestion.STATE_EXPIRED), any()))
                .thenReturn(1);

        assertEquals(2, service.cancelPendingForTerminalRun(runId, "cancelled"));
        assertEquals(1, service.cancelPendingForTerminalRun(runId, "succeeded"));
        assertEquals(0, service.cancelPendingForTerminalRun(null, "failed"));
        verify(questions, never()).settlePending(any(), anyString(), any());
    }

    // ---------------------------------------------------------------------------------------
    // minimisation: the body never leaves CP through a log line
    // ---------------------------------------------------------------------------------------

    @Test
    void logsCarryTheQuestionIdAndLengthButNeverTheBody() {
        when(runs.findByIdForUpdate(UUID.fromString(RUN_ID))).thenReturn(Optional.of(rootRun()));
        when(approvals.findByRunIdAndStateIn(eq(RUN_ID), any())).thenReturn(List.of());
        when(questions.existsByRunIdAndState(UUID.fromString(RUN_ID), UserQuestion.STATE_PENDING))
                .thenReturn(false);
        when(questions.save(any(UserQuestion.class))).thenAnswer(call -> {
            UserQuestion row = call.getArgument(0);
            row.setId(UUID.randomUUID());
            return row;
        });
        UserQuestion saved = service.recordPending(SESSION_ID, RUN_ID, USER_ID, WORKSPACE_ID, PROMPT,
                null, null);
        UserQuestion answered = pendingRow(saved.getId());
        when(questions.findById(saved.getId())).thenReturn(Optional.of(answered));
        when(questions.markAnswered(eq(saved.getId()), eq(ANSWER), any())).thenReturn(1);

        org.slf4j.Logger serviceLogger = org.slf4j.LoggerFactory.getLogger(UserQuestionService.class);
        ch.qos.logback.classic.Logger logbackLogger = (ch.qos.logback.classic.Logger) serviceLogger;
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        logbackLogger.addAppender(appender);
        try {
            service.recordPending(SESSION_ID, RUN_ID, USER_ID, WORKSPACE_ID, PROMPT, null, null);
            service.answer(saved.getId(), USER_ID, ANSWER);
        } finally {
            logbackLogger.detachAppender(appender);
        }

        List<String> messages = appender.list.stream()
                .map(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage)
                .toList();
        assertTrue(messages.stream().anyMatch(message -> message.contains("run_question_asked")),
                "the creation is observable: " + messages);
        assertTrue(messages.stream().anyMatch(message -> message.contains("run_question_answered")),
                "the answer is observable: " + messages);
        assertTrue(messages.stream().anyMatch(message -> message.contains("promptLength=")),
                "the prompt is observable only as a length: " + messages);
        for (String message : messages) {
            assertFalse(message.contains(PROMPT), "question body leaked into a log line: " + message);
            assertFalse(message.contains(ANSWER), "answer body leaked into a log line: " + message);
        }
    }

    // ---------------------------------------------------------------------------------------
    // fixtures
    // ---------------------------------------------------------------------------------------

    private ChatRun rootRun() {
        return new ChatRun(RUN_ID, SESSION_ID, USER_ID, WORKSPACE_ID, "idem-" + UUID.randomUUID(),
                "hash", "openai", "gpt-test", "workspace", "streaming");
    }

    private UserQuestion pendingRow() {
        return pendingRow(UUID.randomUUID());
    }

    private UserQuestion pendingRow(UUID id) {
        UserQuestion row = new UserQuestion(UUID.fromString(SESSION_ID), UUID.fromString(RUN_ID), null,
                UUID.fromString(USER_ID), PROMPT, null);
        row.setId(id);
        return row;
    }

    /** The projection window is bounded here so T5.10 cannot ask for an unbounded page. */
    @Test
    void findProjection_boundsTheWindowAndDefaultsToPending() {
        when(questions.findByAddresseeUserIdAndStateOrderByCreatedAtDesc(
                eq(UUID.fromString(USER_ID)), eq(UserQuestion.STATE_PENDING), any(Pageable.class)))
                .thenReturn(List.of(pendingRow()));

        assertEquals(1, service.findProjection(USER_ID, null, 0).size());
        ArgumentCaptor<Pageable> page = ArgumentCaptor.forClass(Pageable.class);
        verify(questions).findByAddresseeUserIdAndStateOrderByCreatedAtDesc(
                eq(UUID.fromString(USER_ID)), eq(UserQuestion.STATE_PENDING), page.capture());
        assertEquals(20, page.getValue().getPageSize(), "an unbounded limit is capped to the default");
        assertEquals(0, page.getValue().getPageNumber());

        assertThrows(CpApiException.class, () -> service.findProjection(USER_ID, "dispatching", 10));
    }

    /**
     * V13: the two inbox read faces settle overdue rows before they read, so the badge and the list
     * use the same durable state. The repository predicate is asserted on PostgreSQL; here we pin
     * that the read path actually invokes the settle (a projection-only filter would not).
     */
    @Test
    void inboxReadsSettleOverdueRowsBeforeProjectingAndCounting() {
        UUID addressee = UUID.fromString(USER_ID);
        when(questions.settleExpiredForAddressee(eq(addressee), any())).thenReturn(1);

        service.findProjection(USER_ID, null, 10);
        service.pendingCount(USER_ID);

        verify(questions, org.mockito.Mockito.times(2))
                .settleExpiredForAddressee(eq(addressee), any());
    }

    @Test
    void singleReadSettlesTheOverdueRowBeforeReturningIt() {
        UserQuestion row = pendingRow();
        when(questions.findById(row.getId())).thenReturn(Optional.of(row));

        UserQuestion read = service.findReadable(row.getId(), USER_ID);

        assertEquals(row.getId(), read.getId());
        verify(questions).settleExpiredById(eq(row.getId()), any());
    }

    // ---------------------------------------------------------------------------------------
    // BL-423: one snapshot per request (list + pendingCount must not straddle the deadline)
    // ---------------------------------------------------------------------------------------

    /**
     * BL-423: one request asks the clock <b>once</b>.
     *
     * <p>The defect was not a rounding error. {@code findProjection} and {@code pendingCount} each
     * read {@link java.time.Instant#now()} inside their own transaction, so a {@code expiresAt}
     * landing between the two reads produced a response that listed a row and simultaneously
     * excluded it from {@code pendingCount} — a card on screen whose badge says 0. Two reads is
     * exactly what the old pair did (see {@link #inboxReadsSettleOverdueRowsBeforeProjectingAndCounting},
     * which pins {@code times(2)} on the old path); one read is what makes straddling impossible.</p>
     */
    @Test
    void findProjectionWithCount_readsTheClockExactlyOnce() {
        CountingClock clock = new CountingClock(PROJECTION_INSTANT);
        stubInboxReads();

        UserQuestionService.ProjectionSnapshot snapshot =
                serviceAt(clock).findProjectionWithCount(USER_ID, null, 10);

        assertEquals(1, snapshot.items().size());
        assertEquals(1L, snapshot.pendingCount());
        assertEquals(1, clock.reads.get(),
                "a second clock read is the BL-423 defect: the deadline can fall between the two");
    }

    /**
     * BL-423: the lazy settle also runs once, before both reads — not once per read. A double settle
     * would let the first call expire the row while the second call's own clock read already moved
     * the boundary.
     */
    @Test
    void findProjectionWithCount_settlesOnceBeforeProjectingAndCounting() {
        UUID addressee = UUID.fromString(USER_ID);
        when(questions.settleExpiredForAddressee(eq(addressee), any())).thenReturn(0);
        stubInboxReads();

        serviceAt(new CountingClock(PROJECTION_INSTANT)).findProjectionWithCount(USER_ID, null, 10);

        verify(questions, org.mockito.Mockito.times(1))
                .settleExpiredForAddressee(eq(addressee), any());
    }

    /**
     * BL-423: an empty inbox logs nothing at all.
     *
     * <p>{@code findProjectionWithCount} deliberately carries no logging: the {@code [LIFECYCLE]}
     * lines mark state transitions (asked / answered / expired / cancelled / refused), and reading
     * an inbox that happens to be empty is not one. The 0-row case is the one worth pinning
     * separately, because it is exactly where a well-meaning "no pending questions for {user}"
     * line tends to appear — and the moment it does, every idle poll writes a log line.</p>
     *
     * <p>This is asserted on the real logger rather than on a mock: the point is the observable
     * output, not the call shape. {@code ListAppender} on the service logger is the same technique
     * {@code ApprovalServiceTest} and {@code AgentSpawnAuthorizationServiceTest} already use.</p>
     */
    @Test
    void findProjectionWithCount_logsNothingWhenTheInboxIsEmpty() {
        when(questions.findByAddresseeUserIdAndStateOrderByCreatedAtDesc(
                eq(UUID.fromString(USER_ID)), eq(UserQuestion.STATE_PENDING), any(Pageable.class)))
                .thenReturn(List.of());
        when(questions.countByAddresseeUserIdAndState(eq(UUID.fromString(USER_ID)),
                eq(UserQuestion.STATE_PENDING))).thenReturn(0L);

        ch.qos.logback.classic.Logger serviceLogger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(UserQuestionService.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        serviceLogger.addAppender(appender);
        UserQuestionService.ProjectionSnapshot snapshot;
        try {
            snapshot = serviceAt(new CountingClock(PROJECTION_INSTANT))
                    .findProjectionWithCount(USER_ID, null, 10);
        } finally {
            serviceLogger.detachAppender(appender);
            appender.stop();
        }

        assertTrue(snapshot.items().isEmpty(), "an empty inbox yields an empty page");
        assertEquals(0L, snapshot.pendingCount(), "and a zero badge");
        List<String> messages = appender.list.stream()
                .map(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage)
                .toList();
        assertTrue(messages.isEmpty(), "an empty inbox must not log anything, got: " + messages);
    }

    /**
     * BL-423, the boundary itself: with a clock that steps forward on <b>every</b> read, the old
     * two-read implementation would see two different instants and disagree with itself. The single
     * read makes "listed" and "counted" the same instant by construction, so both values stay
     * consistent no matter where {@code expiresAt} sits.
     */
    @Test
    void findProjectionWithCount_cannotStraddleTheDeadlineBecauseThereIsOnlyOneInstant() {
        TickClock clock = new TickClock(PROJECTION_INSTANT, java.time.Duration.ofSeconds(30));
        when(questions.findByAddresseeUserIdAndStateOrderByCreatedAtDesc(
                eq(UUID.fromString(USER_ID)), eq(UserQuestion.STATE_PENDING), any(Pageable.class)))
                .thenReturn(List.of(pendingRow()));
        when(questions.countByAddresseeUserIdAndState(eq(UUID.fromString(USER_ID)),
                eq(UserQuestion.STATE_PENDING))).thenReturn(1L);

        UserQuestionService.ProjectionSnapshot snapshot =
                serviceAt(clock).findProjectionWithCount(USER_ID, null, 10);

        assertEquals(1, snapshot.items().size());
        assertEquals(snapshot.items().size(), snapshot.pendingCount(),
                "the list and the badge come from one instant, so they can never disagree");
        assertEquals(1, clock.reads.get());
    }

    private void stubInboxReads() {
        when(questions.findByAddresseeUserIdAndStateOrderByCreatedAtDesc(
                eq(UUID.fromString(USER_ID)), eq(UserQuestion.STATE_PENDING), any(Pageable.class)))
                .thenReturn(List.of(pendingRow()));
        when(questions.countByAddresseeUserIdAndState(eq(UUID.fromString(USER_ID)),
                eq(UserQuestion.STATE_PENDING))).thenReturn(1L);
    }

    /** Same wiring as the shared {@link #service}, but with an injected clock. */
    private UserQuestionService serviceAt(java.time.Clock clock) {
        return new UserQuestionService(questions, runs, approvals, sessions, agentClient,
                sessionReadAccess, audit, TX_MANAGER, clock);
    }

    /** Fixed-instant clock that counts how many times the service asked for the time. */
    private static final class CountingClock extends java.time.Clock {
        private final java.time.Instant fixed;
        private final java.util.concurrent.atomic.AtomicInteger reads =
                new java.util.concurrent.atomic.AtomicInteger();

        private CountingClock(java.time.Instant fixed) {
            this.fixed = fixed;
        }

        @Override
        public java.time.ZoneId getZone() {
            return java.time.ZoneOffset.UTC;
        }

        @Override
        public java.time.Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public java.time.Instant instant() {
            reads.incrementAndGet();
            return fixed;
        }
    }

    /** Clock that advances on every read, so two reads in one request become visible. */
    private static final class TickClock extends java.time.Clock {
        private final java.time.Instant start;
        private final java.time.Duration step;
        private final java.util.concurrent.atomic.AtomicInteger reads =
                new java.util.concurrent.atomic.AtomicInteger();

        private TickClock(java.time.Instant start, java.time.Duration step) {
            this.start = start;
            this.step = step;
        }

        @Override
        public java.time.ZoneId getZone() {
            return java.time.ZoneOffset.UTC;
        }

        @Override
        public java.time.Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public java.time.Instant instant() {
            return start.plus(step.multipliedBy(reads.getAndIncrement()));
        }
    }
}
