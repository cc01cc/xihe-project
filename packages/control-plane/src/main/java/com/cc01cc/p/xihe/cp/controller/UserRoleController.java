package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.service.UserRoleService;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * PLAN-0580: instance role administration
 * (spec {@code api-instance-ownership-contract.md} §5).
 *
 * <pre>
 * PATCH /api/v1/users/{userId}/role   ADMIN only: USER &lt;-&gt; ADMIN
 * </pre>
 *
 * <p>The response is the role view only ({@code userId}/{@code role}) — the
 * account identifiers of the users surface belong to PLAN-0581 and stay
 * ADMIN-scoped there. The role change, the default-grant resync, the epoch bump
 * and the audit row are one transaction inside {@link UserRoleService}.
 */
@RestController
@RequestMapping("/api/v1/users")
public class UserRoleController {

    /** Body of the role change; any value outside ADMIN/USER is a 400 INVALID_ROLE. */
    public record RoleRequest(String role) {}

    private final UserRoleService userRoleService;

    public UserRoleController(UserRoleService userRoleService) {
        this.userRoleService = userRoleService;
    }

    @PatchMapping("/{userId}/role")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<Map<String, Object>> changeRole(@PathVariable String userId,
                                                         @RequestBody(required = false) RoleRequest request) {
        UserRole newRole = parseRole(request == null ? null : request.role());
        UUID targetUserId;
        try {
            targetUserId = UUID.fromString(userId);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "userId must be a UUID", e);
        }
        User updated = userRoleService.changeRole(InstanceOwnerController.callerId(), targetUserId, newRole);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("userId", updated.getId().toString());
        body.put("role", updated.getRole().name());
        return ResponseEntity.ok(body);
    }

    private static UserRole parseRole(String raw) {
        if (raw == null || raw.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ROLE",
                    "role must be ADMIN or USER");
        }
        try {
            return UserRole.valueOf(raw.trim().toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_ROLE",
                    "role must be ADMIN or USER", e);
        }
    }
}
