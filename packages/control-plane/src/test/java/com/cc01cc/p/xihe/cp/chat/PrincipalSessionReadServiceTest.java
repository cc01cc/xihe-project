package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceMemberService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * task-19: the principal-scoped read face must count <b>every</b> participant role (PRIMARY/MEMBER/
 * GUARD) from the participant table, never cap counts by the page limit, and redact content per row
 * without removing the row from the count.
 */
class PrincipalSessionReadServiceTest {

    private static final UUID WORKSPACE = UUID.fromString("66666666-6666-6666-6666-666666666666");
    private static final String OWNER = "11111111-1111-1111-1111-111111111111";
    private static final String OUTSIDER = "22222222-2222-2222-2222-222222222222";
    private static final UUID PRINCIPAL =
            UUID.fromString("33333333-3333-3333-3333-333333333333");

    private SessionRepository sessions;
    private SessionParticipantRepository participants;
    private WorkspaceMemberService memberService;
    private PrincipalSessionReadService service;

    @BeforeEach
    void setUp() {
        sessions = mock(SessionRepository.class);
        participants = mock(SessionParticipantRepository.class);
        memberService = mock(WorkspaceMemberService.class);
        service = new PrincipalSessionReadService(sessions, participants, memberService);
        // Unknown principal defaults: no participant rows in any role.
        when(participants.findByPrincipalKindAndPrincipalIdAndRole(any(), any(), any()))
                .thenReturn(List.of());
        when(participants.findBySessionIdInAndPrincipalKindAndPrincipalIdAndDisabledAtIsNull(
                any(), any(), any())).thenReturn(List.of());
    }

    @Test
    void countsEveryParticipantRoleAndKeepsCountsCompleteUnderLimit() {
        Session primary = session("aaaaaaaa-0000-4000-8000-000000000001", "PRIMARY one",
                Instant.parse("2026-11-20T10:00:00Z"), false);
        Session member = session("aaaaaaaa-0000-4000-8000-000000000002", "MEMBER two",
                Instant.parse("2026-11-21T10:00:00Z"), false);
        Session guard = session("aaaaaaaa-0000-4000-8000-000000000003", "GUARD three",
                Instant.parse("2026-11-22T10:00:00Z"), false);
        stubRole(SessionParticipant.ROLE_PRIMARY, participant(primary.getId(), "PRIMARY", null));
        stubRole(SessionParticipant.ROLE_MEMBER, participant(member.getId(), "MEMBER", null));
        stubRole(SessionParticipant.ROLE_GUARD, participant(guard.getId(), "GUARD", null));
        when(sessions.findAllById(any())).thenReturn(List.of(primary, member, guard));

        PrincipalSessionReadService.Response response =
                service.read(OWNER, WORKSPACE, PRINCIPAL, false, 1);

        assertEquals(new PrincipalSessionReadService.Counts(3, 1, 1, 1), response.counts());
        assertEquals(1, response.sessions().size(), "limit caps rows, never counts");
        assertTrue(response.truncated());
        assertEquals(1, response.limit());
        // Newest createdAt first.
        assertEquals("GUARD three", response.sessions().get(0).title());
        assertEquals("GUARD", response.sessions().get(0).role());
        verify(memberService).requireRosterRead(WORKSPACE.toString(), OWNER);
    }

    @Test
    void redactsTitleForUnreadableRowWithoutDroppingItFromCounts() {
        Session hidden = session("bbbbbbbb-0000-4000-8000-000000000001", "someone else's chat",
                Instant.parse("2026-11-22T10:00:00Z"), false);
        stubRole(SessionParticipant.ROLE_MEMBER, participant(hidden.getId(), "MEMBER", null));
        when(sessions.findAllById(any())).thenReturn(List.of(hidden));

        PrincipalSessionReadService.Response response =
                service.read(OUTSIDER, WORKSPACE, PRINCIPAL, false, null);

        assertEquals(1, response.counts().all());
        assertEquals(1, response.sessions().size());
        assertFalse(response.sessions().get(0).readable());
        assertNull(response.sessions().get(0).title());
    }

    @Test
    void disabledParticipantRowsDoNotCount() {
        Session session = session("cccccccc-0000-4000-8000-000000000001", "removed subject",
                Instant.parse("2026-11-22T10:00:00Z"), false);
        stubRole(SessionParticipant.ROLE_MEMBER,
                participant(session.getId(), "MEMBER", Instant.parse("2026-11-22T11:00:00Z")));

        PrincipalSessionReadService.Response response =
                service.read(OWNER, WORKSPACE, PRINCIPAL, false, null);

        assertEquals(0, response.counts().all());
        assertTrue(response.sessions().isEmpty());
        verify(sessions, never()).findAllById(any());
    }

    @Test
    void filtersOtherWorkspacesAndArchivedUnlessOptedIn() {
        Session inWorkspace = session("dddddddd-0000-4000-8000-000000000001", "here",
                Instant.parse("2026-11-22T10:00:00Z"), false);
        Session archived = session("dddddddd-0000-4000-8000-000000000002", "archived",
                Instant.parse("2026-11-21T10:00:00Z"), true);
        Session otherWorkspace = session("dddddddd-0000-4000-8000-000000000003", "elsewhere",
                Instant.parse("2026-11-20T10:00:00Z"), false);
        otherWorkspace.setWorkspaceId("77777777-7777-7777-7777-777777777777");
        stubRole(SessionParticipant.ROLE_PRIMARY, participant(inWorkspace.getId(), "PRIMARY", null));
        stubRole(SessionParticipant.ROLE_MEMBER, participant(archived.getId(), "MEMBER", null));
        stubRole(SessionParticipant.ROLE_GUARD, participant(otherWorkspace.getId(), "GUARD", null));
        when(sessions.findAllById(any()))
                .thenReturn(List.of(inWorkspace, archived, otherWorkspace));

        PrincipalSessionReadService.Response defaultView =
                service.read(OWNER, WORKSPACE, PRINCIPAL, false, null);
        assertEquals(1, defaultView.counts().all());
        assertEquals("here", defaultView.sessions().get(0).title());

        PrincipalSessionReadService.Response withArchived =
                service.read(OWNER, WORKSPACE, PRINCIPAL, true, null);
        assertEquals(2, withArchived.counts().all(), "other-workspace row stays excluded");
        assertEquals(2, withArchived.sessions().size());
    }

    @Test
    void unknownPrincipalAnswersEmptyCohortWithZeroCounts() {
        PrincipalSessionReadService.Response response =
                service.read(OWNER, WORKSPACE, PRINCIPAL, false, null);

        assertEquals(new PrincipalSessionReadService.Counts(0, 0, 0, 0), response.counts());
        assertTrue(response.sessions().isEmpty());
        assertFalse(response.truncated());
    }

    @Test
    void rejectsLimitOutsideTheContractRange() {
        CpApiException tooSmall = assertThrows(CpApiException.class,
                () -> service.read(OWNER, WORKSPACE, PRINCIPAL, false, 0));
        assertEquals("INVALID_REQUEST", tooSmall.getCode());
        CpApiException tooLarge = assertThrows(CpApiException.class,
                () -> service.read(OWNER, WORKSPACE, PRINCIPAL, false, 501));
        assertEquals("INVALID_REQUEST", tooLarge.getCode());
    }

    private void stubRole(String role, SessionParticipant... rows) {
        when(participants.findByPrincipalKindAndPrincipalIdAndRole(
                eq(SessionParticipant.KIND_AGENT), eq(PRINCIPAL), eq(role)))
                .thenReturn(new ArrayList<>(List.of(rows)));
    }

    private static SessionParticipant participant(UUID sessionId, String role, Instant disabledAt) {
        SessionParticipant participant = new SessionParticipant(sessionId,
                SessionParticipant.KIND_AGENT, PRINCIPAL, role, 10,
                SessionParticipant.WAKE_ALL_MESSAGES, SessionParticipant.RESPOND_ALWAYS);
        participant.setId(UUID.randomUUID());
        participant.setDisabledAt(disabledAt);
        return participant;
    }

    private static Session session(String id, String title, Instant createdAt, boolean archived) {
        Session session = new Session();
        session.setId(UUID.fromString(id));
        session.setWorkspaceId(WORKSPACE.toString());
        session.setUserId(OWNER);
        session.setTitle(title);
        session.setKind(Session.KIND_SPAWN);
        session.setArchived(archived);
        session.setCreatedAt(createdAt);
        session.setUpdatedAt(createdAt);
        return session;
    }
}
