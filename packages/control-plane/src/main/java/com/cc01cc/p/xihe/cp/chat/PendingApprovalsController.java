package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Cross-session pending-approval indicator (PLAN-0328 M1 T1.16, spec/ui-ux.md §1.2).
 *
 * <p>Counts only — never tool arguments or approval details (spec/approval.md §15). Visible scope
 * is resolved from the authenticated identity: the caller's own userId + workspaceId.</p>
 */
@RestController
@RequestMapping("/api/v1/approvals")
public class PendingApprovalsController {

    private final ApprovalService approvalService;

    public PendingApprovalsController(ApprovalService approvalService) {
        this.approvalService = approvalService;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/pending")
    public ResponseEntity<?> pending() {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        return ResponseEntity.ok(approvalService.pendingSummaries(userId, workspaceId));
    }
}
