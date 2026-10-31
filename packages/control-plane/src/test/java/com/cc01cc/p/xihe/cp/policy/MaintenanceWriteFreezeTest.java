package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceMemberService;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * PLAN-0610 T2.2: the migration-window write freeze.
 *
 * <p>Default off (daily development and the normal suites are unaffected); when on, member and
 * role writes answer 503 {@code MIGRATION_IN_PROGRESS} before touching the legacy facts, so the
 * V88 copy cannot race an online membership write.</p>
 */
class MaintenanceWriteFreezeTest {

    private static MaintenanceWriteFreeze freeze(String raw) {
        MaintenanceWriteFreeze freeze = new MaintenanceWriteFreeze(raw);
        freeze.validate();
        return freeze;
    }

    @Test
    void defaultIsOffAndWritesPass() {
        assertTrue(!freeze(null).isFrozen());
        assertTrue(!freeze("").isFrozen());
        assertTrue(!freeze("false").isFrozen());
        assertDoesNotThrow(() -> freeze(null).requireWritable("workspace member add"));
    }

    @Test
    void trueFreezesWritesWith503MigrationInProgress() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> freeze("true").requireWritable("workspace member add"));
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, error.getStatus());
        assertEquals("MIGRATION_IN_PROGRESS", error.getCode());
        assertTrue(error.getMessage().contains("V88"));
    }

    @Test
    void invalidValueFailsFastAtStartup() {
        IllegalStateException error = assertThrows(IllegalStateException.class, () -> freeze("yes"));
        assertTrue(error.getMessage().contains(MaintenanceWriteFreeze.KEY));
    }

    @Test
    void memberWritesAreRefusedBeforeAnyRepositoryMutation() {
        WorkspaceRepository workspaces = Mockito.mock(WorkspaceRepository.class);
        WorkspaceMembershipService memberships = Mockito.mock(WorkspaceMembershipService.class);
        UserRepository users = Mockito.mock(UserRepository.class);
        WorkspaceMemberService service = new WorkspaceMemberService(workspaces, users, memberships,
                Mockito.mock(AuditLogger.class), freeze("true"));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.addMember("ws-1", "alice", "EDITOR", "caller-1", "OWNER"));
        assertEquals("MIGRATION_IN_PROGRESS", error.getCode());
        verify(memberships, never()).assign(any(), any(), any(), any());
        verify(workspaces, never()).findByIdForUpdate(any());
    }

    @Test
    void memberWritesProceedWhenTheWindowIsClosed() {
        WorkspaceRepository workspaces = Mockito.mock(WorkspaceRepository.class);
        WorkspaceMembershipService memberships = Mockito.mock(WorkspaceMembershipService.class);
        UserRepository users = Mockito.mock(UserRepository.class);
        WorkspaceMemberService service = new WorkspaceMemberService(workspaces, users, memberships,
                Mockito.mock(AuditLogger.class), freeze("false"));

        // Passes the freeze and lands in the ordinary authorization path, which rejects the
        // unknown workspace (not a MIGRATION_IN_PROGRESS error).
        CpApiException error = assertThrows(CpApiException.class,
                () -> service.addMember("ws-1", "alice", "EDITOR", "caller-1", "OWNER"));
        assertTrue(!"MIGRATION_IN_PROGRESS".equals(error.getCode()));
    }
}


