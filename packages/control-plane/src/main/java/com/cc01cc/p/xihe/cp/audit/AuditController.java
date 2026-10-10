package com.cc01cc.p.xihe.cp.audit;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0466 T1.2: the user-facing audit read surface.
 *
 * <pre>
 * GET /api/v1/audit/entries?sessionId&amp;workspaceId&amp;type&amp;status&amp;page&amp;size
 * GET /api/v1/audit/entries/{type}/{id}
 * </pre>
 *
 * <p>Unified audit read model over the current domain owners. Scope is the TenantContext user plus optional
 * session/workspace/type/status filters; a wrong-owner detail id answers the same
 * 404 as a missing one.</p>
 */
@RestController
@RequestMapping("/api/v1/audit/entries")
@PreAuthorize("hasAnyRole('USER', 'ADMIN')")
public class AuditController {

    private static final Logger logger = LoggerFactory.getLogger(AuditController.class);

    private final AuditReadService auditReadService;
    private final WorkspaceService workspaceService;

    public AuditController(AuditReadService auditReadService, WorkspaceService workspaceService) {
        this.auditReadService = auditReadService;
        this.workspaceService = workspaceService;
    }

    @GetMapping
    public ResponseEntity<?> list(
            @RequestParam(required = false) String sessionId,
            @RequestParam(required = false) String workspaceId,
            @RequestParam(required = false) String type,
            @RequestParam(required = false) String status,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        try {
            String userId = requireUser();
            UUID session = optionalUuid(sessionId, "sessionId");
            UUID workspace = optionalUuid(workspaceId, "workspaceId");
            if (workspace != null) {
                // Cross-workspace negative: a workspace the caller cannot access is
                // answered like any other missing resource, not filtered away.
                workspaceService.requireAccessibleWorkspace(workspace.toString(), userId);
            }
            int safePage = Math.max(0, page);
            int safeSize = Math.max(1, Math.min(100, size));
            AuditReadService.AuditPage result = auditReadService.list(userId,
                    session == null ? null : session.toString(), workspace,
                    blankToNull(type), blankToNull(status), safePage, safeSize);

            Map<String, Object> body = new LinkedHashMap<>();
            body.put("entries", result.entries().stream().map(AuditViews::toUserEntry).toList());
            body.put("page", result.page());
            body.put("size", result.size());
            body.put("totalElements", result.totalElements());
            body.put("totalPages", result.totalPages());
            return ResponseEntity.ok(body);
        } catch (CpApiException e) {
            logger.warn("Audit list rejected: code={}", e.getCode());
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        } catch (IllegalArgumentException e) {
            logger.warn("Audit list rejected: malformed scope value");
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", e.getMessage());
        }
    }

    @GetMapping("/{type}/{id}")
    public ResponseEntity<?> detail(@PathVariable String type, @PathVariable String id) {
        try {
            String userId = requireUser();
            AuditReadService.AuditDetail detail =
                    auditReadService.detail(type, uuid(id, "id"), userId);
            return ResponseEntity.ok(AuditViews.envelope(detail));
        } catch (CpApiException e) {
            logger.warn("Audit detail rejected: type={} code={}", type, e.getCode());
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        } catch (IllegalArgumentException e) {
            logger.warn("Audit detail rejected: malformed owner scope value");
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", e.getMessage());
        }
    }

    private String requireUser() {
        String userId = TenantContext.getUserId();
        if (userId == null || userId.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Authentication required");
        }
        return userId;
    }

    private static UUID optionalUuid(String value, String name) {
        return blankToNull(value) == null ? null : uuid(value, name);
    }

    private static UUID uuid(String value, String name) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    name + " must be a UUID");
        }
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }
}
