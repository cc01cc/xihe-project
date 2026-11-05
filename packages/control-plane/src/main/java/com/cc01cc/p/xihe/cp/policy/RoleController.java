package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/**
 * PLAN-0610 W3-2a: the access-role definition surface (design §3.5).
 *
 * <pre>
 * GET    /api/v1/roles/catalog      18 atoms (15 action + 3 capability) with scope_class
 * GET    /api/v1/roles              every definition (system roles first)
 * POST   /api/v1/roles              create a custom role
 * PATCH  /api/v1/roles/{roleId}     rename / re-describe / re-atom a custom role; system roles:
 *                                   display name only (409 SYSTEM_ROLE_IMMUTABLE)
 * DELETE /api/v1/roles/{roleId}     204; system role or still-bound role → 409
 * </pre>
 *
 * <p>The admin gate is {@code MANAGE_ROLES}. It is an <b>action atom</b>, so it cannot be an authority
 * (decision #23 / R2-5: only capability atoms become {@code cap:*} authorities); the expression
 * therefore asks {@link RequesterAuthority} to evaluate the grant rows with the same scoped read
 * the kernel uses. Adding a fourth capability atom for this gate would break the vocabulary the rest
 * of the plan relies on.</p>
 *
 * <p>PLAN-0667 addendum (Lead ruling 2026-11-05, real-stack gap 1): a caller who may <b>bind agents</b>
 * ({@code MANAGE_WORKSPACE_AGENTS} in the {@code workspaceId} context, or the instance-tier
 * {@code MANAGE_AGENT_PRINCIPALS}) can also {@code GET /roles} — but only the agent-bindable
 * subset ({@link RoleAdminService#listAgentBindable()}). Otherwise the 0667 binding picker had no
 * candidates for a workspace OWNER (the old gate answered 403). Callers holding {@code MANAGE_ROLES}
 * keep the full admin list, so the role settings panel is unchanged.</p>
 *
 * <p>The controller only translates HTTP; validation, locking, materialization, cache invalidation
 * and auditing live in {@link RoleAdminService}.</p>
 */
@RestController
@RequestMapping("/api/v1/roles")
public class RoleController {

    private static final String MANAGE_ROLES_GATE =
            "@requesterAuthority.holdsActionAtom('MANAGE_ROLES')";

    private final RoleAdminService roleAdminService;
    private final RequesterAuthority requesterAuthority;

    public RoleController(RoleAdminService roleAdminService, RequesterAuthority requesterAuthority) {
        this.roleAdminService = roleAdminService;
        this.requesterAuthority = requesterAuthority;
    }

    /**
     * The atom vocabulary with server-resolved display labels (D51-37). {@code locale} is explicit
     * ({@code zh-CN} default, {@code en-US} supported) so the UI never carries a label table of its
     * own; an unknown value falls back to {@code zh-CN}.
     */
    @GetMapping("/catalog")
    @PreAuthorize(MANAGE_ROLES_GATE)
    public RoleAdminViews.CatalogView catalog(
            @RequestParam(value = "locale", required = false) String locale) {
        return roleAdminService.catalog(locale);
    }

    /**
     * Admin view: every definition. Agent-binding view: only the bindable candidates, when the
     * caller manages agents in the given workspace (or holds the instance-tier atom). The optional
     * {@code workspaceId} is an authorization context only — role definitions are instance-wide, so
     * there is no workspace-owned role to leak (see {@link RoleAdminService#listAgentBindable()}).
     */
    @GetMapping
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<List<RoleAdminViews.RoleView>> list(
            @RequestParam(value = "workspaceId", required = false) String workspaceId) {
        if (requesterAuthority.holdsActionAtom(ToolFaceRegistry.ACTION_MANAGE_ROLES)) {
            return ResponseEntity.ok(roleAdminService.list());
        }
        UUID subject = requesterAuthority.currentSubjectId();
        UUID workspace = parseWorkspaceId(workspaceId);
        boolean instanceTier = requesterAuthority.holdsActionAtom(
                ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS);
        boolean workspaceTier = workspace != null && requesterAuthority.holdsActionAtom(subject,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS, workspace);
        if (!instanceTier && !workspaceTier) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "MANAGE_ROLES, MANAGE_AGENT_PRINCIPALS or MANAGE_WORKSPACE_AGENTS in the "
                            + "authorizing workspace is required to read role candidates");
        }
        return ResponseEntity.ok(roleAdminService.listAgentBindable());
    }

    @PostMapping
    @PreAuthorize(MANAGE_ROLES_GATE)
    public ResponseEntity<RoleAdminViews.RoleView> create(
            @RequestBody RoleAdminViews.RoleCreate request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(roleAdminService.create(request));
    }

    @PatchMapping("/{roleId}")
    @PreAuthorize(MANAGE_ROLES_GATE)
    public RoleAdminViews.RoleView update(@PathVariable UUID roleId,
                                          @RequestBody RoleAdminViews.RoleUpdate request) {
        return roleAdminService.update(roleId, request);
    }

    @DeleteMapping("/{roleId}")
    @PreAuthorize(MANAGE_ROLES_GATE)
    public ResponseEntity<Void> delete(@PathVariable UUID roleId) {
        roleAdminService.delete(roleId);
        return ResponseEntity.noContent().build();
    }

    private static UUID parseWorkspaceId(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "A valid workspaceId is required", e);
        }
    }
}