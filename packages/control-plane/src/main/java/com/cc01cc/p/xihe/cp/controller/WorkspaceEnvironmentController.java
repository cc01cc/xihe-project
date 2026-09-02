package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceExecutionSpec;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceExecutionSpecService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
public class WorkspaceEnvironmentController {

    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceService workspaceService;
    private final WorkspaceExecutionSpecService executionSpecService;
    private final RuntimeHeartbeatController heartbeatController;

    public WorkspaceEnvironmentController(
            WorkspaceRepository workspaceRepository,
            WorkspaceService workspaceService,
            WorkspaceExecutionSpecService executionSpecService,
            RuntimeHeartbeatController heartbeatController) {
        this.workspaceRepository = workspaceRepository;
        this.workspaceService = workspaceService;
        this.executionSpecService = executionSpecService;
        this.heartbeatController = heartbeatController;
    }

    @GetMapping("/api/v1/workspaces/{workspaceId}/environment")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> getEnvironment(
            @PathVariable String workspaceId,
            Authentication authentication) {
        Workspace workspace = workspaceRepository.findByIdAndDeletedAtIsNull(workspaceId).orElse(null);
        if (workspace == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("code", "WORKSPACE_NOT_FOUND", "detail", "Workspace not found"));
        }

        String userId = authentication == null ? TenantContext.getUserId() : authentication.getName();
        boolean isAdmin = authentication != null && authentication.getAuthorities().stream()
                .anyMatch(authority -> "ROLE_ADMIN".equals(authority.getAuthority()));
        if (!isAdmin && !workspaceService.isWorkspaceMember(workspaceId, userId)) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                    .body(Map.of("code", "WORKSPACE_NOT_FOUND", "detail", "Workspace not found"));
        }

        WorkspaceExecutionSpec assignment = null;
        try {
            assignment = executionSpecService.findCurrentExecutionSpec(workspaceId);
        } catch (com.cc01cc.p.xihe.cp.config.CpApiException ignored) {
            // no spec yet; treat as unassigned
        }
        RuntimeHeartbeatController.RuntimeHeartbeatRequest heartbeat = heartbeatController.latestHeartbeat();

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("workspaceId", workspaceId);
        response.put("status", heartbeat == null ? "unbound" : heartbeat.status());
        response.put("storageBackend", valueOrDefault(workspace.getStorageBackend(), "host_directory"));
        response.put("storageRef", valueOrDefault(workspace.getStorageRef(), workspaceId));

        Map<String, Object> assignmentView = new LinkedHashMap<>();
        assignmentView.put("status", assignment == null ? "unassigned" : "assigned");
        assignmentView.put("generation", assignment == null ? 0 : assignment.getGeneration());
        assignmentView.put("sandboxSpecHash", assignment == null ? "" : assignment.getSandboxSpecHash());
        response.put("executionSpec", assignmentView);

        Map<String, Object> runtimeView = new LinkedHashMap<>();
        runtimeView.put("status", heartbeat == null ? "unbound" : heartbeat.status());
        runtimeView.put("deviceId", heartbeat == null ? "" : heartbeat.deviceId());
        runtimeView.put("lastHeartbeatAt", heartbeat == null ? "" : heartbeat.observedAt());
        response.put("runtime", runtimeView);
        return ResponseEntity.ok(response);
    }

    private String valueOrDefault(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }
}
