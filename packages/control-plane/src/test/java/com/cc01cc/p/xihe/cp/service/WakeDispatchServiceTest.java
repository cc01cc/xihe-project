package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.chat.SessionWakeupService;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.entity.SessionParticipantCursor;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantCursorRepository;
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
    private JudgeDecisionService judgeService;
    private EventStoreService eventStore;
    private SessionParticipantCursorRepository cursors;
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
        judgeService = mock(JudgeDecisionService.class);
        eventStore = mock(EventStoreService.class);
        cursors = mock(SessionParticipantCursorRepository.class);
        chatRuns = mock(ChatRunRepository.class);
        dbLockTimeout = mock(DbLockTimeout.class);
        service = new WakeDispatchService(participants, sessions, participantService, wakeupService,
                judgeService, eventStore, cursors, new ObjectMapper(), chatRuns, dbLockTimeout);

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
        SessionParticipantCursor cursor = new SessionParticipantCursor(PARTICIPANT_ID, 5L, 2);
        when(cursors.findById(PARTICIPANT_ID)).thenReturn(Optional.of(cursor));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null);

        assertEquals("notify", result.outcome());
        assertFalse(result.dispatched(), "人=通知：a HUMAN recipient never gets a run");
        assertEquals(3, cursor.getMentionCount(), "the cursor advances server-side (R7)");
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
        SessionParticipantCursor cursor = new SessionParticipantCursor(PARTICIPANT_ID, 5L, 0);
        when(cursors.findById(PARTICIPANT_ID)).thenReturn(Optional.of(cursor));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null);

        assertEquals("refused", result.outcome(), "a participant of another session is not a delivery target");
        assertEquals(0, cursor.getMentionCount(), "a foreign participant must not advance this cursor");
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
        verify(wakeupService, never()).wakeupAs(anyString(), anyString(), anyString(), anyString(),
                anyString(), any(), anyString(), any());
        assertAuditOutcome("skipped_muted");
    }

    @Test
    void judgeVerdictFalseDoesNotSubmit() throws Exception {
        agent.setRespondPolicy(SessionParticipant.RESPOND_JUDGE);
        when(judgeService.decide(any())).thenReturn(
                new JudgeDecisionService.JudgeOutcome(true, "{\"speak\":false}", "succeeded", null));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID, null);

        assertEquals("judged_no", result.outcome());
        verify(wakeupService, never()).wakeupAs(anyString(), anyString(), anyString(), anyString(),
                anyString(), any(), anyString(), any());
    }

    @Test
    void judgeVerdictTrueSubmitsWithAttribution() throws Exception {
        agent.setRespondPolicy(SessionParticipant.RESPOND_JUDGE);
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
        assertAuditOutcome("submitted");
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
