package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class JobScopeClosureServiceTest {

    private static final String WORKSPACE_ID = "workspace-1";

    private JobStateService jobStateService;
    private RuntimeJobClient runtimeJobClient;
    private JobScopeClosureService service;

    private final UUID itemId = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        jobStateService = Mockito.mock(JobStateService.class);
        runtimeJobClient = Mockito.mock(RuntimeJobClient.class);
        service = new JobScopeClosureService(jobStateService, runtimeJobClient);
    }

    private JobStateService.JobArchive archive(String jobId, String scope, String status) {
        return new JobStateService.JobArchive(itemId.toString(), jobId, WORKSPACE_ID, scope, status,
                null, null, null, null, null, "docker", "docker", "ui", "user", null,
                "not_started", null, null, null, null);
    }

    private void givenActive(String scope, String key, String jobId, String status) {
        when(jobStateService.findActiveForScope(scope, key))
                .thenReturn(List.of(new JobStateService.ActiveJob(itemId, archive(jobId, scope, status))));
    }

    @Test
    void confirmedCancelClosesRunScopedJob() {
        givenActive("run", "run-1", "job-1", "running");
        when(runtimeJobClient.cancelJob(WORKSPACE_ID, "job-1"))
                .thenReturn(new RuntimeJobClient.JobCancelResult(true, true, "cancelled"));

        int closed = service.closeRunScope("run-1");

        assertEquals(1, closed);
        ArgumentCaptor<Map> captor = ArgumentCaptor.forClass(Map.class);
        verify(jobStateService).upsert(eq(itemId), captor.capture());
        assertEquals("cancelled", captor.getValue().get("status"));
        assertEquals(JobStateService.REASON_SCOPE_RUN_END, captor.getValue().get("cancelReason"));
        assertEquals("completed", captor.getValue().get("cleanupStatus"));
    }

    @Test
    void missingRuntimeJobFallsBackToOrphaned() {
        givenActive("session", "session-1", "job-2", "running");
        when(runtimeJobClient.cancelJob(WORKSPACE_ID, "job-2"))
                .thenReturn(new RuntimeJobClient.JobCancelResult(true, false, null));

        assertEquals(1, service.closeSessionScope("session-1"));

        ArgumentCaptor<Map> captor = ArgumentCaptor.forClass(Map.class);
        verify(jobStateService).upsert(eq(itemId), captor.capture());
        assertEquals("orphaned", captor.getValue().get("status"));
        assertEquals(JobStateService.REASON_JOB_MISSING, captor.getValue().get("cancelReason"));
    }

    @Test
    void unreachableRuntimeKeepsJobActive() {
        givenActive("run", "run-2", "job-3", "running");
        when(runtimeJobClient.cancelJob(WORKSPACE_ID, "job-3"))
                .thenReturn(new RuntimeJobClient.JobCancelResult(false, false, null));

        assertEquals(0, service.closeRunScope("run-2"));
        verify(jobStateService, never()).upsert(eq(itemId), Mockito.anyMap());
    }

    @Test
    void unconfirmedTerminationKeepsJobActive() {
        givenActive("run", "run-3", "job-4", "running");
        when(runtimeJobClient.cancelJob(WORKSPACE_ID, "job-4"))
                .thenReturn(new RuntimeJobClient.JobCancelResult(true, true, "failed"));

        assertEquals(0, service.closeRunScope("run-3"));
        verify(jobStateService, never()).upsert(eq(itemId), Mockito.anyMap());
    }

    @Test
    void neverDispatchedJobClosesWithoutRuntimeCall() {
        givenActive("run", "run-4", null, "pending");

        assertEquals(1, service.closeRunScope("run-4"));
        verify(runtimeJobClient, never()).cancelJob(Mockito.anyString(), Mockito.anyString());
        ArgumentCaptor<Map> captor = ArgumentCaptor.forClass(Map.class);
        verify(jobStateService).upsert(eq(itemId), captor.capture());
        assertEquals("cancelled", captor.getValue().get("status"));
    }

    @Test
    void emptyScopeIsNoOp() {
        when(jobStateService.findActiveForScope("run", "run-5")).thenReturn(List.of());
        assertEquals(0, service.closeRunScope("run-5"));
        verify(runtimeJobClient, never()).cancelJob(Mockito.anyString(), Mockito.anyString());
    }
}
