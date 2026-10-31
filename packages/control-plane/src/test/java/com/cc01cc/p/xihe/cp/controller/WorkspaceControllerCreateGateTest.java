package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.WorkspaceBackendPolicy;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0612 M4: `POST /api/v1/workspaces` refuses docker creation (409 BACKEND_DISABLED)
 * before any service call, and leaves direct_attach creation untouched.
 */
class WorkspaceControllerCreateGateTest {

    private WorkspaceService workspaceService;
    private WorkspaceController controller;

    @BeforeEach
    void setUp() {
        workspaceService = Mockito.mock(WorkspaceService.class);
        WorkspaceBackendPolicy disabledPolicy = new WorkspaceBackendPolicy("");
        disabledPolicy.validate();
        controller = new WorkspaceController(workspaceService, disabledPolicy);
        TenantContext.setUserId("user-1");
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @Test
    void absentStorageModeDefaultsToManagedImportAndIsRefusedWith409() {
        ResponseEntity<?> response = controller.create(null, null);

        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertNotNull(response.getBody());
        assertEquals("BACKEND_DISABLED", ((Map<?, ?>) response.getBody()).get("code"));
        verify(workspaceService, never()).createWorkspace(any(), any(), any(), any(), any(),
                any(), any(), any(), any());
    }

    @Test
    void explicitManagedImportIsRefusedWith409() {
        WorkspaceController.CreateWorkspaceRequest request = new WorkspaceController.CreateWorkspaceRequest(
                "Imported", null, null, null, "managed_import", null, "docker");

        ResponseEntity<?> response = controller.create(request, "key-1");

        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("BACKEND_DISABLED", ((Map<?, ?>) response.getBody()).get("code"));
        verify(workspaceService, never()).createWorkspace(any(), any(), any(), any(), any(),
                any(), any(), any(), any());
    }

    @Test
    void directAttachCreationStillReachesTheService() {
        WorkspaceController.CreateWorkspaceRequest request = new WorkspaceController.CreateWorkspaceRequest(
                "Host workspace", null, null, null, "direct_attach", "H:/tmp/ws", "windows-host");
        when(workspaceService.createWorkspace(eq("Host workspace"), any(), eq("user-1"), any(), any(),
                eq("direct_attach"), eq("H:/tmp/ws"), eq("windows-host"), any()))
                .thenThrow(new CpApiException(HttpStatus.BAD_REQUEST, "PROBE_REJECTED", "probe rejected"));

        ResponseEntity<?> response = controller.create(request, null);

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        assertEquals("PROBE_REJECTED", ((Map<?, ?>) response.getBody()).get("code"));
    }

    @Test
    void enabledPolicyLetsDockerCreationReachTheService() {
        WorkspaceBackendPolicy enabled = new WorkspaceBackendPolicy("enabled");
        enabled.validate();
        WorkspaceController relaxed = new WorkspaceController(workspaceService, enabled);
        when(workspaceService.createWorkspace(any(), any(), eq("user-1"), any(), any(),
                any(), any(), any(), any()))
                .thenThrow(new CpApiException(HttpStatus.BAD_REQUEST, "SEEN_BY_SERVICE", "reached"));

        ResponseEntity<?> response = relaxed.create(
                new WorkspaceController.CreateWorkspaceRequest("Docker", null, null, null, "managed_import", null, "docker"),
                null);

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        assertEquals("SEEN_BY_SERVICE", ((Map<?, ?>) response.getBody()).get("code"));
        verify(workspaceService).createWorkspace(any(), any(), eq("user-1"), any(), any(),
                eq("managed_import"), any(), eq("docker"), any());
    }

    @Test
    void missingAuthenticationStillWinsOverTheBackendGate() {
        TenantContext.clear();

        ResponseEntity<?> response = controller.create(null, null);

        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
        verify(workspaceService, never()).createWorkspace(any(), any(), any(), any(), any(),
                any(), any(), any(), any());
    }
}
