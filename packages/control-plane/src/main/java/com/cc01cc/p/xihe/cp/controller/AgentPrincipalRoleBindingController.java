package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomLabels;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalBindingAuthority;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalRoleBindingService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
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
 * never be written through a user path (design D1(b)). The two-tier gate lives in
 * {@link AgentPrincipalBindingAuthority} because the skill surface uses exactly the same rule.</p>
 *
 * <p>{@code atoms} in the response are <b>localized short labels</b> (never machine names): the
 * locale comes from {@code ?locale=} when given, else the {@code Accept-Language} header, else
 * {@code zh-CN} ({@link PermissionAtomLabels#normalize}). {@code atomCount} is the real distinct
 * atom count, so the UI can show "first three + 共 N 个" without exposing the whole atom set.</p>
 */
@RestController
@RequestMapping("/api/v1/agent-principals/{principalId}/roles")
public class AgentPrincipalRoleBindingController {

    private static final Set<String> BIND_KEYS = Set.of("roleId");

    private final AgentPrincipalRoleBindingService bindingService;
    private final AgentPrincipalBindingAuthority authority;

    public AgentPrincipalRoleBindingController(AgentPrincipalRoleBindingService bindingService,
                                               AgentPrincipalBindingAuthority authority) {
        this.bindingService = bindingService;
        this.authority = authority;
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping
    public ResponseEntity<?> list(@PathVariable String principalId,
                                  @RequestParam(required = false) String workspaceId,
                                  @RequestParam(required = false) String locale,
                                  @RequestHeader(value = "Accept-Language", required = false) String acceptLanguage) {
        try {
            AgentPrincipalBindingAuthority.Caller caller = authority.require(principalId, workspaceId);
            String resolvedLocale = resolveLocale(locale, acceptLanguage);
            List<Map<String, Object>> rows = bindingService.list(caller.principalId(), resolvedLocale)
                    .stream().map(AgentPrincipalRoleBindingController::toView).toList();
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
                                  @RequestParam(required = false) String locale,
                                  @RequestHeader(value = "Accept-Language", required = false) String acceptLanguage,
                                  @RequestBody(required = false) Map<String, Object> body) {
        try {
            AgentPrincipalBindingAuthority.Caller caller = authority.require(principalId, workspaceId);
            if (body == null || !BIND_KEYS.containsAll(body.keySet())) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "Body must contain only roleId");
            }
            UUID roleId = AgentPrincipalBindingAuthority.parseUuid(body.get("roleId"),
                    "roleId must be a UUID");
            UUID actor = caller.actorUuid();
            AgentPrincipalRoleBindingService.AgentRoleBindingView binding = bindingService.bind(
                    caller.principalId(), roleId, actor, caller.workspaceId(), caller.instanceTier(),
                    workspace -> authority.canManageWorkspace(actor, workspace),
                    resolveLocale(locale, acceptLanguage));
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
            UUID actor = caller.actorUuid();
            bindingService.unbind(caller.principalId(),
                    AgentPrincipalBindingAuthority.parseUuid(bindingId, "A valid binding id is required"),
                    actor, caller.auditWorkspaceId(), caller.instanceTier(),
                    workspace -> authority.canManageWorkspace(actor, workspace));
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /**
     * PLAN-0667 addendum (Lead ruling 2026-11-05, real-stack gap 2): the scope is server-derived —
     * a {@code workspaceId} authorization context means workspace scope, no context means the
     * instance scope (which needs {@code MANAGE_AGENT_PRINCIPALS}). Nothing here trusts a
     * client-supplied scope, so this method deliberately has no scope branch to audit.
     */
    private static String resolveLocale(String locale, String acceptLanguage) {
        return PermissionAtomLabels.normalize(locale != null ? locale : acceptLanguage);
    }

    private static Map<String, Object> toView(
            AgentPrincipalRoleBindingService.AgentRoleBindingView view) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("bindingId", view.bindingId());
        result.put("principalId", view.principalId());
        result.put("roleId", view.roleId());
        result.put("name", view.name());
        result.put("displayName", view.displayName());
        result.put("description", view.description());
        result.put("scopeType", view.scopeType());
        result.put("scopeId", view.scopeId());
        result.put("scopeName", view.scopeName());
        result.put("isSystem", view.isSystem());
        result.put("atomCount", view.atomCount());
        result.put("atoms", view.atoms());
        result.put("grantedBy", view.grantedBy());
        result.put("grantedAt", view.grantedAt() == null ? null : view.grantedAt().toString());
        return result;
    }
}