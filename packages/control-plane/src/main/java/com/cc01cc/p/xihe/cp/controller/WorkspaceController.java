package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/workspaces")
public class WorkspaceController {

    private final WorkspaceService workspaceService;

    public WorkspaceController(WorkspaceService workspaceService) {
        this.workspaceService = workspaceService;
    }

    @GetMapping("/current")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> current() {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        return workspaceService.findCurrentWorkspace(userId)
                .<ResponseEntity<?>>map(this::toView)
                .orElseGet(() -> ProblemDetailsHandler.problemResponse(
                        HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND", "Workspace not found"));
    }

    @GetMapping("/{workspaceId}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> get(@PathVariable String workspaceId) {
        String userId = TenantContext.getUserId();
        try {
            return toView(workspaceService.requireAccessibleWorkspace(workspaceId, userId));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PostMapping
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> create(@RequestBody(required = false) CreateWorkspaceRequest request) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        try {
            String name = request == null || request.name() == null ? "Default Workspace" : request.name();
            String description = request == null ? null : request.description();
            Workspace workspace = workspaceService.createWorkspace(name, description, userId);
            return ResponseEntity.status(HttpStatus.CREATED).body(toView(workspace));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PatchMapping("/{workspaceId}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> update(
            @PathVariable String workspaceId,
            @RequestBody(required = false) UpdateWorkspaceRequest request) {
        String userId = TenantContext.getUserId();
        try {
            String name = request == null ? null : request.name();
            String description = request == null ? null : request.description();
            Workspace workspace = workspaceService.updateWorkspace(workspaceId, userId, name, description);
            return toView(workspace);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @DeleteMapping("/{workspaceId}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> delete(@PathVariable String workspaceId) {
        String userId = TenantContext.getUserId();
        try {
            workspaceService.deleteWorkspace(workspaceId, userId);
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    private ResponseEntity<Map<String, Object>> toView(Workspace workspace) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", workspace.getId());
        view.put("name", workspace.getName());
        view.put("description", workspace.getDescription());
        view.put("ownerId", workspace.getOwnerId());
        view.put("storageBackend", workspace.getStorageBackend());
        view.put("storageRef", workspace.getStorageRef());
        view.put("generation", workspace.getGeneration());
        view.put("createdAt", workspace.getCreatedAt() == null ? null : workspace.getCreatedAt().toString());
        view.put("updatedAt", workspace.getUpdatedAt() == null ? null : workspace.getUpdatedAt().toString());
        return ResponseEntity.ok(view);
    }

    public record CreateWorkspaceRequest(String name, String description) {}
    public record UpdateWorkspaceRequest(String name, String description) {}
}
