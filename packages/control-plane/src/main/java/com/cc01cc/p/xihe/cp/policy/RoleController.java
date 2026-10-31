package com.cc01cc.p.xihe.cp.policy;

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
 * <p>The gate is {@code MANAGE_ROLES}. It is an <b>action atom</b>, so it cannot be an authority
 * (decision #23 / R2-5: only capability atoms become {@code cap:*} authorities); the expression
 * therefore asks {@link RequesterAuthority} to evaluate the grant rows with the same scoped read
 * the kernel uses. Adding a fourth capability atom for this gate would break the vocabulary the rest
 * of the plan relies on.</p>
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

    public RoleController(RoleAdminService roleAdminService) {
        this.roleAdminService = roleAdminService;
    }

    @GetMapping("/catalog")
    @PreAuthorize(MANAGE_ROLES_GATE)
    public RoleAdminViews.CatalogView catalog() {
        return roleAdminService.catalog();
    }

    @GetMapping
    @PreAuthorize(MANAGE_ROLES_GATE)
    public ResponseEntity<List<RoleAdminViews.RoleView>> list() {
        return ResponseEntity.ok(roleAdminService.list());
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
}
