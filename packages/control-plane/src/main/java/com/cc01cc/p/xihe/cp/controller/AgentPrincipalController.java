package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
public class AgentPrincipalController {

    private final AgentPrincipalService agentPrincipalService;

    public AgentPrincipalController(AgentPrincipalService agentPrincipalService) {
        this.agentPrincipalService = agentPrincipalService;
    }

    @PostMapping("/api/v1/agent-principals")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> create(@RequestBody(required = false) Map<String, Object> body) {
        if (body == null || body.isEmpty() || body.size() > 2
                || !body.containsKey("name")
                || body.keySet().stream().anyMatch(key -> !"name".equals(key) && !"templateId".equals(key))
                || !(body.get("name") instanceof String name) || name.isBlank()
                || (body.containsKey("templateId") && body.get("templateId") != null
                && (!(body.get("templateId") instanceof String templateId) || templateId.isBlank()))) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                    "INVALID_REQUEST", "Body must contain name and optional templateId only");
        }
        String actorUserId = TenantContext.getUserId();
        if (actorUserId == null || actorUserId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        String templateId = body.get("templateId") instanceof String value ? value : null;
        try {
            AgentPrincipal principal = agentPrincipalService.createPrincipalFromTemplate(
                    actorUserId, name, templateId);
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("principalId", principal.getId());
            response.put("templateId", principal.getTemplateId());
            response.put("templateName", principal.getTemplateSnapshot().path("templateName").isTextual()
                    ? principal.getTemplateSnapshot().path("templateName").asText() : null);
            response.put("createdAt", principal.getCreatedAt().toString());
            return ResponseEntity.status(HttpStatus.CREATED).body(response);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }
}
