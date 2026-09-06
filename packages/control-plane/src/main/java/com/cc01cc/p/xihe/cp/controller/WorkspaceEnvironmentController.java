package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceExecutionSpec;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
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
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestTemplate;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
public class WorkspaceEnvironmentController {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceEnvironmentController.class);

    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceService workspaceService;
    private final WorkspaceExecutionSpecService executionSpecService;
    private final RuntimeHeartbeatController heartbeatController;
    private final RestTemplate restTemplate;
    private final String runtimeUrl;
    private final String serviceToken;

    public WorkspaceEnvironmentController(
            WorkspaceRepository workspaceRepository,
            WorkspaceService workspaceService,
            WorkspaceExecutionSpecService executionSpecService,
            RuntimeHeartbeatController heartbeatController,
            RestTemplate restTemplate,
            @Value("${cp.mcp.runtime-url:http://localhost:12633}") String runtimeUrl,
            @Value("${cp.agent-api-token:dev-token-not-secure}") String serviceToken) {
        this.workspaceRepository = workspaceRepository;
        this.workspaceService = workspaceService;
        this.executionSpecService = executionSpecService;
        this.heartbeatController = heartbeatController;
        this.restTemplate = restTemplate;
        this.runtimeUrl = runtimeUrl;
        this.serviceToken = serviceToken;
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
        } catch (Exception e) {
            logger.warn("Runtime materialize failed workspaceId={}: {}", workspaceId, e.getMessage());
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", "Runtime is unreachable");
        }
    }
}
