package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
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
                .<ResponseEntity<?>>map(workspace -> toView(workspace, userId, isAdmin()))
                .orElseGet(() -> ProblemDetailsHandler.problemResponse(
                        HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND", "Workspace not found"));
    }

    @GetMapping
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> list() {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        return ResponseEntity.ok(workspaceService.getWorkspacesByUser(userId).stream()
                .map(workspace -> toMap(workspace, userId, isAdmin())).toList());
    }

    @GetMapping("/{workspaceId}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> get(@PathVariable String workspaceId) {
        String userId = TenantContext.getUserId();
        try {
            return toView(workspaceService.requireAccessibleWorkspace(workspaceId, userId), userId, isAdmin());
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PostMapping
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> create(
            @RequestBody(required = false) CreateWorkspaceRequest request,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        try {
            String name = request == null || request.name() == null ? "Default Workspace" : request.name();
            String description = request == null ? null : request.description();
            String profile = request == null ? null : request.profile();
            String image = request == null ? null : request.image();
            String storageMode = request == null ? null : request.storageMode();
            String hostPath = request == null ? null : request.hostPath();
            String executionMode = request == null ? null : request.executionMode();
            Workspace workspace = workspaceService.createWorkspace(
                    name, description, userId, profile, image,
                    storageMode, hostPath, executionMode, idempotencyKey);
            // toView already returns a ResponseEntity. Nesting it as the body
            // serializes `{body, headers, statusCode}` and hides workspace.id
            // from the UI response.
            return ResponseEntity.status(HttpStatus.CREATED).body(toMap(workspace, userId, isAdmin()));
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
            return toView(workspace, userId, isAdmin());
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

    private ResponseEntity<Map<String, Object>> toView(Workspace workspace, String userId, boolean admin) {
        return ResponseEntity.ok(toMap(workspace, userId, admin));
    }

    static Map<String, Object> toMap(Workspace workspace, String userId, boolean admin) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", workspace.getId());
        view.put("name", workspace.getName());
        view.put("description", workspace.getDescription());
        view.put("ownerId", workspace.getOwnerId());
        view.put("storageBackend", workspace.getStorageBackend());
        view.put("storageRef", workspace.getStorageRef());
        view.put("storageMode", workspace.getStorageMode());
        view.put("hostPath", admin || (userId != null && userId.equals(workspace.getOwnerId()))
                ? workspace.getHostPath() : null);
        view.put("executionMode", workspace.getExecutionMode());
        view.put("generation", workspace.getGeneration());
        view.put("createdAt", workspace.getCreatedAt() == null ? null : workspace.getCreatedAt().toString());
        view.put("updatedAt", workspace.getUpdatedAt() == null ? null : workspace.getUpdatedAt().toString());
        return view;
    }

    private boolean isAdmin() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        return authentication != null && authentication.getAuthorities().stream()
                .anyMatch(authority -> "ROLE_ADMIN".equals(authority.getAuthority()));
    }

    public record CreateWorkspaceRequest(
            String name,
            String description,
            String profile,
            String image,
            String storageMode,
            String hostPath,
            String executionMode) {}
    public record UpdateWorkspaceRequest(String name, String description) {}
}
