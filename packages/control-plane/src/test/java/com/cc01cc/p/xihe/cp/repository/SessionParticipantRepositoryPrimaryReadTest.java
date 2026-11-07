package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0689 A2c: {@link SessionParticipantRepository#primaryPrincipalId(UUID)} /
 * {@link SessionParticipantRepository#primaryPrincipalIds(java.util.Collection)} are the single read
 * entry for every principal that used to come from {@code sessions.agent_principal_id}. These cases
 * pin the absence policy: MEMBER rows are ignored, and a PRIMARY row whose principal is null counts
 * as missing (R5) — absence is expressed as an empty result, never as an exception or a guess.
 */
class SessionParticipantRepositoryPrimaryReadTest {

    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID OTHER_SESSION_ID = UUID.randomUUID();

    @Test
    void resolvesPrimaryPrincipalPerSession() {
        SessionParticipant primary =
                participant(SESSION_ID, UUID.randomUUID(), SessionParticipant.ROLE_PRIMARY);
        SessionParticipant member =
                participant(SESSION_ID, UUID.randomUUID(), SessionParticipant.ROLE_MEMBER);
        SessionParticipant otherPrimary =
                participant(OTHER_SESSION_ID, UUID.randomUUID(), SessionParticipant.ROLE_PRIMARY);
        SessionParticipantRepository repository = repositoryReturning(primary, member, otherPrimary);

        Map<UUID, UUID> primaries = repository.primaryPrincipalIds(List.of(SESSION_ID, OTHER_SESSION_ID));

        assertEquals(primary.getPrincipalId(), primaries.get(SESSION_ID));
        assertEquals(otherPrimary.getPrincipalId(), primaries.get(OTHER_SESSION_ID));
        assertEquals(2, primaries.size(), "MEMBER rows must not produce an entry");
        assertEquals(primary.getPrincipalId(), repository.primaryPrincipalId(SESSION_ID).orElseThrow());
    }

    @Test
    void primaryRowWithNullPrincipalIsTreatedAsMissing() {
        SessionParticipant nullPrincipal =
                participant(SESSION_ID, null, SessionParticipant.ROLE_PRIMARY);
        SessionParticipantRepository repository = repositoryReturning(nullPrincipal);

        assertTrue(repository.primaryPrincipalId(SESSION_ID).isEmpty());
        assertFalse(repository.primaryPrincipalIds(List.of(SESSION_ID)).containsKey(SESSION_ID));
    }

    @Test
    void unknownOrNullSessionResolvesToEmptyWithoutThrowing() {
        SessionParticipantRepository repository = repositoryReturning();

        assertTrue(repository.primaryPrincipalId(UUID.randomUUID()).isEmpty());
        assertTrue(repository.primaryPrincipalId(null).isEmpty());
        assertTrue(repository.primaryPrincipalIds(List.of()).isEmpty());
    }

    private static SessionParticipantRepository repositoryReturning(SessionParticipant... rows) {
        SessionParticipantRepository repository = mock(SessionParticipantRepository.class, CALLS_REAL_METHODS);
        when(repository.findBySessionIdInAndRoleOrderByOrderIndexAsc(any(), anyString()))
                .thenReturn(List.of(rows));
        return repository;
    }

    private static SessionParticipant participant(UUID sessionId, UUID principalId, String role) {
        return new SessionParticipant(sessionId, SessionParticipant.KIND_AGENT, principalId, role, 10,
                SessionParticipant.WAKE_ALL_MESSAGES, SessionParticipant.RESPOND_ALWAYS);
    }
}
