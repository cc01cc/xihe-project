package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0668 D1/D1b: the single visibility primitive. Owner/invited/manager classification and
 * the two guard modes are pinned here; the roster-vs-read parity table lives in
 * {@link SessionReadAccessParityTest}.
 */
class SessionReadAccessTest {

    private static final String WORKSPACE = UUID.randomUUID().toString();
    private static final String OTHER_WORKSPACE = UUID.randomUUID().toString();
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
    private Session session;

    @BeforeEach
    void setUp() {
        sessions = mock(SessionRepository.class);
        participants = mock(SessionParticipantRepository.class);
        workspaces = mock(WorkspaceService.class);
        grants = mock(GrantAuthorizationService.class);
        access = new SessionReadAccess(sessions, participants, workspaces, grants);

        session = mock(Session.class);
        when(session.getId()).thenReturn(SESSION_ID);
        when(session.getWorkspaceId()).thenReturn(WORKSPACE);
        when(session.getUserId()).thenReturn(OWNER);
        when(session.isArchived()).thenReturn(false);
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(session));
    }

    @Test
    void ownerIsOwnerAndReadable() {
        SessionReadAccess.Resolved resolved = access.resolve(OWNER, WORKSPACE, SESSION_ID.toString());

        assertTrue(resolved.access().owner());
        assertFalse(resolved.access().invitedHuman());
        assertFalse(resolved.access().manager());
        assertTrue(resolved.access().readAllowed());
        assertTrue(resolved.access().rosterAllowed());
        assertSame(session, access.requireOwned(OWNER, WORKSPACE, SESSION_ID.toString()));
        assertSame(session, access.requireReadable(OWNER, WORKSPACE, SESSION_ID.toString()));
    }

    @Test
    void invitedHumanIsReadableButNotOwner() {
        when(participants.existsBySessionIdAndPrincipalKindAndPrincipalIdAndDisabledAtIsNull(
                SESSION_ID, SessionParticipant.KIND_HUMAN, UUID.fromString(INVITED))).thenReturn(true);

        SessionReadAccess.Resolved resolved = access.resolve(INVITED, WORKSPACE, SESSION_ID.toString());

        assertFalse(resolved.access().owner());
        assertTrue(resolved.access().invitedHuman());
        assertFalse(resolved.access().manager());
        assertTrue(resolved.access().readAllowed());
        assertTrue(resolved.access().rosterAllowed());
        assertSame(session, access.requireReadable(INVITED, WORKSPACE, SESSION_ID.toString()));
        CpApiException owned = assertThrows(CpApiException.class,
                () -> access.requireOwned(INVITED, WORKSPACE, SESSION_ID.toString()));
        assertEquals(HttpStatus.NOT_FOUND, owned.getStatus());
        assertEquals("SESSION_NOT_FOUND", owned.getCode());
    }

    @Test
    void managerKeepsRosterButNotContentRead() {
        when(grants.allowsUserOnly(any())).thenReturn(true);
        when(workspaces.isWorkspaceMember(WORKSPACE, MANAGER)).thenReturn(true);

        SessionReadAccess.Resolved resolved = access.resolve(MANAGER, WORKSPACE, SESSION_ID.toString());

        assertFalse(resolved.access().owner());
        assertFalse(resolved.access().invitedHuman());
        assertTrue(resolved.access().manager());
        assertFalse(resolved.access().readAllowed(), "D1b: managers must not read conversation content");
        assertTrue(resolved.access().rosterAllowed(), "D2: the shipped roster read still accepts managers");
        CpApiException denied = assertThrows(CpApiException.class,
                () -> access.requireReadable(MANAGER, WORKSPACE, SESSION_ID.toString()));
        assertEquals("SESSION_NOT_FOUND", denied.getCode());
    }

    @Test
    void strangerIsNeitherOwnerInvitedNorManager() {
        when(grants.allowsUserOnly(any())).thenReturn(false);
        when(workspaces.isWorkspaceMember(WORKSPACE, STRANGER)).thenReturn(true);

        SessionReadAccess.Resolved resolved = access.resolve(STRANGER, WORKSPACE, SESSION_ID.toString());

        assertFalse(resolved.access().readAllowed());
        assertFalse(resolved.access().rosterAllowed());
        CpApiException denied = assertThrows(CpApiException.class,
                () -> access.requireReadable(STRANGER, WORKSPACE, SESSION_ID.toString()));
        assertEquals("SESSION_NOT_FOUND", denied.getCode());
        assertEquals(HttpStatus.NOT_FOUND, denied.getStatus());
    }

    @Test
    void disabledInvitedParticipantDoesNotCount() {
        // The repository method itself filters disabled_at IS NULL; a disabled row returns false.
        when(participants.existsBySessionIdAndPrincipalKindAndPrincipalIdAndDisabledAtIsNull(
                eq(SESSION_ID), eq(SessionParticipant.KIND_HUMAN), any())).thenReturn(false);
        when(grants.allowsUserOnly(any())).thenReturn(false);
        when(workspaces.isWorkspaceMember(WORKSPACE, INVITED)).thenReturn(true);

        SessionReadAccess.Resolved resolved = access.resolve(INVITED, WORKSPACE, SESSION_ID.toString());

        assertFalse(resolved.access().readAllowed());
        CpApiException denied = assertThrows(CpApiException.class,
                () -> access.requireReadable(INVITED, WORKSPACE, SESSION_ID.toString()));
        assertEquals("SESSION_NOT_FOUND", denied.getCode());
    }

    @Test
    void archivedSessionIsNotFound() {
        when(session.isArchived()).thenReturn(true);

        CpApiException error = assertThrows(CpApiException.class,
                () -> access.resolve(OWNER, WORKSPACE, SESSION_ID.toString()));
        assertEquals("SESSION_NOT_FOUND", error.getCode());
    }

    @Test
    void sessionInAnotherWorkspaceIsNotFound() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> access.requireReadable(OWNER, OTHER_WORKSPACE, SESSION_ID.toString()));
        assertEquals("SESSION_NOT_FOUND", error.getCode());
    }

    @Test
    void blankWorkspaceContextIsConflict() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> access.resolve(OWNER, " ", SESSION_ID.toString()));
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", error.getCode());
        assertEquals(HttpStatus.CONFLICT, error.getStatus());
    }

    @Test
    void malformedSessionIdIsNotFound() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> access.resolve(OWNER, WORKSPACE, "not-a-uuid"));
        assertEquals("SESSION_NOT_FOUND", error.getCode());
    }

    @Test
    void readGuardEnforcesWorkspaceAccessibility() {
        org.mockito.Mockito.doThrow(new CpApiException(HttpStatus.FORBIDDEN, "WORKSPACE_FORBIDDEN",
                        "Workspace forbidden"))
                .when(workspaces).requireAccessibleWorkspace(WORKSPACE, STRANGER);

        CpApiException error = assertThrows(CpApiException.class,
                () -> access.requireReadable(STRANGER, WORKSPACE, SESSION_ID.toString()));
        assertEquals("WORKSPACE_FORBIDDEN", error.getCode());

        // The owner-only guard also keeps the historical workspace gate (same as requireCurrent).
        CpApiException owned = assertThrows(CpApiException.class,
                () -> access.requireOwned(STRANGER, WORKSPACE, SESSION_ID.toString()));
        assertEquals("WORKSPACE_FORBIDDEN", owned.getCode());
    }

    @Test
    void ownerGuardDoesNotConsultParticipantOrGrantTables() {
        access.requireOwned(OWNER, WORKSPACE, SESSION_ID.toString());

        verify(participants, never())
                .existsBySessionIdAndPrincipalKindAndPrincipalIdAndDisabledAtIsNull(any(), anyString(), any());
        verify(grants, never()).allowsUserOnly(any());
    }
}
