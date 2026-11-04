package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalRoleBindingService;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
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
 * PLAN-0667 M1: agent-principal <b>role binding</b> API.
 *
 * <pre>
 * GET    /api/v1/agent-principals/{principalId}/roles
 * POST   /api/v1/agent-principals/{principalId}/roles
 * DELETE /api/v1/agent-principals/{principalId}/roles/{bindingId}
 * </pre>
 *
 * <p>Deliberately a separate controller: the user binding surface ({@code BindingController},
 * PLAN-0610) keeps its user-only contract and its full-replacement semantics, so an agent binding can
 * never be written through a user path (design D1(b)).</p>
 *
 * <p>Authorization is atom-based and has exactly two tiers, mirroring the memory face:</p>
 * <ul>
 *   <li>{@code MANAGE_AGENT_PRINCIPALS} (N1, instance tier) — may bind at any scope;</li>
 *   <li>{@code MANAGE_WORKSPACE_AGENTS} <b>in a workspace</b> — may bind at that workspace's scope,
 *       and only sees principals visible in that workspace.</li>
 * </ul>
 * <p>The optional {@code workspaceId} parameter is an authorization context only (same pattern as
 * V107 memory); it never becomes part of the binding key — a binding carries its own
 * {@code scopeType}/{@code scopeId}.</p>
 *
 * <p>{@code actor != subject} is enforced explicitly. In practice an agent cannot reach this surface
 * (it has no user token), but the check keeps the rule visible and cheap if that ever changes.</p>
 */
@RestController
@RequestMapping("/api/v1/agent-principals/{principalId}/roles")
public class AgentPrincipalRoleBindingController {

    private static final Set<String> BIND_KEYS = Set.of("roleId", "scopeType", "scopeId");

    private final AgentPrincipalRoleBindingService bindingService;
    private final AgentPrincipalService agentPrincipalService;
    private final RequesterAuthority requesterAuthority;

    public AgentPrincipalRoleBindingController(AgentPrincipalRoleBindingService bindingService,
                                               AgentPrincipalService agentPrincipalService,
                                               RequesterAuthority requesterAuthority) {
        this.bindingService = bindingService;
        this.agentPrincipalService = agentPrincipalService;
        this.requesterAuthority = requesterAuthority;
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping
    public ResponseEntity<?> list(@PathVariable String principalId,
                                  @RequestParam(required = false) String workspaceId) {
        try {
            Caller caller = requireBindingAuthority(principalId, workspaceId);
            List<Map<String, Object>> rows = bindingService.list(caller.principalId()).stream()
                    .map(AgentPrincipalRoleBindingController::toView).toList();
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("bindings", rows);
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
            Caller caller = requireBindingAuthority(principalId, workspaceId);
            if (body == null || !BIND_KEYS.containsAll(body.keySet())) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "Body must contain only roleId, scopeType and scopeId");
            }
            UUID roleId = parseUuid(body.get("roleId"));
            String scopeType = body.get("scopeType") instanceof String value ? value : null;
            UUID scopeId = body.get("scopeId") == null ? null : parseUuid(body.get("scopeId"));
            requireScopeAuthority(caller, scopeType, scopeId);
            AgentPrincipalRoleBindingService.AgentRoleBindingView binding = bindingService.bind(
                    caller.principalId(), roleId, scopeType, scopeId, caller.actorUuid(),
                    caller.auditWorkspaceId());
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
            Caller caller = requireBindingAuthority(principalId, workspaceId);
            UUID actor = caller.actorUuid();
            bindingService.unbind(caller.principalId(), parseUuid(bindingId), actor,
                    caller.auditWorkspaceId(), caller.instanceTier(),
                    workspace -> requesterAuthority.holdsActionAtom(actor,
                            ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS, workspace));
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /** The resolved caller, after the two-tier atom gate and the visibility check. */
    private record Caller(String actorUserId, UUID actorUuid, UUID principalId, UUID workspaceId,
                          boolean instanceTier) {
        String auditWorkspaceId() {
            return workspaceId == null ? null : workspaceId.toString();
        }
    }

    private Caller requireBindingAuthority(String principalIdValue, String workspaceIdValue) {
        String actor = TenantContext.getUserId();
        if (actor == null || actor.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Authentication required");
        }
        UUID actorUuid = parseUuid(actor);
        UUID principal = parseUuid(principalIdValue);
        UUID workspace = isBlank(workspaceIdValue) ? null : parseUuid(workspaceIdValue);
        boolean instanceTier = requesterAuthority.holdsActionAtom(
                ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS);
        boolean workspaceTier = workspace != null && requesterAuthority.holdsActionAtom(actorUuid,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS, workspace);
        if (!instanceTier && !workspaceTier) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "MANAGE_AGENT_PRINCIPALS or MANAGE_WORKSPACE_AGENTS in the authorizing workspace is required");
        }
        if (actorUuid.equals(principal)) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "an agent principal cannot administer its own bindings");
        }
        requireVisible(actor, principal, workspace, instanceTier);
        return new Caller(actor, actorUuid, principal, workspace, instanceTier);
    }

    /** Instance tier: the principal must exist. Workspace tier: it must be visible in that workspace. */
    private void requireVisible(String actor, UUID principal, UUID workspace, boolean instanceTier) {
        if (workspace == null) {
            if (!instanceTier) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                        "a workspace-scoped authority needs the authorizing workspaceId");
            }
            bindingService.requirePrincipal(principal);
            return;
        }
        boolean visible = agentPrincipalService.listWorkspaceAgents(actor, workspace).stream()
                .anyMatch(view -> principal.equals(view.principalId()));
        if (!visible) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "AGENT_PRINCIPAL_NOT_FOUND",
                    "Agent principal not found");
        }
    }

    /** A write at the instance scope needs the instance tier; a workspace scope needs its manager. */
    private void requireScopeAuthority(Caller caller, String scopeType, UUID scopeId) {
        if ("instance".equals(scopeType)) {
            if (scopeId != null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "an instance-scope binding must not carry scopeId");
            }
            if (!caller.instanceTier()) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                        "binding an instance-scope role to an agent principal requires MANAGE_AGENT_PRINCIPALS");
            }
            return;
        }
        if ("workspace".equals(scopeType)) {
            if (scopeId == null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "a workspace-scope binding requires scopeId");
            }
            boolean allowed = caller.instanceTier() || requesterAuthority.holdsActionAtom(
                    caller.actorUuid(), ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS, scopeId);
            if (!allowed) {
                throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                        "MANAGE_WORKSPACE_AGENTS in the target workspace is required");
            }
            bindingService.requireWorkspace(scopeId);
            return;
        }
        throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                "scopeType must be instance or workspace");
    }

    private static Map<String, Object> toView(
            AgentPrincipalRoleBindingService.AgentRoleBindingView view) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("bindingId", view.bindingId());
        result.put("principalId", view.principalId());
        result.put("roleId", view.roleId());
        result.put("roleName", view.roleName());
        result.put("roleDisplayName", view.roleDisplayName());
        result.put("description", view.description());
        result.put("scopeType", view.scopeType());
        result.put("scopeId", view.scopeId());
        result.put("isSystem", view.isSystem());
        result.put("atomCount", view.atomCount());
        result.put("atoms", view.atoms());
        result.put("grantedBy", view.grantedBy());
        result.put("grantedAt", view.grantedAt() == null ? null : view.grantedAt().toString());
        return result;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static UUID parseUuid(Object raw) {
        if (!(raw instanceof String value) || value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "A valid UUID is required");
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "A valid UUID is required", e);
        }
    }
}