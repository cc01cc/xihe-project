package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.service.WorkspaceRuntimeReleaseService;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * PLAN-0391: user-triggered "release execution resources" for one Workspace.
 *
 * <p>Authorization (decision #29): any member with Workspace access
 * ({@code OWNER}/{@code MEMBER}); platform {@code ADMIN} reuses the environment
 * GET's admin bypass; a non-member gets 404 (indistinguishable from unknown).</p>
 */
@RestController
public class WorkspaceRuntimeReleaseController {

    private final WorkspaceService workspaceService;
    private final WorkspaceRuntimeReleaseService releaseService;

    public WorkspaceRuntimeReleaseController(WorkspaceService workspaceService,
                                             WorkspaceRuntimeReleaseService releaseService) {
        this.workspaceService = workspaceService;
        this.releaseService = releaseService;
    }

    @PostMapping("/api/v1/workspaces/{workspaceId}/runtime/release")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> release(
            @PathVariable String workspaceId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            Authentication authentication) {
        String userId = authentication == null ? TenantContext.getUserId() : authentication.getName();
        boolean isAdmin = authentication != null && authentication.getAuthorities().stream()
                .anyMatch(authority -> "ROLE_ADMIN".equals(authority.getAuthority()));
        Workspace workspace = workspaceService.findActiveWorkspace(workspaceId).orElse(null);
        if (workspace == null || (!isAdmin && !workspaceService.isWorkspaceMember(workspaceId, userId))) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND", "Workspace not found");
        }
        try {
            WorkspaceRuntimeReleaseService.ReleaseOutcome outcome =
                    releaseService.release(workspaceId, userId, idempotencyKey);
            HttpStatus status = outcome.replayed() ? HttpStatus.OK : HttpStatus.ACCEPTED;
            return ResponseEntity.status(status).body(outcome.operation());
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }
}
