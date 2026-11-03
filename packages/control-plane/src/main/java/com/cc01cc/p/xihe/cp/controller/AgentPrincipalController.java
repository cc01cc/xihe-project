package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.util.JacksonNodeExit;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.UUID;
import java.util.Map;

@RestController
public class AgentPrincipalController {

    /**
     * PLAN-0622 M1.1: the frozen create body. {@code ownerUserId} is deliberately absent — the owner
     * is always the caller ({@code TenantContext.getUserId()}), so an admin cannot mint a PERSONAL
     * principal "for somebody else" (O1/O3).
     */
    private static final java.util.Set<String> ALLOWED_BODY_KEYS = java.util.Set.of(
            "name", "templateId", "scope", "defaultModelProvider", "defaultModelName", "allowedModels",
            // PLAN-0625 M2 (D25-14): hook subscriptions ride the create surface — no new endpoint.
            "hooks",
            // PLAN-0629 task-12: the roles the new principal is bound to (absent/null ⇒ defaults).
            "roleIds");

    /**
     * PLAN-0625 D25-14 + PLAN-0629 D29-21: the PATCH body carries the subject-level documents. Both
     * keys are optional, at least one is required, and any other key is a 400 (additionalProperties:false).
     */
    private static final java.util.Set<String> PATCH_BODY_KEYS = java.util.Set.of("hooks", "contextPolicy",
            // PLAN-0630 M1: the delegation budget rides the same PATCH (subject column, D23-20).
            "delegationPolicy");

    private Map<String, Object> toPrincipalView(AgentPrincipalService.AgentPrincipalView view) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("principalId", view.principalId());
        result.put("name", view.name());
        result.put("templateId", view.templateId());
        result.put("templateName", view.templateName());
        result.put("createdAt", view.createdAt() == null ? null : view.createdAt().toString());
        result.put("scope", view.scope());
        result.put("ownerUserId", view.ownerUserId() == null ? null : view.ownerUserId().toString());
        result.put("defaultModelProvider", view.defaultModelProvider());
        result.put("defaultModelName", view.defaultModelName());
        result.put("allowedModels", JacksonNodeExit.toDocument(objectMapper, view.allowedModels()));
        result.put("disabledAt", view.disabledAt() == null ? null : view.disabledAt().toString());
        result.put("hooks", JacksonNodeExit.toDocument(objectMapper, view.hooks()));
        // PLAN-0629 M1 (D29-21): the subject's memory policy is part of the principal view.
        result.put("contextPolicy", JacksonNodeExit.toDocument(objectMapper, view.contextPolicy()));
        return result;
    }

    // PLAN-0625 Gap J / PLAN-0633 C1: Jackson-2 nodes leave through JacksonNodeExit only — the rule
    // and its rationale live there (single source), and two mechanical gates enforce it.

    private static UUID parseUuid(String value) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "A valid UUID is required", e);
        }
    }

    private final AgentPrincipalService agentPrincipalService;
    private final ObjectMapper objectMapper;

    public AgentPrincipalController(AgentPrincipalService agentPrincipalService,
                                     ObjectMapper objectMapper) {
        this.agentPrincipalService = agentPrincipalService;
        this.objectMapper = objectMapper;
    }

    /**
     * PLAN-0622 M1.2: `GET /api/v1/agent-principals?scope=&workspaceId=` → `{principals:[…]}`.
     * The tier filter is mandatory-by-semantics: `PERSONAL` never leaks another account's rows,
     * `WORKSPACE` requires a workspace id the caller is a member of.
     */
    @GetMapping("/api/v1/agent-principals")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> list(@RequestParam(required = false) String scope,
                                  @RequestParam(required = false) String workspaceId) {
        String actorUserId = TenantContext.getUserId();
        if (actorUserId == null || actorUserId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        try {
            List<Map<String, Object>> principals = agentPrincipalService
                    .listPrincipals(actorUserId, scope, workspaceId).stream()
                    .map(this::toPrincipalView).toList();
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("principals", principals);
            return ResponseEntity.ok(response);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /** PLAN-0622 M1.2: `POST /api/v1/agent-principals/{id}/disable` → `204` (idempotent). */
    @PostMapping("/api/v1/agent-principals/{principalId}/disable")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> disable(@PathVariable String principalId) {
        String actorUserId = TenantContext.getUserId();
        if (actorUserId == null || actorUserId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        try {
            agentPrincipalService.disablePrincipal(actorUserId, parseUuid(principalId));
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /**
     * PLAN-0625 M2 (D25-14, Gap K): the subscription update surface. Ruling: no separate
     * {@code /hooks} or {@code /context-policy} sub-resource — the principal's own update face accepts
     * the documents, so the existing tier authority (and the {@code GUARD_HOOKS_IMMUTABLE} refusal) is
     * reused verbatim.
     *
     * <p>The body is {@code {"hooks"?: <object|null>, "contextPolicy"?: <object|null>}}
     * ({@code additionalProperties:false}): at least one key is required, any other key is a 400
     * {@code INVALID_REQUEST}, and an explicit {@code null} clears that document. Validation lives in
     * the service (single write-side gate). The response echoes the persisted documents.</p>
     */
    @PatchMapping("/api/v1/agent-principals/{principalId}")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> updateDocuments(@PathVariable String principalId,
                                             @RequestBody(required = false) Map<String, Object> body) {
        if (body == null || body.isEmpty()
                || body.keySet().stream().anyMatch(key -> !PATCH_BODY_KEYS.contains(key))) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                    "INVALID_REQUEST",
                    "Body must contain hooks, contextPolicy and/or delegationPolicy (object or null)");
        }
        String actorUserId = TenantContext.getUserId();
        if (actorUserId == null || actorUserId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        try {
            var patch = new AgentPrincipalService.PrincipalSettingsPatch(
                    body.get("hooks") == null ? null : objectMapper.valueToTree(body.get("hooks")),
                    body.containsKey("hooks"),
                    body.get("contextPolicy") == null
                            ? null : objectMapper.valueToTree(body.get("contextPolicy")),
                    body.containsKey("contextPolicy"),
                    body.get("delegationPolicy") == null
                            ? null : objectMapper.valueToTree(body.get("delegationPolicy")),
                    body.containsKey("delegationPolicy"));
            AgentPrincipalService.PrincipalSettings stored = agentPrincipalService
                    .applyPrincipalSettings(actorUserId, parseUuid(principalId), patch);
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("principalId", principalId);
            // Echo the persisted documents (null = cleared), never the caller's raw input.
            response.put("hooks", JacksonNodeExit.toDocument(objectMapper, stored.hooks()));
            response.put("contextPolicy", JacksonNodeExit.toDocument(objectMapper, stored.contextPolicy()));
            response.put("delegationPolicy",
                    JacksonNodeExit.toDocument(objectMapper, stored.delegationPolicy()));
            return ResponseEntity.ok(response);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
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
                            + "defaultModelProvider, defaultModelName, allowedModels and hooks only");
        }
        String actorUserId = TenantContext.getUserId();
        if (actorUserId == null || actorUserId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        String templateId = body.get("templateId") instanceof String value ? value : null;
        String scope = body.get("scope") instanceof String scopeValue ? scopeValue : null;
        // PLAN-0629 task-12: roleIds is a plain array of uuids; anything else is a 400 at the wire
        // edge (the service owns the "does it exist / may it be bound here" questions).
        java.util.List<java.util.UUID> roleIds = new java.util.ArrayList<>();
        if (body.get("roleIds") != null) {
            if (!(body.get("roleIds") instanceof java.util.List<?> rawRoleIds)) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                        "INVALID_REQUEST", "roleIds must be an array of role ids");
            }
            for (Object rawRoleId : rawRoleIds) {
                if (!(rawRoleId instanceof String roleIdText) || roleIdText.isBlank()) {
                    return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                            "INVALID_REQUEST", "roleIds must be an array of role ids");
                }
                try {
                    roleIds.add(java.util.UUID.fromString(roleIdText));
                } catch (IllegalArgumentException notAUuid) {
                    return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                            "INVALID_REQUEST", "roleIds must be an array of role ids");
                }
            }
        }
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
            // PLAN-0625 M2: shape validation lives in the service (single write-side gate);
            // here we only tree-ify the wire value.
            JsonNode hooks = body.get("hooks") == null ? null
                    : objectMapper.valueToTree(body.get("hooks"));
            AgentPrincipal principal = agentPrincipalService.createPrincipalFromTemplate(
                    actorUserId, name, templateId, scope, defaultModelProvider, defaultModelName,
                    allowedModels, hooks, null, null, roleIds);
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
            response.put("allowedModels", JacksonNodeExit.toDocument(objectMapper, principal.getAllowedModels()));
            // PLAN-0625 M2: the subscription surface round-trips like the rest of the capability view.
            response.put("hooks", JacksonNodeExit.toDocument(objectMapper, principal.getHooks()));
            // PLAN-0629 M1 (Lead ruling 2026-11-02): a create always answers with the memory policy too
            // (null = off), so the caller learns immediately whether memory is on for the new subject.
            response.put(
                    "contextPolicy", JacksonNodeExit.toDocument(objectMapper, principal.getContextPolicy()));
            // PLAN-0629 task-12: echo the bound roles so the caller does not have to re-read the list.
            response.put("roleIds", roleIds);
            return ResponseEntity.status(HttpStatus.CREATED).body(response);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }
}
