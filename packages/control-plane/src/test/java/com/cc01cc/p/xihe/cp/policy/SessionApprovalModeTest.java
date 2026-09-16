package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * PLAN-0337 T1.4: the session approval mode is persisted on the session row and survives a
 * process restart; unreadable or unsupported state fails closed to "inherit".
 */
class SessionApprovalModeTest {

    private static final UUID SESSION_ID = UUID.fromString("55555555-5555-4555-8555-555555555555");

    private final SessionRepository sessions = mock(SessionRepository.class);
    private final SessionApprovalMode store = new SessionApprovalMode(sessions);

    private Session storedSession(String approvalMode) {
        Session session = new Session("22222222-2222-4222-8222-222222222222",
                "11111111-1111-4111-8111-111111111111", "test");
        session.setId(SESSION_ID);
        session.setApprovalMode(approvalMode);
        return session;
    }

    @Test
    void readsThePersistedMode() {
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(storedSession("auto")));

        assertEquals(Optional.of("auto"), store.modeOf(SESSION_ID.toString()));
    }

    @Test
    void unsetModeMeansInherit() {
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(storedSession(null)));

        assertTrue(store.modeOf(SESSION_ID.toString()).isEmpty());
    }

    @Test
    void unsupportedStoredValueIsIgnoredInsteadOfRelaxing() {
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(storedSession("yolo")));

        assertTrue(store.modeOf(SESSION_ID.toString()).isEmpty());
    }

    @Test
    void unreadableStoreFailsClosedToInherit() {
        when(sessions.findById(SESSION_ID)).thenThrow(new IllegalStateException("db down"));

        assertTrue(store.modeOf(SESSION_ID.toString()).isEmpty());
    }

    @Test
    void persistsASupportedMode() {
        Session session = storedSession(null);
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.of(session));

        store.setMode(SESSION_ID.toString(), "auto");

        assertEquals("auto", session.getApprovalMode());
        verify(sessions).save(session);
    }

    @Test
    void rejectsAnUnsupportedModeWithoutWriting() {
        assertThrows(IllegalArgumentException.class, () -> store.setMode(SESSION_ID.toString(), "yolo"));

        verify(sessions, never()).save(any());
    }

    @Test
    void rejectsAMissingSession() {
        when(sessions.findById(SESSION_ID)).thenReturn(Optional.empty());

        assertThrows(IllegalStateException.class, () -> store.setMode(SESSION_ID.toString(), "manual"));

        verify(sessions, never()).save(any());
    }
}
