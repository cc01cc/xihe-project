package com.cc01cc.p.xihe.cp.config;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * PLAN-0556: the admin-only lock surface.
 *
 * <pre>
 * GET    /api/v1/config-locks?domain=        catalog + current locks
 * PUT    /api/v1/config-locks/{domain}/{key} lock/update (value + lock row)
 * DELETE /api/v1/config-locks/{domain}/{key} unlock (optional clearValue)
 * </pre>
 *
 * <p>Every endpoint is ADMIN only; a non-admin gets 403 without any key names.</p>
 */
@RestController
@RequestMapping("/api/v1/config-locks")
@PreAuthorize("hasRole('ADMIN')")
public class ConfigLockController {

    /** Lock request body; {@code mode} is optional (v1 always enforce_value). */
    public record LockRequest(String mode, String reason, String value, Long revision) {}

    private final ConfigLockAdminService adminService;

    public ConfigLockController(ConfigLockAdminService adminService) {
        this.adminService = adminService;
    }

    @GetMapping
    public ResponseEntity<?> catalog(@RequestParam(value = "domain", required = false) String domain) {
        try {
            return ResponseEntity.ok(adminService.catalog(domain));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PutMapping("/{domain}/{key}")
    public ResponseEntity<?> lock(@PathVariable String domain, @PathVariable String key,
                                  @RequestBody(required = false) LockRequest body) {
        LockRequest request = body == null ? new LockRequest(null, null, null, 0L) : body;
        try {
            return ResponseEntity.ok(adminService.lock(domain, key, request.mode(), request.reason(),
                    request.value(), request.revision(), actor()));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        } catch (ConfigService.ConfigAccessException e) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.FORBIDDEN, "FORBIDDEN", "Configuration lock is not allowed");
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", e.getMessage());
        }
    }

    @DeleteMapping("/{domain}/{key}")
    public ResponseEntity<?> unlock(@PathVariable String domain, @PathVariable String key,
                                    @RequestParam(value = "revision", required = false) Long revision,
                                    @RequestParam(value = "clearValue", defaultValue = "false") boolean clearValue) {
        try {
            adminService.unlock(domain, key, revision, clearValue, actor());
            return ResponseEntity.ok(Map.of("status", "ok"));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", e.getMessage());
        }
    }

    private static String actor() {
        String userId = TenantContext.getUserId();
        return userId == null || userId.isBlank() ? "admin" : userId;
    }
}
