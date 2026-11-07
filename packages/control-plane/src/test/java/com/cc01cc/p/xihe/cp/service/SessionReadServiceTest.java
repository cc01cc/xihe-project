package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0689 A2c: the authorization path view's identity comes from the Session's PRIMARY
 * participant row. The {@code sessions.agent_principal_id} column is no longer read here (it is
 * dropped in A7), so a Session without a PRIMARY row must render {@code null} instead of silently
 * falling back to the column.
 */
class SessionReadServiceTest {

    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID PRIMARY_ID = UUID.randomUUID();

    @Test
    void pathViewIdentityIsThePrimaryParticipantNotTheSessionColumn() {
        SessionRepository sessions = mock(SessionRepository.class);
        SessionParticipantRepository participants = mock(SessionParticipantRepository.class);
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(session()));
        when(participants.primaryPrincipalId(SESSION_ID)).thenReturn(Optional.of(PRIMARY_ID));

        SessionReadService.SessionPathView view = new SessionReadService(sessions, participants)
                .findById(SESSION_ID)
                .orElseThrow();

        assertEquals(PRIMARY_ID.toString(), view.agentPrincipalId(),
                "path identity must be the PRIMARY participant principal");
        assertEquals("user-1", view.userId());
        assertEquals(Session.KIND_SPAWN, view.kind());
    }

    @Test
    void missingPrimaryRendersNullInsteadOfFallingBackToTheColumn() {
        SessionRepository sessions = mock(SessionRepository.class);
        SessionParticipantRepository participants = mock(SessionParticipantRepository.class);
        // The legacy column still names a principal: it must be ignored, not used as a fallback.
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(session()));
        when(participants.primaryPrincipalId(SESSION_ID)).thenReturn(Optional.empty());

        SessionReadService.SessionPathView view = new SessionReadService(sessions, participants)
                .findById(SESSION_ID)
                .orElseThrow();

        assertNull(view.agentPrincipalId(),
                "missing PRIMARY must be null, never sessions.agent_principal_id");
        assertNull(view.agentPermissionsSnapshot());
    }

    private static Session session() {
        Session session = new Session();
        session.setId(SESSION_ID);
        session.setUserId("user-1");
        session.setWorkspaceId("workspace-1");
        session.setAgentPrincipalId(UUID.randomUUID().toString());
        session.setKind(Session.KIND_SPAWN);
        return session;
    }
}
