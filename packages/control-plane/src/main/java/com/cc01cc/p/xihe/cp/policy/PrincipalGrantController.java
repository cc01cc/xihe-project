package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * PLAN-0585: the administrator-only principal-grant surface.
 *
 * <pre>
 * GET   /api/v1/principal-grants/{username}  readable CREATE_ACCOUNT / MANAGE_WORKSPACE_AGENTS atoms
 * PATCH /api/v1/principal-grants/{username}  body { add: [atom], remove: [atom] } difference set
 * </pre>
 *
 * <p>Every endpoint is ADMIN only (decision #5: instance ADMINs are the sole granting authority);
 * a non-admin gets 403 with no target information. The target is addressed by exact username
 * (decision #12) because CP exposes no user directory. Responses are 200 with {@code changed}
 * true/false (idempotent replay, decision #7); {@code 400} for unmanageable actions or resources,
 * {@code 404 USER_NOT_FOUND} for an unknown username, {@code 409 DIRECT_GRANT_CONFLICT} for the
 * unique-index race, and {@code 503 OPERATION_LOCK_TIMEOUT} from the lock bound (handled globally).</p>
 */
@RestController
@RequestMapping("/api/v1/principal-grants")
@PreAuthorize("hasRole('ADMIN')")
public class PrincipalGrantController {

    /**
     * One requested atom; an omitted resource means the action's canonical resource. Unknown JSON
     * properties are ignored (Spring Boot default) and can never redirect the write: the path
     * username is the only target authority.
     */
    public record AtomBody(String actionClass, String resource) {}

    /** PATCH body: additive and subtractive atoms, both optional but not both absent. */
    public record PatchBody(List<AtomBody> add, List<AtomBody> remove) {}

    private final PrincipalGrantAdminService adminService;

    public PrincipalGrantController(PrincipalGrantAdminService adminService) {
        this.adminService = adminService;
    }

    @GetMapping("/{username}")
    public ResponseEntity<?> read(@PathVariable String username) {
        String actorUserId = TenantContext.getUserId();
        if (actorUserId == null || actorUserId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        try {
            return ResponseEntity.ok(adminService.read(actorUserId, username));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PatchMapping("/{username}")
    public ResponseEntity<?> patch(@PathVariable String username,
                                   @RequestBody(required = false) PatchBody body) {
        String actorUserId = TenantContext.getUserId();
        if (actorUserId == null || actorUserId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        if (body == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "A body with add and/or remove is required");
        }
        try {
            return ResponseEntity.ok(adminService.patch(actorUserId, username,
                    toInputs(body.add()), toInputs(body.remove())));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    private static List<PrincipalGrantAdminService.AtomInput> toInputs(List<AtomBody> atoms) {
        return atoms == null ? null
                : atoms.stream()
                        .map(atom -> atom == null ? null
                                : new PrincipalGrantAdminService.AtomInput(
                                        atom.actionClass(), atom.resource()))
                        .toList();
    }

    private static ResponseEntity<?> problem(CpApiException e) {
        return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
    }
}
