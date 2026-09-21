package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class WorkspaceJobControllerTest {

    private OperationService operationService;
    private WorkspaceJobStartService workspaceJobStartService;
    private WorkspaceService workspaceService;
    private WorkspaceJobController controller;

    @BeforeEach
    void setUp() {
        operationService = Mockito.mock(OperationService.class);
        workspaceJobStartService = Mockito.mock(WorkspaceJobStartService.class);
        workspaceService = Mockito.mock(WorkspaceService.class);
        controller = new WorkspaceJobController(operationService, workspaceJobStartService, workspaceService);
        TenantContext.setUserId("user-1");
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @Test
    void listsJobsAfterWorkspaceAccessCheck() {
        List<Map<String, Object>> jobs = List.of(Map.of(
                "operationItemId", "item-1",
                "workspaceId", "workspace-1",
                "scope", "workspace",
                "status", "running"));
        when(operationService.listWorkspaceJobs("workspace-1")).thenReturn(jobs);

        ResponseEntity<?> response = controller.list("workspace-1");

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(jobs, response.getBody());
        verify(workspaceService).requireAccessibleWorkspace("workspace-1", "user-1");
        verify(operationService).listWorkspaceJobs("workspace-1");
    }

    @Test
    void returnsProblemDetailsWhenWorkspaceAccessIsDenied() {
        when(workspaceService.requireAccessibleWorkspace("workspace-1", "user-1"))
                .thenThrow(new CpApiException(HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND", "Workspace not found"));

        ResponseEntity<?> response = controller.list("workspace-1");

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
        assertNotNull(response.getBody());
        verify(operationService, Mockito.never()).listWorkspaceJobs("workspace-1");
    }

    @Test
    void startRequiresIdempotencyKey() {
        ResponseEntity<?> response = controller.start("workspace-1", "  ",
                new WorkspaceJobStartService.StartRequest("echo", List.of(), null, 0L,
                        "session", null, null, "ui", null));

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        verify(workspaceJobStartService, Mockito.never()).start(any(), any(), any(), any());
    }

    @Test
    void startReturnsAcceptedForNewJob() {
        Map<String, Object> job = Map.of("operationItemId", "item-1", "status", "running");
        when(workspaceJobStartService.start(eq("workspace-1"), eq("user-1"), any(), eq("key-1")))
                .thenReturn(new WorkspaceJobStartService.StartOutcome(job, false));

        ResponseEntity<?> response = controller.start("workspace-1", "key-1",
                new WorkspaceJobStartService.StartRequest("echo", List.of("hi"), null, 0L,
                        "session", null, null, "ui", null));

        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        assertEquals(job, response.getBody());
    }

    @Test
    void startReturnsOkForIdempotentReplay() {
        Map<String, Object> job = Map.of("operationItemId", "item-1", "status", "running");
        when(workspaceJobStartService.start(eq("workspace-1"), eq("user-1"), any(), eq("key-1")))
                .thenReturn(new WorkspaceJobStartService.StartOutcome(job, true));

        ResponseEntity<?> response = controller.start("workspace-1", "key-1",
                new WorkspaceJobStartService.StartRequest("echo", List.of("hi"), null, 0L,
                        "session", null, null, "ui", null));

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(job, response.getBody());
    }

    @Test
    void startMapsBackendLaunchPendingTo501() {
        when(workspaceJobStartService.start(eq("workspace-1"), eq("user-1"), any(), eq("key-1")))
                .thenThrow(new CpApiException(HttpStatus.NOT_IMPLEMENTED, "JOB_BACKEND_LAUNCH_PENDING",
                        "not available"));

        ResponseEntity<?> response = controller.start("workspace-1", "key-1",
                new WorkspaceJobStartService.StartRequest("echo", List.of(), null, 0L,
                        "workspace", null, null, "ui", null));

        assertEquals(HttpStatus.NOT_IMPLEMENTED, response.getStatusCode());
        assertNotNull(response.getBody());
    }
}
