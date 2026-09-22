package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceExecutionSpec;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import com.cc01cc.p.xihe.cp.service.WorkspaceExecutionSpecService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

@RestController
public class WorkspaceEnvironmentController {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceEnvironmentController.class);

    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceService workspaceService;
    private final WorkspaceExecutionSpecService executionSpecService;
    private final RuntimeHeartbeatController heartbeatController;
    private final RuntimeJobClient runtimeJobClient;
    private final RestTemplate restTemplate;
    private final String runtimeUrl;
    private final String serviceToken;

    public WorkspaceEnvironmentController(
            WorkspaceRepository workspaceRepository,
            WorkspaceService workspaceService,
            WorkspaceExecutionSpecService executionSpecService,
            RuntimeHeartbeatController heartbeatController,
            RuntimeJobClient runtimeJobClient,
            RestTemplate restTemplate,
            @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl,
            @Value("${cp.agent-api-token:dev-token-not-secure}") String serviceToken) {
        this.workspaceRepository = workspaceRepository;
        this.workspaceService = workspaceService;
        this.executionSpecService = executionSpecService;
        this.heartbeatController = heartbeatController;
        this.runtimeJobClient = runtimeJobClient;
        this.restTemplate = restTemplate;
        this.runtimeUrl = runtimeUrl;
        this.serviceToken = serviceToken;
    }

    @GetMapping("/api/v1/workspaces/{workspaceId}/environment")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> getEnvironment(
            @PathVariable String workspaceId,
            Authentication authentication) {
        Workspace workspace = workspaceRepository.findByIdAndDeletedAtIsNull(UUID.fromString(workspaceId)).orElse(null);
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
        response.put("hostPath", workspace.getHostPath());
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
        } else if (result.containerJobs()) {
            view.put("backendKind", "docker");
            view.put("available", false);
            view.put("unavailableReason", "CONTAINER_JOBS_SERVED_BY_DOCKER");
        } else if (result.capability() == null) {
            view.put("backendKind", executionMode);
            view.put("available", false);
            view.put("unavailableReason",
                    result.problemCode() == null ? "RUNTIME_CAPABILITY_MISSING" : result.problemCode());
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
        }
        view.put("checkedAt", java.time.Instant.now().toString());
        return view;
    }

    private Map<String, Object> readWorkspaceRuntimeStatus(String workspaceId) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setBearerAuth(serviceToken);
            ResponseEntity<Map> response = restTemplate.exchange(
                    runtimeUrl + "/internal/v1/runtime/workspaces/" + workspaceId + "/status",
                    org.springframework.http.HttpMethod.GET,
                    new HttpEntity<>(headers),
                    Map.class);
            Map<String, Object> body = response.getBody();
            if (body == null) return Map.of("status", "unbound");
            Map<String, Object> result = new LinkedHashMap<>(body);
            result.put("status", mapRuntimeState(body.get("state")));
            return result;
        } catch (HttpClientErrorException.NotFound e) {
            return Map.of("status", "unbound");
        } catch (Exception e) {
            logger.warn("Workspace Runtime status unavailable workspaceId={}: {}",
                    workspaceId, e.getMessage());
            return runtimeStatusUnavailableView();
        }
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
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.setBearerAuth(serviceToken);
            ResponseEntity<Map> response = restTemplate.postForEntity(
                    runtimeUrl + "/internal/v1/runtime/workspaces/" + workspaceId + "/materialize",
                    new HttpEntity<>(Map.of(), headers),
                    Map.class);
            if (!response.getStatusCode().is2xxSuccessful()) {
                logger.warn("Runtime materialize rejected workspaceId={} status={}",
                        workspaceId, response.getStatusCode());
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", "Runtime rejected the materialize request");
            }
            Object body = response.getBody();
            return ResponseEntity.accepted().body(body == null ? Map.of("status", "accepted") : body);
        } catch (HttpClientErrorException e) {
            // PLAN-0345 (decision #11): pass Runtime Problem status/code/detail
            // through unchanged — destroying-conflict (409 WORKSPACE_DESTROYING)
            // must never collapse into 502 RUNTIME_UNAVAILABLE.
            Map<String, Object> runtimeProblem = e.getResponseBodyAs(Map.class);
            String code = runtimeProblem != null && runtimeProblem.get("code") instanceof String c
                    ? c
                    : "RUNTIME_ERROR";
            String detail = runtimeProblem != null && runtimeProblem.get("detail") instanceof String d
                    ? d
                    : e.getMessage();
            logger.warn("Runtime materialize problem workspaceId={} status={} code={}",
                    workspaceId, e.getStatusCode(), code);
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.valueOf(e.getStatusCode().value()), code, detail);
        } catch (Exception e) {
            logger.warn("Runtime materialize failed workspaceId={}: {}", workspaceId, e.getMessage());
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", "Runtime is unreachable");
        }
    }
}
