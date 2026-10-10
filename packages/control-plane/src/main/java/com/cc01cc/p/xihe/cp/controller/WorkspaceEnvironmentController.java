package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceExecutionSpec;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import com.cc01cc.p.xihe.cp.runtime.RuntimeWorkspaceClient;
import com.cc01cc.p.xihe.cp.runtime.RuntimeWorkspaceFileClient;
import com.cc01cc.p.xihe.cp.service.WorkspaceExecutionSpecService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
public class WorkspaceEnvironmentController {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceEnvironmentController.class);

    private final WorkspaceService workspaceService;
    private final WorkspaceExecutionSpecService executionSpecService;
    private final RuntimeHeartbeatState heartbeatState;
    private final RuntimeJobClient runtimeJobClient;
    private final RuntimeWorkspaceClient runtimeWorkspaceClient;

    public WorkspaceEnvironmentController(
            WorkspaceService workspaceService,
            WorkspaceExecutionSpecService executionSpecService,
            RuntimeHeartbeatState heartbeatState,
            RuntimeJobClient runtimeJobClient,
            RuntimeWorkspaceClient runtimeWorkspaceClient) {
        this.workspaceService = workspaceService;
        this.executionSpecService = executionSpecService;
        this.heartbeatState = heartbeatState;
        this.runtimeJobClient = runtimeJobClient;
        this.runtimeWorkspaceClient = runtimeWorkspaceClient;
    }

    @GetMapping("/api/v1/workspaces/{workspaceId}/environment")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> getEnvironment(
            @PathVariable String workspaceId,
            Authentication authentication) {
        Workspace workspace = workspaceService.findActiveWorkspace(workspaceId).orElse(null);
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
        RuntimeHeartbeatState.RuntimeHeartbeatRequest heartbeat = heartbeatState.latest();
        Map<String, Object> workspaceRuntime = readWorkspaceRuntimeStatus(workspaceId);
        String materializationStatus = workspaceRuntime.getOrDefault("status", "unbound").toString();

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("workspaceId", workspaceId);
        // Heartbeat is device-wide. It cannot prove that this workspace has
        // been materialized, so the per-workspace Runtime status is canonical.
        response.put("status", materializationStatus);
        response.put("storageBackend", valueOrDefault(workspace.getStorageBackend(), "host_directory"));
        response.put("storageRef", valueOrDefault(workspace.getStorageRef(), workspaceId));
        response.put("storageMode", valueOrDefault(workspace.getStorageMode(), "managed_import"));
        response.put("hostPath", visibleHostPath(workspace, userId, isAdmin));
        response.put("executionMode", valueOrDefault(workspace.getExecutionMode(), "docker"));
        response.put("capability", workspaceService.capabilitySnapshot(workspace));
        // PLAN-0396：Job 可用性来自 Runtime capabilities（单一事实源），
        // 探测失败只降级本块，不影响 environment 其余字段。
        response.put("jobCapability", jobCapabilityView(
                valueOrDefault(workspace.getExecutionMode(), "docker"),
                runtimeJobClient.jobCapabilities(workspaceId)));

        Map<String, Object> assignmentView = new LinkedHashMap<>();
        assignmentView.put("status", assignment == null ? "unassigned" : "assigned");
        assignmentView.put("generation", assignment == null ? 0 : assignment.getGeneration());
        assignmentView.put("sandboxSpecHash", assignment == null ? "" : assignment.getSandboxSpecHash());
        response.put("executionSpec", assignmentView);

        Map<String, Object> runtimeView = new LinkedHashMap<>();
        runtimeView.put("status", materializationStatus);
        runtimeView.put("deviceId", heartbeat == null ? "" : heartbeat.deviceId());
        runtimeView.put("lastHeartbeatAt", heartbeat == null ? "" : heartbeat.observedAt());
        if (workspaceRuntime.containsKey("state")) {
            runtimeView.put("materializationState", workspaceRuntime.get("state"));
        }
        if (workspaceRuntime.containsKey("lastError")) {
            runtimeView.put("lastError", workspaceRuntime.get("lastError"));
        }
        response.put("runtime", runtimeView);
        return ResponseEntity.ok(response);
    }

    @PatchMapping("/api/v1/workspaces/{workspaceId}/execution-mode")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> changeExecutionMode(
            @PathVariable String workspaceId,
            @RequestBody(required = false) ExecutionModeRequest request,
            Authentication authentication) {
        String userId = authentication == null ? TenantContext.getUserId() : authentication.getName();
        boolean isAdmin = authentication != null && authentication.getAuthorities().stream()
                .anyMatch(authority -> "ROLE_ADMIN".equals(authority.getAuthority()));
        try {
            Workspace workspace = workspaceService.changeExecutionMode(
                    workspaceId,
                    userId,
                    isAdmin,
                    request == null ? null : request.executionMode());
            return ResponseEntity.ok(Map.of(
                    "workspaceId", workspace.getId(),
                    "storageMode", workspace.getStorageMode(),
                    "executionMode", workspace.getExecutionMode(),
                    "status", "accepted"));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /**
     * PLAN-0384 T1.3/V2: public capability preflight so the create/import UI can
     * show the real execution backend before a Workspace is persisted. A
     * reachable Runtime reporting {@code available:false} is a 200 with its
     * {@code reason}; only an unreachable Runtime or invalid JSON is 502
     * {@code RUNTIME_UNAVAILABLE}.
     */
    @PostMapping("/api/v1/workspaces/capabilities/preflight")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> preflightWorkspaceCapability(
            @RequestBody(required = false) WorkspaceCapabilityPreflightRequest request) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        try {
            return ResponseEntity.ok(workspaceService.preflightDirectAttach(
                    request == null ? null : request.storageMode(),
                    request == null ? null : request.hostPath(),
                    request == null ? null : request.executionMode()));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /**
     * PLAN-0396 决策 #3/#6：能力块三态映射。能力字段只从 Runtime 回包白名单
     * 透传，禁止键（pid/policyPath/tier 等）不进入 CP 响应。
     */
    static Map<String, Object> jobCapabilityView(
            String executionMode,
            RuntimeJobClient.JobCapabilityResult result) {
        Map<String, Object> view = new LinkedHashMap<>();
        if (result == null || !result.reachable()) {
            view.put("backendKind", executionMode);
            view.put("available", false);
            view.put("unavailableReason", "RUNTIME_UNREACHABLE");
            view.put("fileOperations", unavailableFileOperations(executionMode, "RUNTIME_UNREACHABLE"));
        } else if (result.containerJobs()) {
            view.put("backendKind", "docker");
            view.put("available", false);
            view.put("unavailableReason", "CONTAINER_JOBS_SERVED_BY_DOCKER");
            view.put("fileOperations", unavailableFileOperations("docker", "DEFERRED_DOCKER_FILE_WORKER"));
        } else if (result.capability() == null) {
            view.put("backendKind", executionMode);
            view.put("available", false);
            String reason = result.problemCode() == null ? "RUNTIME_CAPABILITY_MISSING" : result.problemCode();
            view.put("unavailableReason", reason);
            view.put("fileOperations", unavailableFileOperations(executionMode, reason));
        } else {
            com.fasterxml.jackson.databind.JsonNode node = result.capability();
            view.put("backendKind", node.path("backendKind").asText(executionMode));
            view.put("backendRevision", node.path("backendRevision").asText(""));
            view.put("maturity", node.path("maturity").asText(""));
            view.put("executionMode", node.path("executionMode").asText(executionMode));
            view.put("canStart", node.path("canStart").asBoolean(false));
            view.put("canCancel", node.path("canCancel").asBoolean(false));
            view.put("canStreamOutput", node.path("canStreamOutput").asBoolean(false));
            view.put("canIsolateFilesystem", node.path("canIsolateFilesystem").asBoolean(false));
            boolean available = node.path("available").asBoolean(false);
            view.put("available", available);
            String reason = node.path("unavailableReason").asText(null);
            view.put("unavailableReason", reason == null || reason.isBlank() ? null : reason);
            if (node.has("fileOperations")) {
                view.put("fileOperations", node.get("fileOperations"));
            } else {
                view.put("fileOperations", unavailableFileOperations(executionMode,
                        available ? "FILE_CAPABILITY_MISSING" : "FILE_CAPABILITY_UNAVAILABLE"));
            }
        }
        view.put("checkedAt", java.time.Instant.now().toString());
        return view;
    }

    private static Map<String, Object> unavailableFileOperations(String executionMode, String reason) {
        List<String> names = List.of(
                "read_file", "read_file_range", "list_directory", "get_file_info", "glob", "grep",
                "watch_directory", "extract_pdf_text", "write_file", "write_binary", "edit_file",
                "delete_file", "delete_directory", "mkdir", "move_file", "copy_file", "apply_patch");
        Map<String, Object> operations = new LinkedHashMap<>();
        for (String name : names) {
            Map<String, Object> operation = new LinkedHashMap<>();
            operation.put("available", false);
            operation.put("reason", reason);
            operations.put(name, operation);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("contractVersion", "v1");
        result.put("executionMode", executionMode);
        result.put("maxMutationBytes", RuntimeWorkspaceFileClient.MAX_WORKSPACE_FILE_BYTES);
        result.put("workerLifecycle", "per-operation");
        result.put("operations", operations);
        return result;
    }

    static String visibleHostPath(Workspace workspace, String userId, boolean admin) {
        return admin || (userId != null && userId.equals(workspace.getOwnerId()))
                ? workspace.getHostPath() : null;
    }

    private Map<String, Object> readWorkspaceRuntimeStatus(String workspaceId) {
        // PLAN-0470: Runtime HTTP mechanics live in RuntimeWorkspaceClient; the
        // adapter only maps the outcome into the environment projection.
        RuntimeWorkspaceClient.RuntimeStatusResult result =
                runtimeWorkspaceClient.fetchStatusDetailed(workspaceId);
        if (result.unbound()) {
            return Map.of("status", "unbound");
        }
        if (result.unreachable()) {
            return runtimeStatusUnavailableView();
        }
        Map<String, Object> body = result.body();
        Map<String, Object> view = new LinkedHashMap<>(body);
        view.put("status", mapRuntimeState(body.get("state")));
        return view;
    }

    /**
     * PLAN-0379 T3.7: the projection a Workspace keeps when the Runtime cannot
     * report status — the Workspace row is never deleted by a Runtime failure,
     * so the view stays readable and explicitly says why.
     */
    static Map<String, Object> runtimeStatusUnavailableView() {
        return Map.of("status", "blocked", "lastError", "Runtime status unavailable");
    }

    static String mapRuntimeState(Object rawState) {
        String state = rawState == null ? "" : rawState.toString().toLowerCase();
        // PLAN-0345 (decision #17/F4): 6-state mapping. `creating/paused/
        // stopped/destroying` must surface as themselves — never fall into
        // `degraded` (V7 assertion).
        return switch (state) {
            case "ready" -> "ready";
            case "creating", "materializing" -> "materializing";
            case "paused" -> "paused";
            case "stopped" -> "stopped";
            case "destroying" -> "destroying";
            case "failed" -> "blocked";
            case "released", "" -> "unbound";
            default -> "degraded";
        };
    }

    private String valueOrDefault(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }

    public record ExecutionModeRequest(String executionMode) {}

    /** PLAN-0384 T1.3: preflight body; {@code storageMode} defaults to {@code direct_attach}. */
    public record WorkspaceCapabilityPreflightRequest(
            String storageMode,
            String hostPath,
            String executionMode) {}

    /**
     * PLAN-262 M4 (decision 12): explicit async materialization trigger.
     * Proxies to the Runtime materialize endpoint and returns 202 immediately;
     * the UI polls GET .../environment for progress. Membership is enforced
     * via requireAccessibleWorkspace (404 on unknown or foreign workspace).
     */
    @PostMapping("/api/v1/workspaces/{workspaceId}/materialize")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> materialize(
            @PathVariable String workspaceId,
            Authentication authentication) {
        String userId = authentication == null ? TenantContext.getUserId() : authentication.getName();
        try {
            workspaceService.requireAccessibleWorkspace(workspaceId, userId);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        RuntimeWorkspaceClient.MaterializeResult result = runtimeWorkspaceClient.materialize(workspaceId);
        if (result.unreachable()) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", "Runtime is unreachable");
        }
        if ("RUNTIME_REJECTED".equals(result.problemCode())) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", result.problemDetail());
        }
        if (result.problemCode() != null) {
            // PLAN-0345 (decision #11): pass Runtime Problem status/code/detail
            // through unchanged — destroying-conflict (409 WORKSPACE_DESTROYING)
            // must never collapse into 502 RUNTIME_UNAVAILABLE.
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.valueOf(result.httpStatus()), result.problemCode(), result.problemDetail());
        }
        Object body = result.body();
        return ResponseEntity.accepted().body(body == null ? Map.of("status", "accepted") : body);
    }
}
