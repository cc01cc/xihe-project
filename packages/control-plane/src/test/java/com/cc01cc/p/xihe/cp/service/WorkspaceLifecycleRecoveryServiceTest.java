package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.WorkspaceLifecycleOperation;
import com.cc01cc.p.xihe.cp.repository.WorkspaceLifecycleOperationRepository;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0391 T1.5: recovery sweep marks in-flight release operations interrupted
 * without replaying them, and only runs against PostgreSQL.
 */
class WorkspaceLifecycleRecoveryServiceTest {

    private static WorkspaceLifecycleOperation inFlight(String status) {
        WorkspaceLifecycleOperation row = new WorkspaceLifecycleOperation();
        row.setId(UUID.randomUUID());
        row.setWorkspaceId(UUID.randomUUID());
        row.setStatus(status);
        return row;
    }

    @Test
    void startupMarksInFlightOperationsInterrupted() {
        WorkspaceLifecycleOperationRepository repository =
                Mockito.mock(WorkspaceLifecycleOperationRepository.class);
        WorkspaceLifecycleOperation row =
                inFlight(WorkspaceLifecycleOperation.STATUS_ACCEPTED);
        when(repository.findByStatusIn(any())).thenReturn(List.of(row));
        when(repository.save(any())).thenAnswer(invocation -> invocation.getArgument(0));

        new WorkspaceLifecycleRecoveryService(repository, "jdbc:postgresql://localhost/xihe")
                .recoverOnStartup();

        assertEquals(WorkspaceLifecycleOperation.STATUS_INTERRUPTED, row.getStatus());
        assertEquals("INTERRUPTED", row.getErrorCode());
        assertNotNull(row.getEndedAt());
    }

    @Test
    void startupSkipsNonPostgresDatasource() {
        WorkspaceLifecycleOperationRepository repository =
                Mockito.mock(WorkspaceLifecycleOperationRepository.class);

        new WorkspaceLifecycleRecoveryService(repository, "jdbc:h2:mem:test")
                .recoverOnStartup();

        verify(repository, never()).findByStatusIn(any());
    }
}
