package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.util.JacksonNodeExit;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/workspaces/{workspaceId}/agents")
public class WorkspaceAgentController {

    private final AgentPrincipalService agentPrincipalService;
    private final ObjectMapper objectMapper;

    public WorkspaceAgentController(AgentPrincipalService agentPrincipalService, ObjectMapper objectMapper) {
        this.agentPrincipalService = agentPrincipalService;
        this.objectMapper = objectMapper;
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping
    public ResponseEntity<?> list(@PathVariable String workspaceId) {
        try {
            List<Map<String, Object>> views = agentPrincipalService.listWorkspaceAgents(
                    requireActor(), parseUuid(workspaceId)).stream()
                    .map(this::toView).toList();
            // PLAN-0622 M1.2 frozen envelope: `{agents:[…]}` (was a bare array before).
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("agents", views);
            return ResponseEntity.ok(response);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PreAuthorize("isAuthenticated()")
    @PutMapping("/{principalId}")
    public ResponseEntity<?> update(@PathVariable String workspaceId, @PathVariable String principalId,
                                    @RequestBody(required = false) Map<String, Object> body) {
        if (body == null || body.size() != 1 || !(body.get("permissions") instanceof List<?> permissions)) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                    "INVALID_REQUEST", "Body must contain only a permissions array");
        }
        try {
            WorkspaceAgent binding = agentPrincipalService.setWorkspaceCap(
                    requireActor(), parseUuid(workspaceId), parseUuid(principalId),
                    objectMapper.valueToTree(permissions));
            return ResponseEntity.ok(Map.of(
                    "principalId", binding.getId().getPrincipalId(),
                    "workspaceId", binding.getId().getWorkspaceId(),
                    "permissions", toValue(binding.getPermissionsSnapshot())));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PreAuthorize("isAuthenticated()")
    @DeleteMapping("/{principalId}")
    public ResponseEntity<?> remove(@PathVariable String workspaceId, @PathVariable String principalId) {
        try {
            boolean removed = agentPrincipalService.unbindWorkspace(
                    requireActor(), parseUuid(workspaceId), parseUuid(principalId));
            if (!removed) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND,
                        "WORKSPACE_AGENT_NOT_FOUND", "Workspace Agent binding not found");
            }
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    private Map<String, Object> toView(AgentPrincipalService.WorkspaceAgentView view) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("principalId", view.principalId());
        result.put("name", view.name());
        result.put("templateId", view.templateId());
        result.put("templateName", view.templateName());
        result.put("createdAt", view.createdAt().toString());
        // PLAN-0622 M1.2: `permissions` -> `permissionsSnapshot`, plus the mandatory `source`.
        result.put("permissionsSnapshot", toValue(view.permissions()));
        result.put("source", view.source());
        // D26: whether this row is bound to the workspace (visible-without-binding rows are false).
        result.put("bound", view.bound());
        // task-83 Gap D: hook subscriptions — the subscription row must light up on the wire.
        // PLAN-0625 Gap I: hooks are an *object* document ({advisors:[…]}), not the permissions
        // array — the array projection below silently answered `[]` for every row, so the UI could
        // never render the subscription.
        result.put("hooks", JacksonNodeExit.toDocument(objectMapper, view.hooks()));
        // D27: `disabledAt` is projected as a boolean — the UI gates badges/buttons on it.
        result.put("disabled", view.disabled());
        return result;
    }

    // PLAN-0625 Gap I/J / PLAN-0633 C1: Jackson-2 nodes leave through JacksonNodeExit only — the rule
    // and its rationale live there (single source), and two mechanical gates enforce it.

    private static List<Map<String, String>> toValue(JsonNode permissions) {
        List<Map<String, String>> result = new java.util.ArrayList<>();
        if (permissions != null && permissions.isArray()) {
            for (JsonNode permission : permissions) {
                Map<String, String> atom = new LinkedHashMap<>();
                atom.put("actionClass", permission.path("actionClass").asText());
                if (permission.has("resource")) {
                    atom.put("resource", permission.path("resource").asText());
                }
                result.add(atom);
            }
        }
        return result;
    }

    private String requireActor() {
        String actor = TenantContext.getUserId();
        if (actor == null || actor.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        return actor;
    }

    private UUID parseUuid(String value) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "A valid UUID is required", e);
        }
    }
}
