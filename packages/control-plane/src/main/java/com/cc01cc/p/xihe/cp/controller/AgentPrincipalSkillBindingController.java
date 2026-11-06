package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalBindingAuthority;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalSkillBindingService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * PLAN-0667 M2: agent-principal <b>skill binding</b> API.
 *
 * <pre>
 * GET    /api/v1/agent-principals/{principalId}/skills
 * POST   /api/v1/agent-principals/{principalId}/skills        body {"skillId": "uuid"}
 * DELETE /api/v1/agent-principals/{principalId}/skills/{bindingId}
 * </pre>
 *
 * <p>PLAN-0680: the body still carries <b>only</b> {@code skillId}; the binding scope is derived
 * server-side from the authorization context ({@code workspaceId} present ⇒ workspace row, absent
 * ⇒ instance row). A caller cannot choose or smuggle a scope, so it cannot widen the atom surface.</p>
 */
@RestController
@RequestMapping("/api/v1/agent-principals/{principalId}/skills")
public class AgentPrincipalSkillBindingController {

    private static final Set<String> BIND_KEYS = Set.of("skillId");

    private final AgentPrincipalSkillBindingService bindingService;
    private final AgentPrincipalBindingAuthority authority;

    public AgentPrincipalSkillBindingController(AgentPrincipalSkillBindingService bindingService,
                                                AgentPrincipalBindingAuthority authority) {
        this.bindingService = bindingService;
        this.authority = authority;
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping
    public ResponseEntity<?> list(@PathVariable String principalId,
                                  @RequestParam(required = false) String workspaceId) {
        try {
            AgentPrincipalBindingAuthority.Caller caller = authority.require(principalId, workspaceId);
            List<Map<String, Object>> rows = bindingService.list(caller.principalId()).stream()
                    .map(AgentPrincipalSkillBindingController::toView).toList();
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("items", rows);
            return ResponseEntity.ok(response);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PreAuthorize("isAuthenticated()")
    @PostMapping
    public ResponseEntity<?> bind(@PathVariable String principalId,
                                  @RequestParam(required = false) String workspaceId,
                                  @RequestBody(required = false) Map<String, Object> body) {
        try {
            AgentPrincipalBindingAuthority.Caller caller = authority.require(principalId, workspaceId);
            if (body == null || !BIND_KEYS.containsAll(body.keySet())) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "Body must contain only skillId");
            }
            UUID skillId = AgentPrincipalBindingAuthority.parseUuid(body.get("skillId"),
                    "skillId must be a UUID");
            AgentPrincipalSkillBindingService.AgentSkillBindingView binding = bindingService.bind(
                    caller.principalId(), skillId, caller.actorUuid(), caller.workspaceId(),
                    caller.instanceTier(),
                    workspace -> authority.canManageWorkspace(caller.actorUuid(), workspace));
            return ResponseEntity.status(HttpStatus.CREATED).body(toView(binding));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PreAuthorize("isAuthenticated()")
    @DeleteMapping("/{bindingId}")
    public ResponseEntity<?> unbind(@PathVariable String principalId,
                                    @PathVariable String bindingId,
                                    @RequestParam(required = false) String workspaceId) {
        try {
            AgentPrincipalBindingAuthority.Caller caller = authority.require(principalId, workspaceId);
            bindingService.unbind(caller.principalId(),
                    AgentPrincipalBindingAuthority.parseUuid(bindingId, "A valid binding id is required"),
                    caller.actorUuid(), caller.workspaceId(), caller.instanceTier());
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    private static Map<String, Object> toView(
            AgentPrincipalSkillBindingService.AgentSkillBindingView view) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("bindingId", view.bindingId());
        result.put("principalId", view.principalId());
        result.put("skillId", view.skillId());
        result.put("name", view.name());
        result.put("description", view.description());
        result.put("sourceType", view.sourceType());
        result.put("sourceName", view.sourceName());
        result.put("tokenEstimate", view.tokenEstimate());
        result.put("createdBy", view.createdByUserId());
        result.put("createdAt", view.createdAt() == null ? null : view.createdAt().toString());
        return result;
    }
}