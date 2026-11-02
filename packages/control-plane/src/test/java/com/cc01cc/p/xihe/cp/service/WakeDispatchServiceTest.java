package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.chat.SessionWakeupService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.entity.SessionParticipantCursor;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantCursorRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
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
        service = new WakeDispatchService(participants, sessions, participantService, wakeupService,
                judgeService, eventStore, cursors, new ObjectMapper());

        session = mock(Session.class);
        when(session.getUserId()).thenReturn("owner-1");
        when(session.getWorkspaceId()).thenReturn("ws-1");
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(session));
        agent = new SessionParticipant(SESSION_ID, "AGENT", UUID.randomUUID(), "MEMBER", 20,
                "MENTION", "ALWAYS");
        when(participants.findById(PARTICIPANT_ID)).thenReturn(Optional.of(agent));
    }

    @Test
    void disabledParticipantIsRefusedAndAudited() {
        agent.setDisabledAt(java.time.Instant.now());

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID);

        assertEquals("refused", result.outcome());
        verify(wakeupService, never()).wakeupAs(anyString(), anyString(), anyString(), anyString(),
                anyString(), any(), anyString());
        assertAuditOutcome("refused");
    }

    @Test
    void systemTriggeredStillNeedsAuthorization() {
        org.mockito.Mockito.doThrow(new CpApiException(HttpStatus.FORBIDDEN,
                "PARTICIPANT_IMPERSONATION_FORBIDDEN", "no"))
                .when(participantService).authorizeAsParticipant(anyString(), anyString(), anyString(),
                        anyString());

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "schedule", ROUND, SESSION_ID);

        assertEquals("refused", result.outcome(), "D23-08: a wake never bypasses --as authorization");
        verify(wakeupService, never()).wakeupAs(anyString(), anyString(), anyString(), anyString(),
                anyString(), any(), anyString());
        assertAuditOutcome("refused");
    }

    @Test
    void humanRecipientIsNotifiedNotRun() {
        SessionParticipant human = new SessionParticipant(SESSION_ID, "HUMAN", UUID.randomUUID(),
                "MEMBER", 30, "MENTION", "ALWAYS");
        human.setId(PARTICIPANT_ID);
        when(participants.findById(PARTICIPANT_ID)).thenReturn(Optional.of(human));
        SessionParticipantCursor cursor = new SessionParticipantCursor(PARTICIPANT_ID, 5L, 2);
        when(cursors.findById(PARTICIPANT_ID)).thenReturn(Optional.of(cursor));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID);

        assertEquals("notify", result.outcome());
        assertFalse(result.dispatched(), "人=通知：a HUMAN recipient never gets a run");
        assertEquals(3, cursor.getMentionCount(), "the cursor advances server-side (R7)");
        verify(wakeupService, never()).wakeupAs(anyString(), anyString(), anyString(), anyString(),
                anyString(), any(), anyString());
        assertAuditOutcome("notify");
    }

    @Test
    void mutedParticipantIsSkippedWithAudit() {
        agent.setRespondPolicy(SessionParticipant.RESPOND_MUTED);

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID);

        assertEquals("skipped_muted", result.outcome());
        verify(wakeupService, never()).wakeupAs(anyString(), anyString(), anyString(), anyString(),
                anyString(), any(), anyString());
        assertAuditOutcome("skipped_muted");
    }

    @Test
    void judgeVerdictFalseDoesNotSubmit() throws Exception {
        agent.setRespondPolicy(SessionParticipant.RESPOND_JUDGE);
        when(judgeService.decide(any())).thenReturn(
                new JudgeDecisionService.JudgeOutcome(true, "{\"speak\":false}", "succeeded", null));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID);

        assertEquals("judged_no", result.outcome());
        verify(wakeupService, never()).wakeupAs(anyString(), anyString(), anyString(), anyString(),
                anyString(), any(), anyString());
    }

    @Test
    void judgeVerdictTrueSubmitsWithAttribution() throws Exception {
        agent.setRespondPolicy(SessionParticipant.RESPOND_JUDGE);
        when(judgeService.decide(any())).thenReturn(
                new JudgeDecisionService.JudgeOutcome(true, "{\"speak\":true}", "succeeded", null));
        when(wakeupService.wakeupAs(anyString(), anyString(), anyString(), anyString(), anyString(),
                eq(PARTICIPANT_ID), eq("mention")))
                .thenReturn(SessionWakeupService.WakeupResult.started(RUN_ID));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "mention", ROUND, SESSION_ID);

        assertTrue(result.dispatched());
        assertEquals(RUN_ID, result.runId());
        assertEquals("submitted", result.outcome());
        verify(wakeupService).wakeupAs(eq(SESSION_ID.toString()), eq("owner-1"), eq("ws-1"), anyString(),
                eq(ROUND), eq(PARTICIPANT_ID), eq("mention"));
        assertAuditOutcome("submitted");
    }

    @Test
    void alwaysPolicySubmitsDirectly() {
        when(wakeupService.wakeupAs(anyString(), anyString(), anyString(), anyString(), anyString(),
                eq(PARTICIPANT_ID), eq("schedule")))
                .thenReturn(SessionWakeupService.WakeupResult.started(RUN_ID));

        WakeDispatchService.WakeFireResult result = service.fire(PARTICIPANT_ID, "schedule", ROUND, SESSION_ID);

        assertTrue(result.dispatched());
        verify(participantService).authorizeAsParticipant(eq("owner-1"), eq("ws-1"),
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
}
