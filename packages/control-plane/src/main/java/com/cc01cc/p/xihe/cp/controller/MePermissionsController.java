package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.auth.CapabilityProjectionService;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * PLAN-0610 W3-2b: {@code GET /api/v1/me/permissions} — the caller's own effective capabilities.
 *
 * <p>Read-only self-service surface (design §3.5): instance-scope atoms plus one entry per active
 * workspace membership. The data source is the materialized {@code grants} union plus the
 * binding-backed capability projection; {@code users.role} is never read. No other subject's
 * permissions are reachable from here (no path/query parameter).</p>
 */
@RestController
@RequestMapping("/api/v1/me")
public class MePermissionsController {

    private final CapabilityProjectionService projection;

    public MePermissionsController(CapabilityProjectionService projection) {
        this.projection = projection;
    }

    @GetMapping("/permissions")
    @PreAuthorize("isAuthenticated()")
    public CapabilityProjectionService.SelfPermissions permissions() {
        String userId = TenantContext.getUserId();
        return projection.permissionsFor(userId == null ? null : java.util.UUID.fromString(userId));
    }
}
