package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionBranch;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionBranchRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0668 BL-298: the branch list is a read face. An invited HUMAN must be able to read the
 * branch path (UI needs it before it can load messages), while non-participants/cross-workspace
 * callers still get the single 404 and the owner path is unchanged. Branch creation stays
 * owner-only — this test pins the list read only.
 */
class SessionBranchActionServiceReadAccessTest {

    private static final String WORKSPACE = UUID.randomUUID().toString();
    private static final String OTHER_WORKSPACE = UUID.randomUUID().toString();
    private static final String OWNER = UUID.randomUUID().toString();
    private static final String INVITED = UUID.randomUUID().toString();
    private static final String STRANGER = UUID.randomUUID().toString();
    private static final UUID SESSION_ID = UUID.randomUUID();

    private SessionService sessionService;
    private SessionBranchRepository branchRepository;
    private SessionParticipantRepository participants;
    private WorkspaceService workspaces;
    private GrantAuthorizationService grants;
    private SessionBranchActionService service;
    private Session session;
    private SessionRepository sessions;

    @BeforeEach
    void setUp() {
        sessionService = mock(SessionService.class);
        branchRepository = mock(SessionBranchRepository.class);
        SessionParticipantRepository participantRepository = mock(SessionParticipantRepository.class);
        SessionRepository sessions = mock(SessionRepository.class);
        this.sessions = sessions;
        workspaces = mock(WorkspaceService.class);
        grants = mock(GrantAuthorizationService.class);
        participants = participantRepository;
        SessionReadAccess access = new SessionReadAccess(sessions, participantRepository, workspaces, grants);

        service = new SessionBranchActionService(sessionService, branchRepository,
                mock(ChatRunRepository.class), mock(BranchPathService.class),
                mock(DbLockTimeout.class), access);

        session = mock(Session.class);
        when(session.getId()).thenReturn(SESSION_ID);
        when(session.getWorkspaceId()).thenReturn(WORKSPACE);
        when(session.getUserId()).thenReturn(OWNER);
        when(session.isArchived()).thenReturn(false);
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(session));
        when(branchRepository.findBySessionIdOrderByCreatedAtAscIdAsc(SESSION_ID.toString()))
                .thenReturn(List.of(new SessionBranch(UUID.randomUUID(), SESSION_ID.toString())));
    }

    @Test
    void invitedHumanCanListBranchesThroughReadablePrimitive() {
        when(participants.existsBySessionIdAndPrincipalKindAndPrincipalIdAndDisabledAtIsNull(
                SESSION_ID, SessionParticipant.KIND_HUMAN, UUID.fromString(INVITED))).thenReturn(true);

        SessionBranchActionService.BranchList list = service.list(SESSION_ID.toString(), INVITED, WORKSPACE);

        assertEquals(SESSION_ID.toString(), list.sessionId());
        assertEquals(1, list.items().size());
        // BL-298: the branch list must not go through the owner-only requireCurrent anymore.
        verify(sessionService, never()).requireCurrent(any(), any(), any());
    }

    @Test
    void ownerBehaviorIsUnchanged() {

        SessionBranchActionService.BranchList list = service.list(SESSION_ID.toString(), OWNER, WORKSPACE);

        assertEquals(1, list.items().size());
        verify(sessionService, never()).requireCurrent(any(), any(), any());
    }

    @Test
    void nonParticipantGetsSingleNotFound() {
        when(participants.existsBySessionIdAndPrincipalKindAndPrincipalIdAndDisabledAtIsNull(
                any(), any(), any())).thenReturn(false);
        when(grants.allowsUserOnly(any())).thenReturn(false);
        when(workspaces.isWorkspaceMember(WORKSPACE, STRANGER)).thenReturn(true);

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.list(SESSION_ID.toString(), STRANGER, WORKSPACE));
        assertEquals(HttpStatus.NOT_FOUND, error.getStatus());
        assertEquals("SESSION_NOT_FOUND", error.getCode());
    }

    @Test
    void crossWorkspaceGetsSingleNotFound() {
        when(participants.existsBySessionIdAndPrincipalKindAndPrincipalIdAndDisabledAtIsNull(
                any(), any(), any())).thenReturn(true);

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.list(SESSION_ID.toString(), INVITED, OTHER_WORKSPACE));
        assertEquals(HttpStatus.NOT_FOUND, error.getStatus());
        assertEquals("SESSION_NOT_FOUND", error.getCode());
    }
}
