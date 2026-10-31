package com.cc01cc.p.xihe.cp.policy;

import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * PLAN-0610 W3-2a: the binding surface (design §3.5).
 *
 * <pre>
 * GET /api/v1/bindings?scope=instance|workspace&scopeId=…   the scope's complete user binding set
 * PUT /api/v1/bindings?scope=instance|workspace&scopeId=…   full replacement of that set
 * </pre>
 *
 * <p>{@code GET} is a full read and {@code PUT} a full replacement: the body is the desired end
 * state, not a delta, so a retry with the same body is a no-op. The scope selector is validated
 * server-side ({@code 400 INVALID_SCOPE}, {@code 404 WORKSPACE_NOT_FOUND}) and never trusted as an
 * authorization fact — the service re-checks {@code MANAGE_ROLES} and, for a workspace, that the
 * caller holds {@code MANAGE_WORKSPACE_AGENTS} <em>in that workspace</em>.</p>
 *
 * <p>Body shape: {@code {"bindings":[{"subjectId":"<uuid>","roleId":"<uuid>"}]}}; {@code
 * subjectType} is optional and must be {@code user} when present (agent principals carry their own
 * {@code spawn}/{@code template} sources, not role bindings).</p>
 */
@RestController
@RequestMapping("/api/v1/bindings")
public class BindingController {

    private static final String MANAGE_ROLES_GATE =
            "@requesterAuthority.holdsActionAtom('MANAGE_ROLES')";

    private final BindingAdminService bindingAdminService;

    public BindingController(BindingAdminService bindingAdminService) {
        this.bindingAdminService = bindingAdminService;
    }

    @GetMapping
    @PreAuthorize(MANAGE_ROLES_GATE)
    public RoleAdminViews.BindingSetView list(
            @RequestParam(value = "scope", required = false) String scope,
            @RequestParam(value = "scopeId", required = false) String scopeId) {
        return bindingAdminService.list(scope, scopeId);
    }

    /** Body of the full replacement; {@code bindings} is required (send {@code []} to clear). */
    public record ReplaceBindingsRequest(List<RoleAdminViews.BindingInput> bindings) {
    }

    @PutMapping
    @PreAuthorize(MANAGE_ROLES_GATE)
    public RoleAdminViews.BindingSetView replace(
            @RequestParam(value = "scope", required = false) String scope,
            @RequestParam(value = "scopeId", required = false) String scopeId,
            @RequestBody ReplaceBindingsRequest request) {
        return bindingAdminService.replace(scope, scopeId,
                request == null ? null : request.bindings());
    }
}
