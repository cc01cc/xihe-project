package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceJob;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;
import org.springframework.context.ApplicationContext;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0465 T1.2：start 编排在 `workspace_jobs` 域上的契约——
 * 幂等重读（V36 语义）→ 原子 domain row → 派发 → 失败收口。
 */
class WorkspaceJobStartServiceTest {

    private static final String WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
    /** 0465：domain 行 user_id 为 UUID 列，userId 必须是合法 UUID。 */
    private static final String USER_ID = "33333333-3333-3333-3333-333333333333";

    private JobStateService jobStateService;
    private WorkspaceService workspaceService;
    private RuntimeJobClient runtimeJobClient;
    private ApplicationContext applicationContext;
    private WorkspaceJobStartService service;

    @BeforeEach
    void setUp() {
        jobStateService = Mockito.mock(JobStateService.class);
        workspaceService = Mockito.mock(WorkspaceService.class);
        runtimeJobClient = Mockito.mock(RuntimeJobClient.class);
        applicationContext = Mockito.mock(ApplicationContext.class);
        service = new WorkspaceJobStartService(jobStateService,
                workspaceService, runtimeJobClient, applicationContext);
        when(applicationContext.getBean(WorkspaceJobStartService.class)).thenReturn(service);

        // Default: no idempotent row exists, and the domain row is inserted.
        when(jobStateService.findForReplay(any(), any(), any(), any()))
                .thenReturn(Optional.empty());
    }

    private void workspace(String executionMode) {
        Workspace workspace = new Workspace();
        workspace.setExecutionMode(executionMode);
        when(workspaceService.requireAccessibleWorkspace(WORKSPACE_ID, USER_ID)).thenReturn(workspace);
    }

    private static WorkspaceJobStartService.StartRequest request() {
        return new WorkspaceJobStartService.StartRequest("echo", List.of("hi"), null, 0L,
                "workspace", null, null, "ui", null);
    }

    /** 捕获 insertJob 原子双写产出的 domain 行（其 id 即 wire jobId）。 */
    private UUID captureCreatedRowId() {
        ArgumentCaptor<WorkspaceJob> row = ArgumentCaptor.forClass(WorkspaceJob.class);
        verify(jobStateService).createJob(row.capture(), any());
        assertNotNull(row.getValue().getId());
        return row.getValue().getId();
    }

    @Test
    void rejectsMissingIdempotencyKey() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> service.start(WORKSPACE_ID, USER_ID, request(), " "));
        assertEquals("IDEMPOTENCY_KEY_REQUIRED", error.getCode());
    }

    @Test
    void rejectsBlankCommand() {
        CpApiException error = assertThrows(CpApiException.class,
                () -> service.start(WORKSPACE_ID, USER_ID,
                        new WorkspaceJobStartService.StartRequest(" ", List.of(), null, 0L,
                                "workspace", null, null, "ui", null), "key-1"));
        assertEquals("INVALID_REQUEST", error.getCode());
    }

    @Test
    void windowsHostDispatchUsesRuntimeWithoutFallback() {
        workspace("windows-host");
        when(runtimeJobClient.startJob(any(), any(), any(), any(), any(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobStartResult(true, true, false, "host-job", null));
        when(jobStateService.wireViewById(any()))
                .thenReturn(Optional.of(Map.of("jobId", "domain-1", "status", "running")));

        WorkspaceJobStartService.StartOutcome outcome =
                service.start(WORKSPACE_ID, USER_ID, request(), "key-1");

        assertFalse(outcome.replayed());
        assertEquals("domain-1", outcome.job().get("jobId"));
        // Runtime receives the canonical domain jobId, not the runtime handle.
        ArgumentCaptor<String> jobKey = ArgumentCaptor.forClass(String.class);
        verify(runtimeJobClient).startJob(eq(WORKSPACE_ID), jobKey.capture(), eq("echo"),
                any(), any(), any(), any());
        UUID domainKey = UUID.fromString(jobKey.getValue());
        assertNotNull(domainKey);
        assertNotEquals("host-job", jobKey.getValue());
        assertEquals(captureCreatedRowId(), domainKey,
                "dispatch key must be the created workspace_jobs.id");
    }

    @Test
    void idempotentReplayReturnsExistingProjectionWithoutDispatch() {
        workspace("docker");
        WorkspaceJob existing = new WorkspaceJob();
        existing.setId(UUID.randomUUID());
        existing.setWorkspaceId(UUID.fromString(WORKSPACE_ID));
        existing.setInputHash(WorkspaceJobStartService.inputHash("echo", List.of("hi"), null, 0L));
        Map<String, Object> projection = Map.of("jobId", existing.getId().toString(),
                "status", "running");
        when(jobStateService.findForReplay(eq(USER_ID), eq(WORKSPACE_ID), any(), any()))
                .thenReturn(Optional.of(existing));
        when(jobStateService.wireView(existing)).thenReturn(projection);

        WorkspaceJobStartService.StartOutcome outcome =
                service.start(WORKSPACE_ID, USER_ID, request(), "key-1");

        assertTrue(outcome.replayed());
        assertEquals(projection, outcome.job());
        verify(runtimeJobClient, never()).startJob(any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void sameKeyDifferentInputHashIsRejected() {
        workspace("docker");
        WorkspaceJob existing = new WorkspaceJob();
        existing.setId(UUID.randomUUID());
        existing.setWorkspaceId(UUID.fromString(WORKSPACE_ID));
        existing.setInputHash("different-hash");
        when(jobStateService.findForReplay(any(), any(), any(), any()))
                .thenReturn(Optional.of(existing));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.start(WORKSPACE_ID, USER_ID, request(), "key-1"));

        assertEquals("JOB_IDEMPOTENCY_CONFLICT", error.getCode());
        verify(runtimeJobClient, never()).startJob(any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void successfulDispatchMarksRunningAndStoresBootId() {
        workspace("docker");
        when(runtimeJobClient.startJob(any(), any(), any(), any(), any(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobStartResult(true, true, false, "job-1", null));
        when(runtimeJobClient.runtimeBootId()).thenReturn("boot-1");
        when(jobStateService.wireViewById(any()))
                .thenReturn(Optional.of(Map.of("jobId", "domain-2", "status", "running")));

        WorkspaceJobStartService.StartOutcome outcome =
                service.start(WORKSPACE_ID, USER_ID, request(), "key-1");

        assertFalse(outcome.replayed());
        UUID jobId = captureCreatedRowId();

        // 原子双写：pending 初态在 insertJob 内落库（history start）。
        ArgumentCaptor<Map> create = ArgumentCaptor.forClass(Map.class);
        verify(jobStateService).createJob(any(), create.capture());
        assertEquals(JobStateService.STATUS_PENDING, create.getValue().get("status"));
        assertEquals("workspace", create.getValue().get("scope"));
        assertEquals("docker", create.getValue().get("backendKind"));

        // 派发回填 running 到同一 domain 行。
        ArgumentCaptor<Map> running = ArgumentCaptor.forClass(Map.class);
        verify(jobStateService).upsertById(eq(jobId), running.capture());
        assertEquals(JobStateService.STATUS_RUNNING, running.getValue().get("status"));
        assertEquals("job-1", running.getValue().get("jobId"));
        assertEquals("boot-1", running.getValue().get("runtimeBootId"));
        assertNotNull(running.getValue().get("startedAt"));
    }

    @Test
    void unreachableRuntimeMarksInterruptedAndFails() {
        workspace("docker");
        when(runtimeJobClient.startJob(any(), any(), any(), any(), any(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobStartResult(false, false, false, null, null));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.start(WORKSPACE_ID, USER_ID, request(), "key-1"));

        assertEquals("RUNTIME_UNAVAILABLE", error.getCode());
        assertEquals(502, error.getStatus().value());
        UUID jobId = captureCreatedRowId();
        ArgumentCaptor<Map> captor = ArgumentCaptor.forClass(Map.class);
        verify(jobStateService).upsertById(eq(jobId), captor.capture());
        assertEquals(JobStateService.STATUS_INTERRUPTED, captor.getValue().get("status"));
        assertEquals("RUNTIME_UNAVAILABLE", captor.getValue().get("errorCode"));
    }

    @Test
    void runtimeBackendPendingFailsDurableJobWithoutFallback() {
        workspace("windows-mxc");
        when(runtimeJobClient.startJob(any(), any(), any(), any(), any(), any(), any()))
                .thenReturn(new RuntimeJobClient.JobStartResult(true, false, true, null,
                        "JOB_BACKEND_LAUNCH_PENDING"));

        CpApiException error = assertThrows(CpApiException.class,
                () -> service.start(WORKSPACE_ID, USER_ID, request(), "key-1"));

        assertEquals("JOB_BACKEND_LAUNCH_PENDING", error.getCode());
        UUID jobId = captureCreatedRowId();
        ArgumentCaptor<Map> captor = ArgumentCaptor.forClass(Map.class);
        verify(jobStateService).upsertById(eq(jobId), captor.capture());
        assertEquals(JobStateService.STATUS_INTERRUPTED, captor.getValue().get("status"));
    }

    @Test
    void inputHashDiffersWhenCommandArgsOrTimeoutChange() {
        String base = WorkspaceJobStartService.inputHash("echo", List.of("a"), null, 0L);
        assertEquals(base, WorkspaceJobStartService.inputHash("echo", List.of("a"), null, 0L));
        assertFalse(base.equals(WorkspaceJobStartService.inputHash("echo", List.of("b"), null, 0L)));
        assertFalse(base.equals(WorkspaceJobStartService.inputHash("echo", List.of("a"), null, 5L)));
    }
}
