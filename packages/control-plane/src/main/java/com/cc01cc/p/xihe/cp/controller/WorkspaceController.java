package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.policy.CapabilityAuthorities;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRoot;
import com.cc01cc.p.xihe.cp.service.WorkspaceBackendPolicy;
import com.cc01cc.p.xihe.cp.service.WorkspaceNestedReposService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/workspaces")
public class WorkspaceController {

    private final WorkspaceService workspaceService;
    private final WorkspaceBackendPolicy backendPolicy;
    private final WorkspaceNestedReposService nestedReposService;

    public WorkspaceController(WorkspaceService workspaceService, WorkspaceBackendPolicy backendPolicy,
                               WorkspaceNestedReposService nestedReposService) {
        this.workspaceService = workspaceService;
        this.backendPolicy = backendPolicy;
        this.nestedReposService = nestedReposService;
    }

    @GetMapping("/current")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> current() {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        return workspaceService.findCurrentWorkspace(userId)
                .<ResponseEntity<?>>map(workspace -> ResponseEntity.ok(toMap(workspace,
                        workspaceService.ownerIdOf(workspace.getId()),
                        userId, isAdmin(), roleFor(workspace, userId),
                        workspaceService.listRoots(workspace.getId().toString()))))
                .orElseGet(() -> ProblemDetailsHandler.problemResponse(
                        HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND", "Workspace not found"));
    }

    @GetMapping
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> list() {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        return ResponseEntity.ok(workspaceService.getWorkspacesByUser(userId).stream()
                .map(workspace -> toMap(workspace, workspaceService.ownerIdOf(workspace.getId()),
                        userId, isAdmin(), roleFor(workspace, userId),
                        workspaceService.listRoots(workspace.getId().toString()))).toList());
    }

    @GetMapping("/{workspaceId}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> get(@PathVariable String workspaceId) {
        String userId = TenantContext.getUserId();
        try {
            return toView(workspaceService.requireAccessibleWorkspace(workspaceId, userId), userId, isAdmin());
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /**
     * PLAN-0641 T2.3: nested-repository discovery read face (TTL-cached CP-side;
     * contract F2). Unknown/inaccessible workspace → the same 404/403 problem as
     * {@link #get}, decided before the Runtime is touched.
     */
    @GetMapping("/{workspaceId}/nested-repos")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> nestedRepos(@PathVariable String workspaceId) {
        String userId = TenantContext.getUserId();
        try {
            return ResponseEntity.ok(nestedReposService.listNestedRepos(workspaceId, userId));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PostMapping
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> create(
            @RequestBody(required = false) CreateWorkspaceRequest request,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        try {
            // PLAN-0612 M4: the frozen docker backend is refused at creation time with a
            // stable 409 before any row/spec is written. A blank storageMode is the
            // historical default (managed_import → docker), so it is gated too.
            String requestedStorageMode = request == null ? null : request.storageMode();
            if (requestedStorageMode == null || requestedStorageMode.isBlank()) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "storageMode is required: the docker workspace backend is frozen, so create"
                                + " the workspace explicitly as direct_attach with hostPath + executionMode"
                                + " (windows-mxc|windows-host)");
            }
            if ("managed_import".equalsIgnoreCase(requestedStorageMode.trim())) {
                backendPolicy.requireCreationAllowed();
            }
            String name = request == null || request.name() == null ? "Default Workspace" : request.name();
            String description = request == null ? null : request.description();
            String profile = request == null ? null : request.profile();
            String image = request == null ? null : request.image();
            String storageMode = request == null ? null : request.storageMode();
            String hostPath = request == null ? null : request.hostPath();
            List<Map<String, String>> roots = request == null ? null : request.roots();
            String executionMode = request == null ? null : request.executionMode();
            Workspace workspace = workspaceService.createWorkspace(
                    name, description, userId, profile, image,
                    storageMode, hostPath, roots, executionMode, idempotencyKey);
            // toView already returns a ResponseEntity. Nesting it as the body
            // serializes `{body, headers, statusCode}` and hides workspace.id
            // from the UI response.
            // PLAN-0610 W4b: the creator is the owner through the WS_OWNER binding written by the service.
        return ResponseEntity.status(HttpStatus.CREATED).body(toMap(workspace,
                workspaceService.ownerIdOf(workspace.getId()), userId, isAdmin(),
                WorkspaceRole.OWNER.name(),
                workspaceService.listRoots(workspace.getId().toString())));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PatchMapping("/{workspaceId}")
    @PreAuthorize("isAuthenticated()")
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
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> delete(@PathVariable String workspaceId) {
        String userId = TenantContext.getUserId();
        try {
            workspaceService.deleteWorkspace(workspaceId, userId);
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    // ---------------------------------------------------------------- PLAN-0639 M1: root CRUD

    @PostMapping("/{workspaceId}/roots")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> addRoot(
            @PathVariable String workspaceId,
            @RequestBody(required = false) RootCreateRequest request) {
        String userId = TenantContext.getUserId();
        try {
            String path = request == null ? null : request.path();
            String alias = request == null ? null : request.alias();
            WorkspaceRoot root = workspaceService.addRoot(workspaceId, userId, path, alias);
            Workspace workspace = workspaceService.requireAccessibleWorkspace(workspaceId, userId);
            return ResponseEntity.status(HttpStatus.CREATED)
                    .body(rootToMap(workspace, root, canSeeHostPaths(workspace, userId)));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PatchMapping("/{workspaceId}/roots/{rootId}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> patchRoot(
            @PathVariable String workspaceId,
            @PathVariable String rootId,
            @RequestBody(required = false) RootPatchRequest request) {
        String userId = TenantContext.getUserId();
        try {
            String alias = request == null ? null : request.alias();
            Integer position = request == null ? null : request.position();
            WorkspaceRoot root = workspaceService.patchRoot(workspaceId, rootId, userId, alias, position);
            Workspace workspace = workspaceService.requireAccessibleWorkspace(workspaceId, userId);
            return ResponseEntity.ok(rootToMap(workspace, root, canSeeHostPaths(workspace, userId)));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @DeleteMapping("/{workspaceId}/roots/{rootId}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> deleteRoot(
            @PathVariable String workspaceId,
            @PathVariable String rootId) {
        String userId = TenantContext.getUserId();
        try {
            workspaceService.deleteRoot(workspaceId, rootId, userId);
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /** Mirrors the Workspace.hostPath rule (owner/admin only) for the B12 root path. */
    private boolean canSeeHostPaths(Workspace workspace, String userId) {
        return isAdmin() || (userId != null && userId.equals(workspaceService.ownerIdOf(workspace.getId())));
    }

    private static Map<String, Object> rootToMap(Workspace workspace, WorkspaceRoot root,
            boolean canSeePaths) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", root.getId());
        view.put("alias", root.getAlias());
        view.put("position", root.getPosition());
        // PLAN-0641 B12 (minimal additive): workspace-relative path so two roots that
        // share a leaf name stay distinguishable (rootId stays the key). Null for the
        // primary root and for callers who cannot see host paths — the same rule that
        // already governs Workspace.hostPath.
        view.put("path", canSeePaths ? workspaceRelativeRootPath(workspace, root) : null);
        return view;
    }

    /**
     * Workspace-relative POSIX path of one root, or {@code null} when the root IS the
     * workspace (primary root) or sits outside its tree. Windows paths are normalised
     * before comparing (workspace rule: forward slashes + lowercase compare).
     */
    private static String workspaceRelativeRootPath(Workspace workspace, WorkspaceRoot root) {
        String base = workspace.getHostPath();
        String candidate = root.getHostPath();
        if (base == null || candidate == null) {
            return null;
        }
        String normalizedBase = base.replace('\\', '/').replaceAll("/+$", "");
        String normalizedCandidate = candidate.replace('\\', '/').replaceAll("/+$", "");
        if (normalizedBase.isEmpty()) {
            return null;
        }
        String baseLower = normalizedBase.toLowerCase(java.util.Locale.ROOT);
        String candidateLower = normalizedCandidate.toLowerCase(java.util.Locale.ROOT);
        if (candidateLower.equals(baseLower)) {
            return null;
        }
        if (!candidateLower.startsWith(baseLower + "/")) {
            return null;
        }
        String relative = normalizedCandidate.substring(normalizedBase.length() + 1);
        return relative.isEmpty() ? null : relative;
    }

    public record RootCreateRequest(String path, String alias) {}
    public record RootPatchRequest(String alias, Integer position) {}

    private ResponseEntity<Map<String, Object>> toView(Workspace workspace, String userId, boolean admin) {
        return ResponseEntity.ok(toMap(workspace, workspaceService.ownerIdOf(workspace.getId()),
                userId, admin, roleFor(workspace, userId),
                workspaceService.listRoots(workspace.getId().toString())));
    }

    private String roleFor(Workspace workspace, String userId) {
        return workspaceService.resolveWorkspaceRole(workspace.getId().toString(), userId);
    }

    static Map<String, Object> toMap(Workspace workspace, String ownerId, String userId,
            boolean admin, String workspaceRole, java.util.List<WorkspaceRoot> roots) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", workspace.getId());
        view.put("name", workspace.getName());
        view.put("description", workspace.getDescription());
        // PLAN-0610 W4b: derived from the WS_OWNER binding (workspaces.owner_id was dropped by V89).
        view.put("ownerId", ownerId);
        view.put("storageBackend", workspace.getStorageBackend());
        view.put("storageRef", workspace.getStorageRef());
        view.put("storageMode", workspace.getStorageMode());
        view.put("hostPath", admin || (userId != null && userId.equals(ownerId))
                ? workspace.getHostPath() : null);
        // PLAN-0639 M1: ordered root projection; PLAN-0641 B12 adds the nullable
        // workspace-relative `path` for callers allowed to see host paths.
        boolean canSeePaths = admin || (userId != null && userId.equals(ownerId));
        view.put("roots", roots == null ? java.util.List.of() : roots.stream()
                .map(root -> rootToMap(workspace, root, canSeePaths)).toList());
        view.put("executionMode", workspace.getExecutionMode());
        view.put("generation", workspace.getGeneration());
        view.put("workspaceRole", workspaceRole);
        view.put("canWrite", WorkspaceRole.canWrite(workspaceRole));
        view.put("createdAt", workspace.getCreatedAt() == null ? null : workspace.getCreatedAt().toString());
        view.put("updatedAt", workspace.getUpdatedAt() == null ? null : workspace.getUpdatedAt().toString());
        return view;
    }

    /** PLAN-0610 W1b (R2-9): capability projection, never the ROLE_ADMIN authority. */
    private boolean isAdmin() {
        return CapabilityAuthorities.isInstanceAdmin();
    }

    public record CreateWorkspaceRequest(
            String name,
            String description,
            String profile,
            String image,
            String storageMode,
            String hostPath,
            List<Map<String, String>> roots,
            String executionMode) {
        /** Back-compat for the pre-0639 7-arg call sites. */
        public CreateWorkspaceRequest(String name, String description, String profile,
                String image, String storageMode, String hostPath, String executionMode) {
            this(name, description, profile, image, storageMode, hostPath, null, executionMode);
        }
    }
    public record UpdateWorkspaceRequest(String name, String description) {}
}



