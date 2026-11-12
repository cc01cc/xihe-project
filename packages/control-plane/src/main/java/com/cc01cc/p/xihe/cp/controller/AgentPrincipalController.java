package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
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

    // PLAN-0625 Gap J / PLAN-0633 C1: Jackson-2 nodes leave through JacksonNodeExit only — the rule
    // and its rationale live there (single source), and two mechanical gates enforce it.
    // task-179: the wire body/response projections moved to AgentPrincipalWireBody /
    // AgentPrincipalWireView so the instance surface shares them instead of growing a second copy.

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

    /** Lists principals visible to the caller, optionally within one workspace. */
    @GetMapping("/api/v1/agent-principals")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> list(@RequestParam(required = false) String workspaceId) {
        String actorUserId = TenantContext.getUserId();
        if (actorUserId == null || actorUserId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        try {
            List<Map<String, Object>> principals = agentPrincipalService
                    .listPrincipals(actorUserId, workspaceId).stream()
                    .map(view -> AgentPrincipalWireView.principalView(view, objectMapper)).toList();
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
        String actorUserId = TenantContext.getUserId();
        try {
            var patch = AgentPrincipalWireBody.parseDocuments(body, objectMapper);
            if (actorUserId == null || actorUserId.isBlank()) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                        "AUTHORIZATION_REQUIRED", "Authentication required");
            }
            UUID principalUuid = parseUuid(principalId);
            AgentPrincipalService.PrincipalSettings stored = agentPrincipalService
                    .applyPrincipalSettings(actorUserId, principalUuid, patch);
            // Echo the persisted documents (null = cleared), never the caller's raw input.
            return ResponseEntity.ok(AgentPrincipalWireView.documentsView(principalUuid, stored,
                    objectMapper));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PostMapping("/api/v1/agent-principals")
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> create(@RequestBody(required = false) Map<String, Object> body) {
        try {
            // PLAN-0625 M2: shape validation lives in the service (single write-side gate);
            // here we only tree-ify the wire value (task-179: shared with the instance surface).
            AgentPrincipalWireBody.CreateBody parsed = AgentPrincipalWireBody.parseCreate(body, objectMapper);
            String actorUserId = TenantContext.getUserId();
            if (actorUserId == null || actorUserId.isBlank()) {
                return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                        "AUTHORIZATION_REQUIRED", "Authentication required");
            }
            AgentPrincipal principal = agentPrincipalService.createPrincipalFromTemplate(
                    actorUserId, parsed.name(), parsed.templateId(), parsed.defaultModelProvider(),
                    parsed.defaultModelName(), parsed.allowedModels(), parsed.hooks(), null, null,
                    parsed.roleIds());
            return ResponseEntity.status(HttpStatus.CREATED)
                    .body(AgentPrincipalWireView.createView(principal, parsed.roleIds(), objectMapper));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }
}
