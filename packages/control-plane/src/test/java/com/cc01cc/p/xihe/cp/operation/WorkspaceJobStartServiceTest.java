package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class WorkspaceJobStartServiceTest {

    private static final String WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";

    private OperationService operationService;
    private JobStateService jobStateService;
    private WorkspaceService workspaceService;
    private RuntimeJobClient runtimeJobClient;
    private WorkspaceJobStartService service;

    private final UUID operationId = UUID.randomUUID();
    private final UUID itemId = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        operationService = Mockito.mock(OperationService.class);
        jobStateService = Mockito.mock(JobStateService.class);
        workspaceService = Mockito.mock(WorkspaceService.class);
        runtimeJobClient = Mockito.mock(RuntimeJobClient.class);
        service = new WorkspaceJobStartService(operationService, jobStateService, workspaceService,
                runtimeJobClient);
    }

    private Workspace workspace(String executionMode) {
        Workspace workspace = new Workspace();
        workspace.setExecutionMode(executionMode);
        when(workspaceService.requireAccessibleWorkspace(WORKSPACE_ID, "user-1")).thenReturn(workspace);
        return workspace;
    }

    private static WorkspaceJobStartService.StartRequest request() {
        return new WorkspaceJobStartService.StartRequest("echo", List.of("hi"), null, 0L,
                "workspace", null, null, "ui", null);
    }

    @Test
    void rejectsMissingIdempotencyKey() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> service.start(WORKSPACE_ID, "user-1", request(), " "));
        assertEquals("IDEMPOTENCY_KEY_REQUIRED", error.getCode());
    }

    @Test
    void rejectsBlankCommand() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> service.start(WORKSPACE_ID, "user-1",
                        new WorkspaceJobStartService.StartRequest(" ", List.of(), null, 0L,
                                "workspace", null, null, "ui", null), "key-1"));
        assertEquals("INVALID_REQUEST", error.getCode());
    }

    @Test
    void refusesNonDockerBackendWithoutCreatingDurableJob() {
        workspace("windows-mxc");

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.start(WORKSPACE_ID, "user-1", request(), "key-1"));

        assertEquals("JOB_BACKEND_LAUNCH_PENDING", error.getCode());
        assertEquals(501, error.getStatus().value());
        verify(operationService, never()).startWorkspaceJob(any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any());
    }

    @Test
    void idempotentReplayReturnsExistingProjectionWithoutDispatch() {
        workspace("docker");
        Map<String, Object> existing = Map.of("operationItemId", itemId.toString(), "status", "running");
        when(operationService.startWorkspaceJob(eq("user-1"), eq(WORKSPACE_ID), any(), any(),
                eq("ui"), eq("user"), eq("key-1"), anyString(), anyString(), anyString()))
                .thenReturn(new OperationService.WorkspaceJobStart(operationId, itemId, true));
        when(operationService.jobView(itemId)).thenReturn(existing);

        WorkspaceJobStartService.StartOutcome outcome = service.start(WORKSPACE_ID, "user-1", request(), "key-1");

        assertTrue(outcome.replayed());
        assertEquals(existing, outcome.job());
        verify(runtimeJobClient, never()).startJob(any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void successfulDispatchMarksRunningAndStoresBootId() {
        workspace("docker");
        when(operationService.startWorkspaceJob(eq("user-1"), eq(WORKSPACE_ID), any(), any(),
                eq("ui"), eq("user"), eq("key-1"), anyString(), anyString(), anyString()))
                .thenReturn(new OperationService.WorkspaceJobStart(operationId, itemId, false));
        when(runtimeJobClient.startJob(eq(WORKSPACE_ID), eq(itemId.toString()), eq("echo"),
                any(), any(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobStartResult(true, true, false, "job-1", null));
        when(runtimeJobClient.runtimeBootId()).thenReturn("boot-1");
        when(operationService.jobView(itemId)).thenReturn(Map.of("status", "running", "jobId", "job-1"));

        WorkspaceJobStartService.StartOutcome outcome = service.start(WORKSPACE_ID, "user-1", request(), "key-1");

        assertFalse(outcome.replayed());
        ArgumentCaptor<Map> captor = ArgumentCaptor.forClass(Map.class);
        verify(jobStateService, Mockito.times(2)).upsert(eq(itemId), captor.capture());
        List<Map> payloads = captor.getAllValues();
        assertEquals(JobStateService.STATUS_PENDING, payloads.get(0).get("status"));
        assertEquals("workspace", payloads.get(0).get("scope"));
        assertEquals("docker", payloads.get(0).get("backendKind"));
        assertEquals(JobStateService.STATUS_RUNNING, payloads.get(1).get("status"));
        assertEquals("job-1", payloads.get(1).get("jobId"));
        assertEquals("boot-1", payloads.get(1).get("runtimeBootId"));
    }

    @Test
    void unreachableRuntimeMarksInterruptedAndFails() {
        workspace("docker");
        when(operationService.startWorkspaceJob(eq("user-1"), eq(WORKSPACE_ID), any(), any(),
                eq("ui"), eq("user"), eq("key-1"), anyString(), anyString(), anyString()))
                .thenReturn(new OperationService.WorkspaceJobStart(operationId, itemId, false));
        when(runtimeJobClient.startJob(any(), any(), any(), any(), any(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobStartResult(false, false, false, null, null));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.start(WORKSPACE_ID, "user-1", request(), "key-1"));

        assertEquals("RUNTIME_UNAVAILABLE", error.getCode());
        assertEquals(502, error.getStatus().value());
        ArgumentCaptor<Map> captor = ArgumentCaptor.forClass(Map.class);
        verify(jobStateService, Mockito.times(2)).upsert(eq(itemId), captor.capture());
        assertEquals(JobStateService.STATUS_INTERRUPTED, captor.getAllValues().get(1).get("status"));
        assertEquals("RUNTIME_UNAVAILABLE", captor.getAllValues().get(1).get("errorCode"));
    }

    @Test
    void runtimeBackendPendingFailsDurableJobWithoutFallback() {
        workspace("docker");
        when(operationService.startWorkspaceJob(eq("user-1"), eq(WORKSPACE_ID), any(), any(),
                eq("ui"), eq("user"), eq("key-1"), anyString(), anyString(), anyString()))
                .thenReturn(new OperationService.WorkspaceJobStart(operationId, itemId, false));
        when(runtimeJobClient.startJob(any(), any(), any(), any(), any(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobStartResult(true, false, true, null,
                        "JOB_BACKEND_LAUNCH_PENDING"));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.start(WORKSPACE_ID, "user-1", request(), "key-1"));

        assertEquals("JOB_BACKEND_LAUNCH_PENDING", error.getCode());
        ArgumentCaptor<Map> captor = ArgumentCaptor.forClass(Map.class);
        verify(jobStateService, Mockito.times(2)).upsert(eq(itemId), captor.capture());
        assertEquals("failed", captor.getAllValues().get(1).get("status"));
    }

    @Test
    void inputHashDiffersWhenCommandArgsOrTimeoutChange() {
        String base = WorkspaceJobStartService.inputHash("echo", List.of("a"), null, 0L);
        assertEquals(base, WorkspaceJobStartService.inputHash("echo", List.of("a"), null, 0L));
        assertFalse(base.equals(WorkspaceJobStartService.inputHash("echo", List.of("b"), null, 0L)));
        assertFalse(base.equals(WorkspaceJobStartService.inputHash("echo", List.of("a"), null, 5L)));
    }
}
