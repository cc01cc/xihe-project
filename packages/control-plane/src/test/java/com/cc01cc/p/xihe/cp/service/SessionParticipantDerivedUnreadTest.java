package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.entity.SessionParticipantCursor;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantCursorRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.scheduled.WakeScheduleProjectionService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0660 T5.2b — the derived unread count must equal the value the retired counter would hold,
 * and must fall (never grow) when the pointer advances.
 *
 * <p>T5.2b is the second leg of the four-leg equivalence check the Lead asked for: the stored column is
 * gone (V112), so the pre-drop semantics are re-created <b>here, literally</b>, from its two sources —
 * V92's "default 0" plus the two increment sites that T5.3 removed
 * ({@code WakeDispatchService.notifyHuman}, {@code WakeFanOutService.notifyObserver}) — and compared
 * against the derived count the service returns.</p>
 *
 * <p>Why this is not circular: the reference value below counts notify events **from the moment the
 * cursor was created** (V92 backfills {@code last_read_event_seq} with the session's max sequence, so
 * "joined at sequence J" ⇒ every later notify is an increment). The derived value instead filters by
 * the <b>current</b> pointer. They agree while the pointer has not moved, and they diverge exactly as
 * designed once it does — both facts are asserted.</p>
 *
 * <p>Scope note (BL-273): the counting logic is Java and is exercised here for real; the SQL/H2 path is
 * covered by {@code ChatControllerTest} on the H2 lane, which is where a dialect mistake would surface.</p>
 */
class SessionParticipantDerivedUnreadTest {

    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID PARTICIPANT_ID = UUID.randomUUID();
    private static final UUID HUMAN_ID = UUID.randomUUID();
    private static final String WORKSPACE = "ws-1";

    private SessionParticipantCursorRepository cursors;
    private EventStoreRepository events;
    private SessionParticipantService service;

    @BeforeEach
    void setUp() {
        SessionParticipantRepository participants = mock(SessionParticipantRepository.class);
        cursors = mock(SessionParticipantCursorRepository.class);
        SessionRepository sessions = mock(SessionRepository.class);
        events = mock(EventStoreRepository.class);
        service = new SessionParticipantService(participants, cursors, sessions,
                mock(AgentPrincipalRepository.class), mock(UserRepository.class),
                mock(WorkspaceService.class), mock(com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService.class),
                mock(WakeScheduleProjectionService.class), events);

        Session session = mock(Session.class);
        when(session.getId()).thenReturn(SESSION_ID);
        when(session.getWorkspaceId()).thenReturn(WORKSPACE);
        when(session.getUserId()).thenReturn(HUMAN_ID.toString());
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(session));

        SessionParticipant row = new SessionParticipant(SESSION_ID, SessionParticipant.KIND_HUMAN,
                HUMAN_ID, SessionParticipant.ROLE_MEMBER, 20,
                SessionParticipant.WAKE_MENTION, SessionParticipant.RESPOND_WHEN_MENTIONED);
        row.setId(PARTICIPANT_ID);
        when(participants.findByIdAndSessionId(PARTICIPANT_ID, SESSION_ID))
                .thenReturn(Optional.of(row));
        when(cursors.findByParticipantIdIn(any())).thenReturn(List.of());
        when(cursors.save(any(SessionParticipantCursor.class))).thenAnswer(call -> call.getArgument(0));

        // The participant joined at sequence 10 (V92: the cursor starts at the session's max sequence).
        // Three notifies follow: 11 and 13 are past the join point, 12 belongs to someone else.
        final UUID someoneElse = UUID.randomUUID();
        List<ContextEvent> sessionEvents = List.of(
                notify(11L, PARTICIPANT_ID),
                notify(12L, someoneElse),
                notify(13L, PARTICIPANT_ID));
        when(events.findBySessionIdAndEventTypeOrderBySequenceAsc(anyString(), anyString()))
                .thenReturn(sessionEvents);
        ContextEvent latest = mock(ContextEvent.class);
        when(latest.getSequence()).thenReturn(20L);
        when(events.findTopBySessionIdOrderBySequenceDesc(SESSION_ID.toString()))
                .thenReturn(Optional.of(latest));
    }

    private static ContextEvent notify(long sequence, UUID participantId) {
        ContextEvent event = mock(ContextEvent.class);
        when(event.getSequence()).thenReturn(sequence);
        when(event.getPayload()).thenReturn("{\"outcome\":\"notify\",\"participantId\":\""
                + participantId + "\"}");
        return event;
    }

    /**
     * The pre-drop semantics, spelled out literally: start at 0 (V92 default) and add one per notify
     * this participant received at or after the join sequence. This is the value a counter would hold.
     */
    private static int preDropCounterValue(long joinSequence, List<Long> notifySequences) {
        int value = 0;
        for (long sequence : notifySequences) {
            if (sequence >= joinSequence) {
                value += 1;
            }
        }
        return value;
    }

    @Test
    void derivedUnreadEqualsTheRetiredCounterWhileThePointerHasNotMoved() {
        when(cursors.findById(PARTICIPANT_ID))
                .thenReturn(Optional.of(new SessionParticipantCursor(PARTICIPANT_ID, 10L)));

        SessionParticipantService.CursorView view = service.advanceCursor(HUMAN_ID.toString(),
                WORKSPACE, SESSION_ID.toString(), PARTICIPANT_ID.toString(), 10L);

        int counter = preDropCounterValue(10L, List.of(11L, 13L));
        assertEquals(2, counter, "the counter would hold 2");
        assertEquals(counter, view.mentionCount(),
                "T5.2b: the derived value equals what the retired counter would hold");
    }

    @Test
    void advancingPastANotifyLowersTheDerivedValueWhileACounterWouldNot() {
        when(cursors.findById(PARTICIPANT_ID))
                .thenReturn(Optional.of(new SessionParticipantCursor(PARTICIPANT_ID, 10L)));
        SessionParticipantService.CursorView before = service.advanceCursor(HUMAN_ID.toString(),
                WORKSPACE, SESSION_ID.toString(), PARTICIPANT_ID.toString(), 10L);

        SessionParticipantService.CursorView after = service.advanceCursor(HUMAN_ID.toString(),
                WORKSPACE, SESSION_ID.toString(), PARTICIPANT_ID.toString(), 12L);

        assertEquals(2, before.mentionCount());
        assertEquals(1, after.mentionCount(),
                "moving the pointer past sequence 11 leaves only the notify at 13 unread");
        assertEquals(2, preDropCounterValue(10L, List.of(11L, 13L)),
                "a stored counter would still read 2 — the derived value is the only one that can fall");
    }

    @Test
    void otherParticipantsNotifiesAreNeverCounted() {
        when(cursors.findById(PARTICIPANT_ID))
                .thenReturn(Optional.of(new SessionParticipantCursor(PARTICIPANT_ID, 10L)));

        SessionParticipantService.CursorView view = service.advanceCursor(HUMAN_ID.toString(),
                WORKSPACE, SESSION_ID.toString(), PARTICIPANT_ID.toString(), 10L);

        assertEquals(2, view.mentionCount(),
                "3 notify rows exist, but only 2 target this participant (the 12 one is someone else's)");
    }

    @Test
    void nonNotifyOutcomesAndMalformedPayloadsAreIgnored() {
        ContextEvent otherOutcome = mock(ContextEvent.class);
        when(otherOutcome.getSequence()).thenReturn(14L);
        when(otherOutcome.getPayload()).thenReturn("{\"outcome\":\"refused\",\"participantId\":\""
                + PARTICIPANT_ID + "\"}");
        ContextEvent malformed = mock(ContextEvent.class);
        when(malformed.getSequence()).thenReturn(15L);
        when(malformed.getPayload()).thenReturn("not-json");
        List<ContextEvent> rows = new ArrayList<>(List.of(notify(11L, PARTICIPANT_ID),
                notify(13L, PARTICIPANT_ID), otherOutcome, malformed));
        when(events.findBySessionIdAndEventTypeOrderBySequenceAsc(anyString(), anyString()))
                .thenReturn(rows);
        when(cursors.findById(PARTICIPANT_ID))
                .thenReturn(Optional.of(new SessionParticipantCursor(PARTICIPANT_ID, 10L)));

        SessionParticipantService.CursorView view = service.advanceCursor(HUMAN_ID.toString(),
                WORKSPACE, SESSION_ID.toString(), PARTICIPANT_ID.toString(), 10L);

        assertEquals(2, view.mentionCount(),
                "only notify rows for this participant count; a refused row and a broken payload do not");
    }
}
