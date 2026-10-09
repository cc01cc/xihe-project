package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.operation.JobStateService.JobArchive;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class WorkspaceJobCancellationServiceTest {

    @Mock
    private JobStateService jobStateService;

    @Mock
    private RuntimeJobClient runtimeJobClient;

    @Test
    void doesNotReportCancellationWhenCanonicalStatePersistenceFails() {
        UUID jobId = UUID.randomUUID();
        String workspaceId = UUID.randomUUID().toString();
        String runtimeJobId = "runtime-job-1";
        JobArchive archive = new JobArchive(
                runtimeJobId, workspaceId, "workspace", "running", null, null, null, null, null,
                null, null, null, null, null, null, null, null, null, null);
        when(jobStateService.findOwned(jobId, workspaceId)).thenReturn(Optional.of(archive));
        when(runtimeJobClient.cancelJob(workspaceId, runtimeJobId))
                .thenReturn(new RuntimeJobClient.JobCancelResult(true, true, "cancelled", null, null, null, 200));
        doThrow(new IllegalStateException("database unavailable"))
                .when(jobStateService).upsertByIdOrThrow(eq(jobId), anyMap());

        assertThrows(IllegalStateException.class, () -> new WorkspaceJobCancellationService(
                jobStateService, runtimeJobClient).cancel(jobId, workspaceId));

        verify(jobStateService).upsertByIdOrThrow(eq(jobId), anyMap());
    }
}
