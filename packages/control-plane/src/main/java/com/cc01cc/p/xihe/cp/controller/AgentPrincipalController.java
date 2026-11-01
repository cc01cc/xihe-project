package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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

    /**
     * PLAN-0622 M1.1: the frozen create body. {@code ownerUserId} is deliberately absent — the owner
     * is always the caller ({@code TenantContext.getUserId()}), so an admin cannot mint a PERSONAL
     * principal "for somebody else" (O1/O3).
     */
    private static final java.util.Set<String> ALLOWED_BODY_KEYS = java.util.Set.of(
            "name", "templateId", "scope", "defaultModelProvider", "defaultModelName", "allowedModels");

    private final AgentPrincipalService agentPrincipalService;
    private final ObjectMapper objectMapper;

    public AgentPrincipalController(AgentPrincipalService agentPrincipalService,
                                     ObjectMapper objectMapper) {
        this.agentPrincipalService = agentPrincipalService;
        this.objectMapper = objectMapper;
    }

    @PostMapping("/api/v1/agent-principals")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> create(@RequestBody(required = false) Map<String, Object> body) {
        if (body == null || body.isEmpty()
                || !body.containsKey("name")
                || body.keySet().stream().anyMatch(key -> !ALLOWED_BODY_KEYS.contains(key))
                || !(body.get("name") instanceof String name) || name.isBlank()
                || (body.containsKey("templateId") && body.get("templateId") != null
                && (!(body.get("templateId") instanceof String templateId) || templateId.isBlank()))
                || (body.containsKey("scope") && body.get("scope") != null
                && !(body.get("scope") instanceof String))
                || (body.containsKey("defaultModelProvider") && body.get("defaultModelProvider") != null
                && !(body.get("defaultModelProvider") instanceof String))
                || (body.containsKey("defaultModelName") && body.get("defaultModelName") != null
                && !(body.get("defaultModelName") instanceof String))) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                    "INVALID_REQUEST", "Body must contain name plus optional templateId, scope, "
                            + "defaultModelProvider, defaultModelName and allowedModels only");
        }
        String actorUserId = TenantContext.getUserId();
        if (actorUserId == null || actorUserId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        String templateId = body.get("templateId") instanceof String value ? value : null;
        String scope = body.get("scope") instanceof String scopeValue ? scopeValue : null;
        String defaultModelProvider = body.get("defaultModelProvider") instanceof String provider
                ? provider : null;
        String defaultModelName = body.get("defaultModelName") instanceof String model ? model : null;
        JsonNode allowedModels = null;
        if (body.get("allowedModels") != null) {
            try {
                allowedModels = objectMapper.valueToTree(body.get("allowedModels"));
            } catch (IllegalArgumentException e) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                        "INVALID_REQUEST", "allowedModels must be an array of {provider, model}");
            }
        }
        try {
            AgentPrincipal principal = agentPrincipalService.createPrincipalFromTemplate(
                    actorUserId, name, templateId, scope, defaultModelProvider, defaultModelName,
                    allowedModels);
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("principalId", principal.getId());
            response.put("templateId", principal.getTemplateId());
            response.put("templateName", principal.getTemplateSnapshot().path("templateName").isTextual()
                    ? principal.getTemplateSnapshot().path("templateName").asText() : null);
            response.put("createdAt", principal.getCreatedAt().toString());
            // PLAN-0622: the tier, its owner and the model intent are part of the wire contract.
            response.put("scope", principal.getScope());
            response.put("ownerUserId",
                    principal.getOwnerUserId() == null ? null : principal.getOwnerUserId().toString());
            response.put("defaultModelProvider", principal.getDefaultModelProvider());
            response.put("defaultModelName", principal.getDefaultModelName());
            response.put("allowedModels", principal.getAllowedModels());
            return ResponseEntity.status(HttpStatus.CREATED).body(response);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }
}
