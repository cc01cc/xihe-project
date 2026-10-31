package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.auth.UserAdminView;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.UserStatus;
import com.cc01cc.p.xihe.cp.service.UserAdminService;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.springframework.data.domain.Page;
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

/**
 * PLAN-0581 §3: the user-management surface (6 routes, ADMIN only).
 *
 * <pre>
 * GET    /api/v1/users                              list (q/role/status/includeDeleted/page/size)
 * GET    /api/v1/users/{userId}                     detail
 * POST   /api/v1/users                              create (+ one-time temporaryPassword)
 * PATCH  /api/v1/users/{userId}/status              ACTIVE|DISABLED
 * DELETE /api/v1/users/{userId}                     soft delete (204)
 * POST   /api/v1/users/{userId}/password-reset      one-time temporaryPassword
 * </pre>
 *
 * <p>{@code PATCH /api/v1/users/{userId}/role} is <b>not</b> here: it belongs to
 * PLAN-0580 ({@link UserRoleController}). The two controllers share the
 * {@code /api/v1/users} base path, which is fine — different classes, disjoint
 * sub-paths.
 *
 * <p>All writes delegate to {@link UserAdminService}, which owns the instance
 * lock, the guard order, the dual-channel revocation and the audit rows. This
 * class only translates HTTP shapes.
 */
@RestController
@RequestMapping("/api/v1/users")
public class UserAdminController {

    /** Body of the status change; anything outside ACTIVE/DISABLED is 400 INVALID_STATUS. */
    public record StatusRequest(String status) {}

    /** Body of the admin create route: password is optional (server generates one then). */
    public record CreateUserRequest(String email, String username, String role, String password,
                                    String name) {}

    private final UserAdminService userAdminService;

    public UserAdminController(UserAdminService userAdminService) {
        this.userAdminService = userAdminService;
    }

    @GetMapping
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<Map<String, Object>> list(
            @RequestParam(value = "q", required = false) String q,
            @RequestParam(value = "role", required = false) String role,
            @RequestParam(value = "status", required = false) String status,
            @RequestParam(value = "includeDeleted", required = false, defaultValue = "false")
            boolean includeDeleted,
            @RequestParam(value = "page", required = false, defaultValue = "0") int page,
            @RequestParam(value = "size", required = false, defaultValue = "20") int size) {
        Page<UserAdminView> result = userAdminService.list(q, parseRoleFilter(role),
                parseStatusFilter(status, false), includeDeleted, page, size);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("items", result.getContent());
        body.put("total", result.getTotalElements());
        body.put("page", result.getNumber());
        body.put("size", result.getSize());
        return ResponseEntity.ok(body);
    }

    @GetMapping("/{userId}")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<UserAdminView> detail(@PathVariable String userId) {
        return ResponseEntity.ok(userAdminService.detail(parseUserId(userId)));
    }

    @PostMapping
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<Map<String, Object>> create(
            @RequestBody(required = false) CreateUserRequest request) {
        if (request == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Request body is required");
        }
        UserAdminService.CreatedUser created = userAdminService.createUser(
                InstanceOwnerController.callerId(), request.email(), request.username(),
                request.role(), request.password(), request.name());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("user", created.view());
        if (created.temporaryPassword() != null) {
            // Contract §3: appears exactly once, only when the caller did not supply one.
            body.put("temporaryPassword", created.temporaryPassword());
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(body);
    }

    @PatchMapping("/{userId}/status")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<UserAdminView> changeStatus(@PathVariable String userId,
                                                     @RequestBody(required = false) StatusRequest request) {
        UserStatus status = parseStatusFilter(request == null ? null : request.status(), true);
        return ResponseEntity.ok(userAdminService.changeStatus(
                InstanceOwnerController.callerId(), parseUserId(userId), status));
    }

    @DeleteMapping("/{userId}")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<Void> softDelete(@PathVariable String userId) {
        userAdminService.softDelete(InstanceOwnerController.callerId(), parseUserId(userId));
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{userId}/password-reset")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<Map<String, Object>> resetPassword(@PathVariable String userId) {
        String temporaryPassword = userAdminService.resetPassword(
                InstanceOwnerController.callerId(), parseUserId(userId));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("temporaryPassword", temporaryPassword);
        return ResponseEntity.ok(body);
    }

    private static UUID parseUserId(String raw) {
        try {
            return UUID.fromString(raw);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "userId must be a UUID", e);
        }
    }

    private static UserRole parseRoleFilter(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return UserRole.valueOf(raw.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "role filter must be ADMIN or USER", e);
        }
    }

    /**
     * Two shapes on purpose: a list filter may be omitted (null = no filter), while
     * the PATCH body must name a status — a missing value there is 400
     * INVALID_STATUS, never a silent no-op.
     */
    private static UserStatus parseStatusFilter(String raw, boolean required) {
        if (raw == null || raw.isBlank()) {
            if (required) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_STATUS",
                        "status must be ACTIVE or DISABLED");
            }
            return null;
        }
        try {
            return UserStatus.valueOf(raw.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_STATUS",
                    "status must be ACTIVE or DISABLED", e);
        }
    }
}
