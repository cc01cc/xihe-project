package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantCursorRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0668 D1/V1.4: the roster face and the read face consume ONE decision. This table pins the
 * two documented shapes: read = owner ∨ invited (manager excluded, D1b); roster = owner ∨ invited
 * ∨ manager (shipped contract, D2).
 */
class SessionReadAccessParityTest {

    private static final String WORKSPACE = UUID.randomUUID().toString();
    private static final String OWNER = UUID.randomUUID().toString();
    private static final String INVITED = UUID.randomUUID().toString();
    private static final String MANAGER = UUID.randomUUID().toString();
    private static final String STRANGER = UUID.randomUUID().toString();
    private static final UUID SESSION_ID = UUID.randomUUID();

    private SessionRepository sessions;
    private SessionParticipantRepository participants;
    private WorkspaceService workspaces;
    private GrantAuthorizationService grants;
    private SessionReadAccess access;
    private SessionParticipantService participantService;
    private Session session;

    @BeforeEach
    void setUp() {
        sessions = mock(SessionRepository.class);
        participants = mock(SessionParticipantRepository.class);
        SessionParticipantCursorRepository cursors = mock(SessionParticipantCursorRepository.class);
        AgentPrincipalRepository agents = mock(AgentPrincipalRepository.class);
        UserRepository users = mock(UserRepository.class);
        workspaces = mock(WorkspaceService.class);
        grants = mock(GrantAuthorizationService.class);
        com.cc01cc.p.xihe.cp.scheduled.WakeScheduleProjectionService wakeProjection =
                mock(com.cc01cc.p.xihe.cp.scheduled.WakeScheduleProjectionService.class);
        com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository events =
                mock(com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository.class);
        when(participants.findBySessionIdOrderByOrderIndexAsc(SESSION_ID)).thenReturn(List.of());
        when(cursors.findByParticipantIdIn(any())).thenReturn(List.of());

        access = new SessionReadAccess(sessions, participants, workspaces, grants);
        participantService = new SessionParticipantService(participants, cursors, sessions, agents, users,
                workspaces, grants, wakeProjection, events, access);

        session = mock(Session.class);
        when(session.getId()).thenReturn(SESSION_ID);
        when(session.getWorkspaceId()).thenReturn(WORKSPACE);
        when(session.getUserId()).thenReturn(OWNER);
        when(session.isArchived()).thenReturn(false);
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(session));
    }

    /** The documented decision table for one actor. */
    private record Case(String actor, boolean invited, boolean manager,
                        boolean readAllowed, boolean rosterAllowed) {
    }

    private void arrange(Case testCase) {
        when(participants.existsBySessionIdAndPrincipalKindAndPrincipalIdAndDisabledAtIsNull(
                any(), any(), any())).thenReturn(testCase.invited());
        when(grants.allowsUserOnly(any())).thenReturn(testCase.manager());
        when(workspaces.isWorkspaceMember(any(), any())).thenReturn(true);
    }

    private String readOutcome(String actor) {
        try {
            access.requireReadable(actor, WORKSPACE, SESSION_ID.toString());
            return "ok";
        } catch (CpApiException error) {
            return error.getCode();
        }
    }

    private String rosterOutcome(String actor) {
        try {
            participantService.list(actor, WORKSPACE, SESSION_ID.toString());
            return "ok";
        } catch (CpApiException error) {
            return error.getCode();
        }
    }

    @Test
    void rosterAndReadFacesAgreeWithTheirDocumentedDecisionTable() {
        List<Case> cases = List.of(
                new Case(OWNER, false, false, true, true),
                new Case(INVITED, true, false, true, true),
                // D1b: managers keep the roster read but never the content read.
                new Case(MANAGER, false, true, false, true),
                new Case(STRANGER, false, false, false, false));

        for (Case testCase : cases) {
            setUp();
            arrange(testCase);

            String read = readOutcome(testCase.actor());
            String roster = rosterOutcome(testCase.actor());
            assertEquals(testCase.readAllowed() ? "ok" : "SESSION_NOT_FOUND", read,
                    "read face outcome for " + testCase.actor());
            assertEquals(testCase.rosterAllowed() ? "ok" : "SESSION_ACCESS_DENIED", roster,
                    "roster face outcome for " + testCase.actor());
        }
    }

    @Test
    void readGuardAndOwnerGuardShareTheSameResolvedPrimitive() {
        setUp();
        arrange(new Case(INVITED, true, false, true, true));

        SessionReadAccess.Resolved resolved = access.resolve(INVITED, WORKSPACE, SESSION_ID.toString());
        assertEquals(resolved.access().owner(), false);
        assertEquals(resolved.access().invitedHuman(), true);
        assertEquals("ok", readOutcome(INVITED));
        assertThrows(CpApiException.class,
                () -> access.requireOwned(INVITED, WORKSPACE, SESSION_ID.toString()));
    }
}
