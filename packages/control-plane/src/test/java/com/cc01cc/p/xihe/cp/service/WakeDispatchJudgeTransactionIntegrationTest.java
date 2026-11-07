package com.cc01cc.p.xihe.cp.service;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.JudgeDecision;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.entity.UserQuestion;
import com.cc01cc.p.xihe.cp.repository.JudgeDecisionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserQuestionRepository;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.UnexpectedRollbackException;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0660 T2.1（审计升级为 P1）：judge 审计写失败时的事务边界。
 *
 * <p>修复契约（A03 {@code 96bb76b2}）：{@link JudgeDecisionService#decide} 的 REQUIRES_NEW
 * 事务让 judge 写失败只回滚独立事务；{@code WakeDispatchService.judgeSaysSpeak()} 记录
 * {@code wake_judge_failed} 后返回 false，外层 {@code fire()} 继续写 durable
 * {@code wake_dispatch outcome=judged_no} 并正常提交。若 judge 事务自身抛出
 * {@link UnexpectedRollbackException}，{@code judgeSaysSpeak()} 记录后**重抛**，外层整轮回滚，
 * 不能把已损坏的事务伪装成成功的 {@code judged_no}。</p>
 *
 * <p>两个用例都走<b>真实事务边界</b>，不是 mock 行为测试：只 mock 三个外部边界
 * （speak-as 判定、judge 模型调用、judge_decisions 写入），{@code WakeDispatchService} /
 * {@code JudgeDecisionService} / event store / repositories / transaction manager 全部用真实 Bean。
 * 测试方法**故意不加 {@code @Transactional}**：Spring 测试默认回滚会把外层提交结果藏掉。</p>
 */
class WakeDispatchJudgeTransactionIntegrationTest extends AbstractH2Test {

    @Autowired
    private WakeDispatchService wakeDispatchService;

    @Autowired
    private SessionRepository sessions;

    @Autowired
    private SessionParticipantRepository participants;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private PlatformTransactionManager transactionManager;

    /** Boundary 1: the wake path's speak-as decision is a real production service; only its answer is stubbed. */
    @MockitoBean
    private SessionParticipantService participantService;

    /** Boundary 2: the model call is external; the service around it stays real. */
    @MockitoBean
    private JudgeModelClient judgeModelClient;

    /**
     * Boundary 3: a spy, not a mock — the durable judge row is written for real unless a test stubs
     * the insert to fail. The two transaction-boundary cases above need the forced failure; the
     * T1.2 zero-side-effect case below needs the real {@code judge_decisions} row.
     */
    @MockitoSpyBean
    private JudgeDecisionRepository judgeDecisionRepository;

    @Autowired
    private UserQuestionRepository userQuestions;

    private UUID seedJudgeParticipant() {
        Session session = new Session();
        session.setId(UUID.randomUUID());
        session.setWorkspaceId(UUID.randomUUID().toString());
        session.setUserId(UUID.randomUUID().toString());
        session.setTitle("T2.1 judge transaction repro");
        sessions.saveAndFlush(session);

        SessionParticipant judge = new SessionParticipant(session.getId(),
                SessionParticipant.KIND_AGENT, UUID.randomUUID(), SessionParticipant.ROLE_MEMBER,
                20, SessionParticipant.WAKE_MENTION, SessionParticipant.RESPOND_JUDGE);
        judge.setId(UUID.randomUUID());
        return participants.saveAndFlush(judge).getId();
    }

    @Test
    void judgeAuditInsertFailureKeepsTheWakeRoundAndPersistsJudgedNo() throws JudgeModelClient.JudgeException {
        UUID participantId = seedJudgeParticipant();
        UUID sessionId = participants.findById(participantId).orElseThrow().getSessionId();
        stubJudgePath();
        doThrow(new DataIntegrityViolationException("judge_decisions insert failed"))
                .when(judgeDecisionRepository).save(any(JudgeDecision.class));

        ListAppender<ILoggingEvent> appender = attachWakeLog();
        try {
            AtomicReference<WakeDispatchService.WakeFireResult> fireResult = new AtomicReference<>();
            TransactionTemplate template = new TransactionTemplate(transactionManager);

            // REQUIRES_NEW: the failed judge insert rolls back only its own transaction, so the
            // outer wake transaction can still commit the durable judged_no row.
            assertDoesNotThrow(() -> template.executeWithoutResult(status -> fireResult.set(
                            wakeDispatchService.fire(participantId, "mention",
                                    "wake:mention:t2.1", sessionId, null))),
                    "the outer wake transaction must commit when only the judge insert failed");

            assertNotNull(fireResult.get(), "fire() must return a result");
            assertEquals("judged_no", fireResult.get().outcome());
            assertFalse(fireResult.get().dispatched());
            assertEquals(1, contextEventCount(sessionId, "wake_dispatch"),
                    "the judged_no wake_dispatch row must be durable after the outer commit");
            assertTrue(wakeDispatchPayload(sessionId).replaceAll("\\s+", "")
                            .contains("\"outcome\":\"judged_no\""),
                    "the durable wake_dispatch row must carry outcome=judged_no");
            assertEquals(0, judgeDecisionCount(sessionId),
                    "the mocked judge insert failed, so no judge row can exist");
            assertEquals(1, failureLogCount(appender, "DataIntegrityViolationException"),
                    "the ordinary judge write failure is logged once with its original type");
        } finally {
            detachWakeLog(appender);
        }

        verify(participantService, times(1))
                .judgeSpeakAs(anyString(), anyString(), anyString(), anyString());
        verify(judgeModelClient, times(1)).decide(any());
        verify(judgeDecisionRepository, times(1)).save(any(JudgeDecision.class));
    }

    @Test
    void unexpectedRollbackFromJudgeTransactionIsRethrownNotSwallowed() throws JudgeModelClient.JudgeException {
        UUID participantId = seedJudgeParticipant();
        UUID sessionId = participants.findById(participantId).orElseThrow().getSessionId();
        stubJudgePath();
        doThrow(new UnexpectedRollbackException("judge transaction commit failed"))
                .when(judgeDecisionRepository).save(any(JudgeDecision.class));

        ListAppender<ILoggingEvent> appender = attachWakeLog();
        try {
            TransactionTemplate template = new TransactionTemplate(transactionManager);

            // A broken judge transaction is not a refusal: the exception must reach the caller so
            // the fan-out records dropped, rather than being swallowed into a false judged_no.
            UnexpectedRollbackException propagated = assertThrows(UnexpectedRollbackException.class,
                    () -> template.executeWithoutResult(status -> wakeDispatchService.fire(
                            participantId, "mention", "wake:mention:t2.1-rb", sessionId, null)));
            assertEquals("judge transaction commit failed", propagated.getMessage(),
                    "judgeSaysSpeak must rethrow the original UnexpectedRollbackException");
            assertEquals(0, contextEventCount(sessionId, "wake_dispatch"),
                    "the outer wake transaction must roll back when the judge transaction is broken");
            assertEquals(0, judgeDecisionCount(sessionId));
            assertEquals(1, failureLogCount(appender, "UnexpectedRollbackException"),
                    "the broken judge transaction is logged once before it is rethrown");
        } finally {
            detachWakeLog(appender);
        }

        verify(participantService, times(1))
                .judgeSpeakAs(anyString(), anyString(), anyString(), anyString());
        verify(judgeModelClient, times(1)).decide(any());
        verify(judgeDecisionRepository, times(1)).save(any(JudgeDecision.class));
    }

    /**
     * PLAN-0690 T1.2: the JUDGE branch decides only <em>whether to speak</em>.
     *
     * <p>One real {@link WakeDispatchService#fire} on a JUDGE participant whose verdict says

     * {@code speak=false} must write exactly one {@code judge_decisions} row carrying the assembled
     * {@code input_window}, and nothing else: no {@code user_questions} transition, no
     * {@code session_participants.respond_policy} rewrite (all four enum values are snapshotted), no
     * {@code chat_runs} insertion, and no audit beyond the pre-existing fire path's own durable
     * {@code wake_dispatch} row.</p>
     */
    @Test
    void judgeDecisionWritesNoUserQuestionsNorRespondPolicy() throws JudgeModelClient.JudgeException {
        UUID judgeParticipantId = seedFourPolicyParticipants();
        UUID sessionId = participants.findById(judgeParticipantId).orElseThrow().getSessionId();
        UUID questionId = seedPendingUserQuestion(sessionId);

        Map<String, String> policiesBefore = respondPolicySnapshot(sessionId);
        assertEquals(Set.of(SessionParticipant.RESPOND_ALWAYS,
                        SessionParticipant.RESPOND_WHEN_MENTIONED,
                        SessionParticipant.RESPOND_JUDGE,
                        SessionParticipant.RESPOND_MUTED),
                new HashSet<>(policiesBefore.values()),
                "the snapshot must contain all four respond_policy values");
        long chatRunsBefore = rowCount("chat_runs");
        long auditLogsBefore = rowCount("audit_logs");
        long wakeDispatchBefore = contextEventCount(sessionId, "wake_dispatch");

        when(participantService.judgeSpeakAs(anyString(), anyString(), anyString(), anyString()))
                .thenReturn(SessionParticipantService.SpeakDecision.permit());
        stubJudgeVerdict("{\"speak\":false}");

        WakeDispatchService.WakeFireResult result = wakeDispatchService.fire(
                judgeParticipantId, "mention", "wake:mention:t1.2", sessionId, null);

        assertEquals("judged_no", result.outcome(), "speak=false must not dispatch a run");
        assertFalse(result.dispatched());
        assertNull(result.runId(), "a judged_no wake has no run");

        // The judge path's only durable output is the decision row, with its input window.
        assertEquals(1, judgeDecisionCount(sessionId), "exactly one judge_decisions row");
        Map<String, Object> decision = jdbc.queryForMap(
                "SELECT input_window, run_id, outcome FROM judge_decisions WHERE session_id = ?",
                sessionId);
        String inputWindow = (String) decision.get("input_window");
        assertNotNull(inputWindow, "judge_decisions.input_window must be populated");
        assertTrue(inputWindow.contains("round=wake:mention:t1.2"),
                "the input window must name the judged round, got: " + inputWindow);
        assertNull(decision.get("run_id"), "a judged_no wake has no run row");
        assertEquals("succeeded", decision.get("outcome"));

        // Zero side effects on the policy column, the pending question and the run table.
        assertEquals(policiesBefore, respondPolicySnapshot(sessionId),
                "judging must not rewrite any respond_policy value");
        assertEquals("pending", scalarString(
                "SELECT state FROM user_questions WHERE id = ?", questionId),
                "the pending question must stay pending");
        assertNull(scalarString("SELECT answer FROM user_questions WHERE id = ?", questionId),
                "judging must not answer the question");
        assertEquals(chatRunsBefore, rowCount("chat_runs"),
                "a judged_no wake must not create a chat run");

        // The one new durable row is the fire path's own audit; JUDGE adds no audit of its own.
        assertEquals(wakeDispatchBefore + 1, contextEventCount(sessionId, "wake_dispatch"),
                "the fire path's wake_dispatch row is the only new durable audit");
        assertEquals(auditLogsBefore, rowCount("audit_logs"),
                "JUDGE classes must not write audit_logs");
    }

    private UUID seedFourPolicyParticipants() {
        Session session = new Session();
        session.setId(UUID.randomUUID());
        session.setWorkspaceId(UUID.randomUUID().toString());
        session.setUserId(UUID.randomUUID().toString());
        session.setTitle("T1.2 judge zero side effects");
        sessions.saveAndFlush(session);

        String[] policies = {SessionParticipant.RESPOND_ALWAYS,
                SessionParticipant.RESPOND_WHEN_MENTIONED, SessionParticipant.RESPOND_JUDGE,
                SessionParticipant.RESPOND_MUTED};
        UUID judgeParticipantId = null;
        for (int index = 0; index < policies.length; index++) {
            SessionParticipant participant = new SessionParticipant(session.getId(),
                    SessionParticipant.KIND_AGENT, UUID.randomUUID(),
                    SessionParticipant.ROLE_MEMBER, 10 + index, SessionParticipant.WAKE_MENTION,
                    policies[index]);
            participant.setId(UUID.randomUUID());
            participants.saveAndFlush(participant);
            if (SessionParticipant.RESPOND_JUDGE.equals(policies[index])) {
                judgeParticipantId = participant.getId();
            }
        }
        assertNotNull(judgeParticipantId, "the JUDGE participant must be seeded");
        return judgeParticipantId;
    }

    private UUID seedPendingUserQuestion(UUID sessionId) {
        UserQuestion question = new UserQuestion(sessionId, UUID.randomUUID(), null,
                UUID.randomUUID(), "T1.2 pending question that must stay untouched", null);
        question.setId(UUID.randomUUID());
        return userQuestions.saveAndFlush(question).getId();
    }

    private Map<String, String> respondPolicySnapshot(UUID sessionId) {
        Map<String, String> snapshot = new LinkedHashMap<>();
        for (Map<String, Object> row : jdbc.queryForList(
                "SELECT id, respond_policy FROM session_participants WHERE session_id = ?",
                sessionId)) {
            snapshot.put(String.valueOf(row.get("id")), (String) row.get("respond_policy"));
        }
        return snapshot;
    }

    private long rowCount(String table) {
        return jdbc.queryForObject("SELECT count(*) FROM " + table, Long.class);
    }

    private String scalarString(String sql, Object argument) {
        return jdbc.queryForObject(sql, String.class, argument);
    }

    private void stubJudgePath() throws JudgeModelClient.JudgeException {
        when(participantService.judgeSpeakAs(anyString(), anyString(), anyString(), anyString()))
                .thenReturn(SessionParticipantService.SpeakDecision.permit());
        stubJudgeVerdict("{\"speak\":true}");
    }

    private void stubJudgeVerdict(String verdictJson) throws JudgeModelClient.JudgeException {
        when(judgeModelClient.decide(any()))
                .thenReturn(new JudgeModelClient.JudgeVerdict(verdictJson, 10L, 5L, 12L));
    }

    private ListAppender<ILoggingEvent> attachWakeLog() {
        Logger logger = (Logger) LoggerFactory.getLogger(WakeDispatchService.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        return appender;
    }

    private void detachWakeLog(ListAppender<ILoggingEvent> appender) {
        ((Logger) LoggerFactory.getLogger(WakeDispatchService.class)).detachAppender(appender);
    }

    private long failureLogCount(ListAppender<ILoggingEvent> appender, String failureType) {
        return appender.list.stream()
                .map(ILoggingEvent::getFormattedMessage)
                .filter(message -> message.contains("event=wake_judge_failed"))
                .filter(message -> message.contains("failureType=" + failureType))
                .count();
    }

    private String wakeDispatchPayload(UUID sessionId) {
        String payload = jdbc.queryForObject(
                "SELECT payload::text FROM context_events "
                        + "WHERE session_id = ? AND event_type = 'wake_dispatch'",
                String.class, sessionId.toString());
        assertNotNull(payload, "the durable wake_dispatch row must exist");
        return payload;
    }

    private long contextEventCount(UUID sessionId, String eventType) {
        return jdbc.queryForObject(
                "SELECT count(*) FROM context_events WHERE session_id = ? AND event_type = ?",
                Long.class, sessionId.toString(), eventType);
    }

    private long judgeDecisionCount(UUID sessionId) {
        // judge_decisions.session_id is UUID (V93:67), not varchar.
        return jdbc.queryForObject(
                "SELECT count(*) FROM judge_decisions WHERE session_id = ?",
                Long.class, sessionId);
    }
}
