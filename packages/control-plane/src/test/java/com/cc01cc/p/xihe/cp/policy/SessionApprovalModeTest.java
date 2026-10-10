package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.service.SessionApprovalModeStore;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * PLAN-0337 T1.4: the session approval mode is persisted on the session row and survives a
 * process restart; unreadable or unsupported state fails closed to "inherit".
 *
 * <p>PLAN-0470 (T3.2): reads go through {@link SessionReadService} and the write through
 * {@link SessionService#setApprovalMode}; this view no longer touches the Session repository.</p>
 */
class SessionApprovalModeTest {

    private static final UUID SESSION_ID = UUID.fromString("55555555-5555-4555-8555-555555555555");

    private final SessionApprovalModeStore store = mock(SessionApprovalModeStore.class);
    private final SessionApprovalMode mode = new SessionApprovalMode(store);

    private Session storedSession(String approvalMode) {
        Session session = new Session("22222222-2222-4222-8222-222222222222",
                "11111111-1111-4111-8111-111111111111", "test");
        session.setId(SESSION_ID);
        session.setApprovalMode(approvalMode);
        return session;
    }

    @Test
    void readsThePersistedMode() {
        when(store.findApprovalMode(SESSION_ID)).thenReturn(Optional.of("auto"));

        assertEquals(Optional.of("auto"), mode.modeOf(SESSION_ID.toString()));
    }

    @Test
    void unsetModeMeansInherit() {
        when(store.findApprovalMode(SESSION_ID)).thenReturn(Optional.ofNullable(null));

        assertTrue(mode.modeOf(SESSION_ID.toString()).isEmpty());
    }

    @Test
    void unsupportedStoredValueIsIgnoredInsteadOfRelaxing() {
        when(store.findApprovalMode(SESSION_ID)).thenReturn(Optional.of("yolo"));

        assertTrue(mode.modeOf(SESSION_ID.toString()).isEmpty());
    }

    @Test
    void unreadableStoreFailsClosedToInherit() {
        when(store.findApprovalMode(SESSION_ID)).thenThrow(new IllegalStateException("db down"));

        assertTrue(mode.modeOf(SESSION_ID.toString()).isEmpty());
    }

    @Test
    void persistsASupportedMode() {
        mode.setMode(SESSION_ID.toString(), "auto");

        verify(store).setApprovalMode(SESSION_ID, "auto");
    }

    @Test
    void rejectsAnUnsupportedModeWithoutWriting() {
        assertThrows(IllegalArgumentException.class, () -> mode.setMode(SESSION_ID.toString(), "yolo"));

        verify(store, never()).setApprovalMode(any(), any());
    }

    @Test
    void rejectsAMissingSession() {
        doThrow(new IllegalStateException("session not found: " + SESSION_ID))
                .when(store).setApprovalMode(SESSION_ID, "manual");

        assertThrows(IllegalStateException.class, () -> mode.setMode(SESSION_ID.toString(), "manual"));

        verify(store).setApprovalMode(SESSION_ID, "manual");
    }
}
