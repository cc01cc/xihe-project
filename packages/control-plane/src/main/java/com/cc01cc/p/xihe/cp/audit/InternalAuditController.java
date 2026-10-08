package com.cc01cc.p.xihe.cp.audit;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * PLAN-0466 service-Bearer audit read surface replacing the retired operation trace route.
 *
 * <pre>
 * GET /internal/v1/audit/entries/{type}/{id}
 * </pre>
 *
 * <p>Authenticated as INTERNAL_SERVICE by SecurityConfig. The projection is
 * {@link AuditViews#toInternalEntry} (user tier + identity/correlation keys) and
 * still never carries prompt content, credentials or raw arguments — the internal
 * tier widens references, not data.</p>
 */
@RestController
@RequestMapping("/internal/v1/audit/entries")
public class InternalAuditController {

    private static final Logger logger = LoggerFactory.getLogger(InternalAuditController.class);

    private final AuditReadService auditReadService;

    public InternalAuditController(AuditReadService auditReadService) {
        this.auditReadService = auditReadService;
    }

    @GetMapping("/{type}/{id}")
    public ResponseEntity<?> detail(@PathVariable String type, @PathVariable String id) {
        try {
            AuditReadService.AuditDetail detail =
                    auditReadService.detail(type, entryId(id), null);
            return ResponseEntity.ok(AuditController.envelope(detail));
        } catch (CpApiException e) {
            logger.warn("Internal audit detail rejected: type={} code={}", type, e.getCode());
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        } catch (IllegalArgumentException e) {
            logger.warn("Internal audit detail rejected: malformed entry id");
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "id must be a UUID");
        }
    }

    private static UUID entryId(String id) {
        try {
            return UUID.fromString(id);
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "id must be a UUID");
        }
    }
}
