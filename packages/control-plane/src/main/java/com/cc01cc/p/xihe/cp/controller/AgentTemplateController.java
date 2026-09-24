package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.AgentTemplateService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/agent-templates")
@PreAuthorize("hasAnyRole('USER', 'ADMIN')")
public class AgentTemplateController {

    private static final Set<String> LAYERS = Set.of("instance", "user", "workspace");

    private final AgentTemplateService agentTemplateService;
    private final ObjectMapper objectMapper;

    public AgentTemplateController(AgentTemplateService agentTemplateService, ObjectMapper objectMapper) {
        this.agentTemplateService = agentTemplateService;
        this.objectMapper = objectMapper;
    }

    @GetMapping
    public ResponseEntity<?> list(@RequestParam(value = "layer", required = false) String layer,
                                  @RequestParam(value = "workspaceId", required = false) String workspaceId) {
        if (layer == null || !LAYERS.contains(layer)) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                    "INVALID_REQUEST", "layer must be one of instance, user, workspace");
        }
        String actorUserId = TenantContext.getUserId();
        if (actorUserId == null || actorUserId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        String resolvedWorkspaceId = workspaceId == null || workspaceId.isBlank() ? null : workspaceId;
        if ("workspace".equals(layer) && resolvedWorkspaceId == null) {
            resolvedWorkspaceId = TenantContext.getWorkspaceId();
        }
        UUID workspaceUuid = null;
        if (resolvedWorkspaceId != null) {
            try {
                workspaceUuid = UUID.fromString(resolvedWorkspaceId);
            } catch (IllegalArgumentException e) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                        "INVALID_REQUEST", "workspaceId must be a valid UUID");
            }
        }
        try {
            AgentTemplateService.TemplateListView view = agentTemplateService.listForCaller(
                    actorUserId, layer, "workspace".equals(layer) ? workspaceUuid : null);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("layer", view.layer());
            body.put("workspaceId", view.workspaceId() == null ? null : view.workspaceId().toString());
            body.put("templates", objectMapper.convertValue(view.templates(), List.class));
            return ResponseEntity.ok(body);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }
}
