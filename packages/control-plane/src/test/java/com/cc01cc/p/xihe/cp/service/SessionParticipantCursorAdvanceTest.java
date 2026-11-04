package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
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

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0660 T5.1 / T5.2 — the read cursor contract (`spec/session/user-channel.md` §2/§3).
 *
 * <p>Five frozen behaviours, one test each: advance, idempotent repeat, never regress, clamp to the
 * session's max sequence, and the self-only refusal (AGENT row and "someone else's HUMAN row" both
 * answer {@code 403 CURSOR_SELF_ONLY}). The last two cases also pin the derived unread: the response
 * carries the value the aggregate returns, and advancing can only lower it.</p>
 */
class SessionParticipantCursorAdvanceTest {

    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID PARTICIPANT_ID = UUID.randomUUID();
    private static final UUID HUMAN_ID = UUID.randomUUID();
    private static final String WORKSPACE = "ws-1";
    private static final long MAX_SEQUENCE = 10L;

    private SessionParticipantRepository participants;
    private SessionParticipantCursorRepository cursors;
    private SessionRepository sessions;
    private EventStoreRepository events;
    private SessionParticipantService service;

    private Session session;
    private SessionParticipantCursor cursor;

    @BeforeEach
    void setUp() {
        participants = mock(SessionParticipantRepository.class);
        cursors = mock(SessionParticipantCursorRepository.class);
        sessions = mock(SessionRepository.class);
        events = mock(EventStoreRepository.class);
        service = new SessionParticipantService(participants, cursors, sessions,
                mock(AgentPrincipalRepository.class), mock(UserRepository.class),
                mock(WorkspaceService.class), mock(com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService.class),
                mock(WakeScheduleProjectionService.class), events);

        session = mock(Session.class);
        when(session.getId()).thenReturn(SESSION_ID);
        when(session.getWorkspaceId()).thenReturn(WORKSPACE);
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(session));

        // The clamp ceiling: the session's current max context_events.sequence.
        ContextEvent latest = mock(ContextEvent.class);
        when(latest.getSequence()).thenReturn(MAX_SEQUENCE);
        when(events.findTopBySessionIdOrderBySequenceDesc(SESSION_ID.toString()))
                .thenReturn(Optional.of(latest));

        cursor = new SessionParticipantCursor(PARTICIPANT_ID, 5L);
        when(cursors.findById(PARTICIPANT_ID)).thenReturn(Optional.of(cursor));
        when(cursors.save(any(SessionParticipantCursor.class)))
                .thenAnswer(call -> call.getArgument(0));
    }

    private void givenHuman(UUID principalId) {
        SessionParticipant row = new SessionParticipant(SESSION_ID, SessionParticipant.KIND_HUMAN,
                principalId, SessionParticipant.ROLE_MEMBER, 20,
                SessionParticipant.WAKE_MENTION, SessionParticipant.RESPOND_WHEN_MENTIONED);
        row.setId(PARTICIPANT_ID);
        when(participants.findByIdAndSessionId(PARTICIPANT_ID, SESSION_ID))
                .thenReturn(Optional.of(row));
    }

    private void givenDerivedUnread(int mentions) {
        when(events.countDerivedMentionsBySession(SESSION_ID))
                .thenReturn(List.<Object[]>of(new Object[] {PARTICIPANT_ID, (long) mentions}));
    }

    @Test
    void advanceMovesThePointerForward() {
        givenHuman(HUMAN_ID);
        givenDerivedUnread(2);

        SessionParticipantService.CursorView view = service.advanceCursor(HUMAN_ID.toString(),
                WORKSPACE, SESSION_ID.toString(), PARTICIPANT_ID.toString(), 8L);

        assertEquals(8L, view.lastReadEventSeq(), "the pointer moves to the requested position");
        assertEquals(2, view.mentionCount(), "the wire count is the DERIVED aggregate value");
        assertEquals(8L, cursor.getLastReadEventSeq(), "the row is persisted through the pointer only");
    }

    @Test
    void repeatedAdvanceIsIdempotent() {
        givenHuman(HUMAN_ID);
        givenDerivedUnread(0);

        service.advanceCursor(HUMAN_ID.toString(), WORKSPACE, SESSION_ID.toString(),
                PARTICIPANT_ID.toString(), 8L);
        SessionParticipantService.CursorView second = service.advanceCursor(HUMAN_ID.toString(),
                WORKSPACE, SESSION_ID.toString(), PARTICIPANT_ID.toString(), 8L);

        assertEquals(8L, second.lastReadEventSeq(), "re-advancing to the same position changes nothing");
    }

    @Test
    void aBackwardsRequestNeverRegressesThePointer() {
        givenHuman(HUMAN_ID);
        givenDerivedUnread(1);
        service.advanceCursor(HUMAN_ID.toString(), WORKSPACE, SESSION_ID.toString(),
                PARTICIPANT_ID.toString(), 8L);

        SessionParticipantService.CursorView lower = service.advanceCursor(HUMAN_ID.toString(),
                WORKSPACE, SESSION_ID.toString(), PARTICIPANT_ID.toString(), 3L);

        assertEquals(8L, lower.lastReadEventSeq(), "advance-only: a smaller value is ignored, not applied");
    }

    @Test
    void thePointerIsClampedToTheSessionMaxSequence() {
        givenHuman(HUMAN_ID);
        givenDerivedUnread(0);

        SessionParticipantService.CursorView view = service.advanceCursor(HUMAN_ID.toString(),
                WORKSPACE, SESSION_ID.toString(), PARTICIPANT_ID.toString(), 99L);

        assertEquals(MAX_SEQUENCE, view.lastReadEventSeq(),
                "out-of-range targets clamp to max(context_events.sequence) instead of failing");
    }

    @Test
    void anAgentRowCannotAdvanceAHumanCursor() {
        SessionParticipant agent = new SessionParticipant(SESSION_ID, SessionParticipant.KIND_AGENT,
                HUMANOID_AGENT, SessionParticipant.ROLE_MEMBER, 20,
                SessionParticipant.WAKE_MENTION, SessionParticipant.RESPOND_WHEN_MENTIONED);
        agent.setId(PARTICIPANT_ID);
        when(participants.findByIdAndSessionId(PARTICIPANT_ID, SESSION_ID))
                .thenReturn(Optional.of(agent));

        CpApiException refusal = assertThrows(CpApiException.class, () -> service.advanceCursor(
                HUMANOID_AGENT.toString(), WORKSPACE, SESSION_ID.toString(),
                PARTICIPANT_ID.toString(), 8L));

        assertEquals("CURSOR_SELF_ONLY", refusal.getCode());
        assertEquals(403, refusal.getStatus().value());
        assertEquals(5L, cursor.getLastReadEventSeq(), "a refused call must not touch the pointer");
    }

    @Test
    void anotherHumansCursorCannotBeAdvanced() {
        givenHuman(HUMAN_ID);
        UUID intruder = UUID.randomUUID();

        CpApiException refusal = assertThrows(CpApiException.class, () -> service.advanceCursor(
                intruder.toString(), WORKSPACE, SESSION_ID.toString(), PARTICIPANT_ID.toString(), 8L));

        assertEquals("CURSOR_SELF_ONLY", refusal.getCode(),
                "a HUMAN row is self-only: another account cannot mark it read");
        assertEquals(5L, cursor.getLastReadEventSeq(), "and the pointer stays where it was");
    }

    @Test
    void advancingOnlyEverLowersTheDerivedUnread() {
        givenHuman(HUMAN_ID);
        givenDerivedUnread(3);
        SessionParticipantService.CursorView before = service.advanceCursor(HUMAN_ID.toString(),
                WORKSPACE, SESSION_ID.toString(), PARTICIPANT_ID.toString(), 5L);

        // The aggregate no longer counts the two notifies the pointer just passed (T5.2 derivation).
        givenDerivedUnread(1);
        SessionParticipantService.CursorView after = service.advanceCursor(HUMAN_ID.toString(),
                WORKSPACE, SESSION_ID.toString(), PARTICIPANT_ID.toString(), 9L);

        assertEquals(3, before.mentionCount());
        assertEquals(1, after.mentionCount(), "unread is derived from the pointer, so it can only drop");
        assertTrue(after.mentionCount() < before.mentionCount(),
                "a counter would stay flat or grow here; the derived value must fall");
    }

    /** An agent principal id for the AGENT-row case (never a human). */
    private static final UUID HUMANOID_AGENT = UUID.randomUUID();
}
