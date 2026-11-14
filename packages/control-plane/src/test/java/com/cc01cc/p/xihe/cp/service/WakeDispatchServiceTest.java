package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.chat.SessionWakeupService;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import com.cc01cc.p.xihe.cp.logging.LogRedactor;
import org.mockito.ArgumentCaptor;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * PLAN-0624 M4 (D24-10/15 + the task-73 D23-08 ruling): the filled wake dispatch.
 */
class WakeDispatchServiceTest {

    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID PARTICIPANT_ID = UUID.randomUUID();
    private static final UUID RUN_ID = UUID.randomUUID();
    private static final String ROUND = "wake:mention:root-1";

    private SessionParticipantRepository participants;
    private SessionRepository sessions;
    private SessionParticipantService participantService;
    private SessionWakeupService wakeupService;
    private JudgeInputAssembler judgeInputAssembler;
    private JudgeDecisionService judgeService;
    private EventStoreService eventStore;
    private ChatRunRepository chatRuns;
    private DbLockTimeout dbLockTimeout;
    private WakeDispatchService service;

    private Session session;
    private SessionParticipant agent;

    @BeforeEach
    void setUp() {
        participants = mock(SessionParticipantRepository.class);
        sessions = mock(SessionRepository.class);
        participantService = mock(SessionParticipantService.class);
        wakeupService = mock(SessionWakeupService.class);
        judgeInputAssembler = mock(JudgeInputAssembler.class);
        judgeService = mock(JudgeDecisionService.class);
        eventStore = mock(EventStoreService.class);
        chatRuns = mock(ChatRunRepository.class);
        dbLockTimeout = mock(DbLockTimeout.class);
        service = new WakeDispatchService(participants, sessions, participantService, wakeupService,
                judgeInputAssembler, judgeService, eventStore, new ObjectMapper(), chatRuns, dbLockTimeout);

        session = mock(Session.class);
        when(session.getUserId()).thenReturn("owner-1");
        when(session.getWorkspaceId()).thenReturn("ws-1");
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(session));
        agent = new SessionParticipant(SESSION_ID, "AGENT", UUID.randomUUID(), "MEMBER", 20,
                "MENTION", "ALWAYS");
        when(participants.findById(PARTICIPANT_ID)).thenReturn(Optional.of(agent));
        // PLAN-0660 T2.1: the speak-as gate now answers with a value, so every test that reaches the
        // AGENT branch needs a default. Refusal cases override this stub.
        when(participantService.judgeSpeakAs(anyString(), anyString(), anyString(), anyString()))
                .thenReturn(SessionParticipantService.SpeakDecision.permit());
    }

    @Test
    void disabledParticipantIsRefusedAndAudited() {
        agent.setDisabledAt(java.time.Instant.now());

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null);

        assertEquals("refused", result.outcome());
        assertEquals("participant_disabled", result.detail(),
                "task-60: a disabled target is refused but is NOT a user-actionable suppression");
        verify(wakeupService, never()).wakeupAs(anyString(), anyString(), anyString(), anyString(),
                anyString(), any(), anyString(), any());
        assertAuditOutcome("refused");
    }

    @Test
    void agentRefusalIsAResultNotAnException() {
        // PLAN-0660 T3.2: the refusal must come back as a value — no exception may leave fire(), and
        // the durable refused row must be written in the same (still committable) transaction.
        // Deliberately no assertThrows here: the signature of this test IS the criterion.
        when(participantService.judgeSpeakAs(anyString(), anyString(), anyString(), anyString()))
                .thenReturn(SessionParticipantService.SpeakDecision.refused("PARTICIPANT_CAP_DENIED"));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null);

        assertEquals("refused", result.outcome());
        assertEquals("authorization:PARTICIPANT_CAP_DENIED", result.detail(),
                "task-60: the only user-actionable refusal carries the authorization code");
        assertFalse(result.dispatched());
        verify(wakeupService, never()).wakeupAs(anyString(), anyString(), anyString(), anyString(),
                anyString(), any(), anyString(), any());
        verifyNoInteractions(chatRuns);
        assertAuditOutcome("refused");
    }

    @Test
    void systemTriggeredStillNeedsAuthorization() {
        // PLAN-0660 T2.1: the gate answers with a refusal VALUE (it used to throw across the
        // transactional boundary, which is what poisoned the shared transaction).
        when(participantService.judgeSpeakAs(anyString(), anyString(), anyString(), anyString()))
                .thenReturn(SessionParticipantService.SpeakDecision
                        .refused("PARTICIPANT_IMPERSONATION_FORBIDDEN"));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "schedule", ROUND, SESSION_ID, null);

        assertEquals("refused", result.outcome(), "D23-08: a wake never bypasses --as authorization");
        verify(wakeupService, never()).wakeupAs(anyString(), anyString(), anyString(), anyString(),
                anyString(), any(), anyString(), any());
        assertAuditOutcome("refused");
    }

    // ── task-65: the HUMAN path must be deliverable, and muted must not reach it ─────────────

    @Test
    void humanRespondMutedIsStillNotified() {
        SessionParticipant human = new SessionParticipant(SESSION_ID, "HUMAN", UUID.randomUUID(),
                "MEMBER", 30, "MENTION", SessionParticipant.RESPOND_MUTED);
        human.setId(PARTICIPANT_ID);
        when(participants.findById(PARTICIPANT_ID)).thenReturn(Optional.of(human));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "to", ROUND, SESSION_ID, null);

        assertEquals("notify", result.outcome(),
                "task-65 / user ruling: TO is the important @ — muted must not swallow it");
        assertFalse("skipped_muted".equals(result.outcome()));
        assertAuditOutcome("notify");
    }

    @Test
    void humanNotifyWithoutUserChannelIsMarkedUndeliverableAndLogsError() {
        SessionParticipant human = new SessionParticipant(SESSION_ID, "HUMAN", UUID.randomUUID(),
                "MEMBER", 30, "MENTION", "ALWAYS");
        human.setId(PARTICIPANT_ID);
        when(participants.findById(PARTICIPANT_ID)).thenReturn(Optional.of(human));

        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(
                        WakeDispatchService.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        WakeDispatchService.WakeFireResult result;
        try {
            result = service.fire(PARTICIPANT_ID, "to", ROUND, SESSION_ID, null);
        } finally {
            logger.detachAppender(appender);
        }

        assertEquals("notify", result.outcome(), "the durable notify row is still written");
        assertEquals("notify_hint_unavailable", result.detail(),
                "task-65: a notify nobody can be pushed to is NOT a silent success");
        assertTrue(appender.list.stream().anyMatch(event ->
                        event.getLevel() == ch.qos.logback.classic.Level.ERROR
                                && event.getFormattedMessage().contains("event=notify_undeliverable")),
                () -> "the absent user channel must be loud: " + appender.list);
    }

    @Test
    void humanNotifyWithUserChannelHandsTheHintOverAndReportsNoDetail() {
        SessionParticipant human = new SessionParticipant(SESSION_ID, "HUMAN", UUID.randomUUID(),
                "MEMBER", 30, "MENTION", "ALWAYS");
        human.setId(PARTICIPANT_ID);
        when(participants.findById(PARTICIPANT_ID)).thenReturn(Optional.of(human));
        java.util.List<String> pushed = new java.util.ArrayList<>();
        org.springframework.test.util.ReflectionTestUtils.setField(service, "userChannel",
                new com.cc01cc.p.xihe.cp.event.UserChannelPort() {
                    @Override
                    public void participantNotified(String userId, String sessionId, String participantId) {
                        pushed.add(userId + "/" + sessionId + "/" + participantId);
                    }

                    @Override
                    public void questionChanged(String userId, String questionId, String sessionId,
                                                String state) {
                        // unused here
                    }
                });

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "to", ROUND, SESSION_ID, null);

        assertEquals("notify", result.outcome());
        assertNull(result.detail(), "a handed-over hint needs no detail token");
        assertEquals(java.util.List.of(human.getPrincipalId() + "/" + SESSION_ID + "/" + PARTICIPANT_ID),
                pushed, "the human must actually be reachable through the port");
    }

    @Test
    void humanRecipientIsNotifiedNotRun() {
        // PLAN-0660 T3.1: make the fake speak-as gate actually refuse, the way it always does in
        // production for another human (SessionParticipantService:334-340). Before the fix this drove
        // the recipient to "refused", so the case now really fails if the HUMAN branch ever moves back
        // behind the authorization.
        when(participantService.judgeSpeakAs(anyString(), anyString(), anyString(), anyString()))
                .thenReturn(SessionParticipantService.SpeakDecision.refused("PARTICIPANT_CAP_DENIED"));
        SessionParticipant human = new SessionParticipant(SESSION_ID, "HUMAN", UUID.randomUUID(),
                "MEMBER", 30, "MENTION", "ALWAYS");
        human.setId(PARTICIPANT_ID);
        when(participants.findById(PARTICIPANT_ID)).thenReturn(Optional.of(human));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null);

        assertEquals("notify", result.outcome());
        assertFalse(result.dispatched(), "人=通知：a HUMAN recipient never gets a run");
        // PLAN-0660 T5.3: the notify no longer advances a stored counter — unread is derived from the
        // durable wake_dispatch row (`spec/session/user-channel.md` §3), so there is no cursor write
        // to assert here; the audit outcome below is the observable effect.
        verify(participantService, never()).judgeSpeakAs(anyString(), anyString(), anyString(),
                anyString());
        verify(participantService, never()).authorizeAsParticipant(anyString(), anyString(), anyString(),
                anyString());
        verify(wakeupService, never()).wakeupAs(anyString(), anyString(), anyString(), anyString(),
                anyString(), any(), anyString(), any());
        verifyNoInteractions(chatRuns);
        assertAuditOutcome("notify");
    }

    @Test
    void participantFromAnotherSessionIsRefusedNotNotified() {
        // PLAN-0660 T1.3: a foreign participantId must not be notified/counted in this session's
        // round. The speak-as gate used to be the only participant↔session binding; the HUMAN branch
        // no longer reaches it, so fire() owns that check now.
        SessionParticipant foreign = new SessionParticipant(UUID.randomUUID(), "HUMAN", UUID.randomUUID(),
                "MEMBER", 30, "MENTION", "ALWAYS");
        foreign.setId(PARTICIPANT_ID);
        when(participants.findById(PARTICIPANT_ID)).thenReturn(Optional.of(foreign));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null);

        assertEquals("refused", result.outcome(), "a participant of another session is not a delivery target");
        assertEquals("cross_session", result.detail(),
                "task-60: cross-session targets are refused but NOT user-actionable suppressions");
        verify(wakeupService, never()).wakeupAs(anyString(), anyString(), anyString(), anyString(),
                anyString(), any(), anyString(), any());
        verifyNoInteractions(chatRuns);
        assertAuditOutcome("refused");
    }

    @Test
    void mutedParticipantIsSkippedWithAudit() {
        agent.setRespondPolicy(SessionParticipant.RESPOND_MUTED);

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null);

        assertEquals("skipped_muted", result.outcome());
        assertEquals("respond_policy_muted", result.detail());
        verify(wakeupService, never()).wakeupAs(anyString(), anyString(), anyString(), anyString(),
                anyString(), any(), anyString(), any());
        assertAuditOutcome("skipped_muted");
        assertEquals("respond_policy_muted", auditReason(),
                "task-60: the durable row used to carry reason=null — detail and audit must agree");
    }

    @Test
    void judgeVerdictFalseDoesNotSubmit() throws Exception {
        agent.setRespondPolicy(SessionParticipant.RESPOND_JUDGE);
        stubJudgeInput();
        when(judgeService.decide(any())).thenReturn(
                new JudgeDecisionService.JudgeOutcome(true, "{\"speak\":false}", "succeeded", null));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null);

        assertEquals("judged_no", result.outcome());
        assertEquals("judge_declined", result.detail(), "the verdict answered and said no speak");
        verify(wakeupService, never()).wakeupAs(anyString(), anyString(), anyString(), anyString(),
                anyString(), any(), anyString(), any());
        assertEquals("judge_declined", auditReason(),
                "task-60: judged_no used to audit reason=null, so a decision and a failure looked alike");
    }

    // ── task-60: each producer of refused / judged_no names its own cause (the detail token) ──

    @Test
    void missingParticipantReportsGoneToken() {
        when(participants.findById(PARTICIPANT_ID)).thenReturn(Optional.empty());

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null);

        assertEquals("refused", result.outcome());
        assertEquals("participant_gone", result.detail(),
                "task-60: gone and disabled are distinct causes of the same coarse outcome");
    }

    @Test
    void judgeUnansweredReportsUnansweredToken() {
        agent.setRespondPolicy(SessionParticipant.RESPOND_JUDGE);
        stubJudgeInput();
        when(judgeService.decide(any())).thenReturn(
                new JudgeDecisionService.JudgeOutcome(false, null, "failed", null));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null);

        assertEquals("judged_no", result.outcome());
        assertEquals("judge_unanswered", result.detail(),
                "task-60: a judge that never answered is a failure, not a decision");
    }

    @Test
    void judgeVerdictMalformedReportsVerdictInvalidToken() {
        agent.setRespondPolicy(SessionParticipant.RESPOND_JUDGE);
        stubJudgeInput();
        when(judgeService.decide(any())).thenReturn(
                new JudgeDecisionService.JudgeOutcome(true, "{\"speak\":\"yes\"}", "succeeded", null));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null);

        assertEquals("judged_no", result.outcome());
        assertEquals("verdict_invalid", result.detail());
    }

    @Test
    void judgeCallThrewReportsJudgeErrorToken() {
        agent.setRespondPolicy(SessionParticipant.RESPOND_JUDGE);
        stubJudgeInput();
        when(judgeService.decide(any())).thenThrow(new IllegalStateException("judge down"));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null);

        assertEquals("judged_no", result.outcome(),
                "the coarse outcome is unchanged: this label is exactly why the detail token exists");
        assertEquals("judge_error:IllegalStateException", result.detail(),
                "task-60: a judge that threw cannot be laundered into a decision");
    }

    @Test
    void judgeVerdictTrueSubmitsWithAttribution() throws Exception {
        agent.setRespondPolicy(SessionParticipant.RESPOND_JUDGE);
        stubJudgeInput();
        when(judgeService.decide(any())).thenReturn(
                new JudgeDecisionService.JudgeOutcome(true, "{\"speak\":true}", "succeeded", null));
        when(wakeupService.wakeupAs(anyString(), anyString(), anyString(), anyString(), anyString(),
                any(), eq("mention"), any()))
                .thenReturn(SessionWakeupService.WakeupResult.started(RUN_ID));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null);

        assertTrue(result.dispatched());
        assertEquals(RUN_ID, result.runId());
        assertEquals("submitted", result.outcome());
        verify(wakeupService).wakeupAs(eq(SESSION_ID.toString()), eq("owner-1"), eq("ws-1"), anyString(),
                eq(ROUND), eq(agent.getPrincipalId()), eq("mention"), isNull());
        // CP-2 (PLAN-0690 T1.2b): the judge input is assembled, not inlined in the dispatch path.
        verify(judgeInputAssembler).assemble(eq(session), eq(agent), eq("mention"), eq(ROUND));
        ArgumentCaptor<JudgeDecisionService.JudgeInput> judgeInput =
                ArgumentCaptor.forClass(JudgeDecisionService.JudgeInput.class);
        verify(judgeService).decide(judgeInput.capture());
        assertEquals("(no messages yet)", judgeInput.getValue().inputWindow());
        assertEquals("prompt-stub", judgeInput.getValue().prompt());
        assertAuditOutcome("submitted");
    }

    /** CP-2: the assembler owns window/roster/duty/prompt; this unit only checks the wiring. */
    private void stubJudgeInput() {
        when(judgeInputAssembler.assemble(any(), any(), anyString(), anyString()))
                .thenReturn(new JudgeDecisionService.JudgeInput(SESSION_ID, null, PARTICIPANT_ID, ROUND,
                        "mention", "(no messages yet)", "respondPolicy=JUDGE", "bailian",
                        "decision-model-preview", "prompt-stub"));
    }

    /**
     * BL-283: a Session at its run cap answers {@code deferred} — the wake must come back as a result
     * (never as an exception), the audit keeps {@code outcome=deferred}, and the caller can keep
     * counting it as "queued" instead of "failed".
     */
    @Test
    void capReachedWakeReturnsDeferred_andAuditsDeferred() {
        when(wakeupService.wakeupAs(anyString(), anyString(), anyString(), anyString(), anyString(),
                any(), anyString(), any()))
                .thenReturn(SessionWakeupService.WakeupResult.deferred());

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null);

        assertFalse(result.dispatched());
        assertNull(result.runId());
        assertEquals("deferred", result.outcome());
        assertAuditOutcome("deferred");
    }

    @Test
    void alwaysPolicySubmitsDirectly() {
        when(wakeupService.wakeupAs(anyString(), anyString(), anyString(), anyString(), anyString(),
                any(), eq("schedule"), any()))
                .thenReturn(SessionWakeupService.WakeupResult.started(RUN_ID));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "schedule", ROUND, SESSION_ID, null);

        assertTrue(result.dispatched());
        verify(participantService).judgeSpeakAs(eq("owner-1"), eq("ws-1"),
                eq(SESSION_ID.toString()), eq(PARTICIPANT_ID.toString()));
    }

    /** task-60: the durable row's {@code reason} — it must agree with the response detail token. */
    private String auditReason() {
        ArgumentCaptor<Object> payload = ArgumentCaptor.forClass(Object.class);
        verify(eventStore).append(eq(SESSION_ID.toString()), eq("ws-1"), eq("owner-1"),
                eq("wake_dispatch"), payload.capture());
        com.fasterxml.jackson.databind.node.ObjectNode body =
                (com.fasterxml.jackson.databind.node.ObjectNode) payload.getValue();
        return body.path("reason").asText(null);
    }

    private void assertAuditOutcome(String outcome) {
        ArgumentCaptor<Object> payload = ArgumentCaptor.forClass(Object.class);
        verify(eventStore).append(eq(SESSION_ID.toString()), eq("ws-1"), eq("owner-1"),
                eq("wake_dispatch"), payload.capture());
        com.fasterxml.jackson.databind.node.ObjectNode body = (com.fasterxml.jackson.databind.node.ObjectNode) payload.getValue();
        assertEquals(outcome, body.path("outcome").asText());
        assertEquals(ROUND, body.path("wakeRoundId").asText());
    }
    // ── PLAN-0648 task-31 (P0): the wake prompt must carry the triggering message ──────────

    @Test
    void wakePromptCarriesTheTriggeringMessageBody() {
        stubAgentWake();

        service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null,
                "@Ann 帮我看一下 packages/ui 的构建为什么失败");

        String prompt = capturedPrompt();
        assertTrue(prompt.contains("[mention wake " + ROUND + "]"),
                "the operator/audit marker stays: " + prompt);
        assertTrue(prompt.contains("帮我看一下 packages/ui 的构建为什么失败"),
                "the woken agent must see the ask, not just the wake reference: " + prompt);
        assertTrue(prompt.contains("session=" + SESSION_ID),
                "the prompt self-references the session: " + prompt);
    }

    @Test
    void wakePromptTruncatesLongContentButKeepsTheOpening() {
        stubAgentWake();
        String body = "起点标记".repeat(400) + "结尾标记";

        service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null, body);

        String prompt = capturedPrompt();
        assertTrue(prompt.contains("(truncated)"), "a cut must be visible to the reader: " + prompt);
        assertTrue(prompt.contains("起点标记"), "the opening survives truncation");
        assertTrue(!prompt.contains("结尾标记"), "the tail is what gets dropped");
        assertTrue(prompt.length() < body.length(),
                "the prompt is shorter than the original message");
    }

    @Test
    void wakePromptWithoutContentKeepsTheLegacyReferenceOnlyForm() {
        stubAgentWake();

        service.fire(PARTICIPANT_ID, "schedule", ROUND, SESSION_ID, null, null);

        String prompt = capturedPrompt();
        assertEquals("[schedule wake " + ROUND + "] session=" + SESSION_ID
                + " respond to the conversation.", prompt);
    }

    @Test
    void wakeExcerptUsesTheExistingLogRedactionWithoutErasingTheAsk() {
        stubAgentWake();

        // LogRedactor's documented scope is structured secrets (JSON values, Bearer/JWT/private key),
        // so the assertion uses one of those shapes: the secret goes, the ask stays.
        service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null,
                "把 {\"api_key\":\"sk-live-abc\"} 换掉，然后重跑测试");

        String prompt = capturedPrompt();
        assertTrue(prompt.contains("换掉，然后重跑测试"), "the ask survives redaction: " + prompt);
        assertTrue(!prompt.contains("sk-live-abc"), "a structured secret must never ride the prompt: " + prompt);
        assertTrue(prompt.contains(LogRedactor.REDACTED), "the redaction marker is visible: " + prompt);
    }

    private void stubAgentWake() {
        when(wakeupService.wakeupAs(anyString(), anyString(), anyString(), anyString(), anyString(),
                any(), anyString(), any())).thenReturn(
                SessionWakeupService.WakeupResult.started(RUN_ID));
    }

    private String capturedPrompt() {
        ArgumentCaptor<String> prompt = ArgumentCaptor.forClass(String.class);
        verify(wakeupService).wakeupAs(anyString(), anyString(), anyString(), prompt.capture(),
                anyString(), any(), anyString(), any());
        return prompt.getValue();
    }
}
