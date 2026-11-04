package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0655 human delegation surface. Phase 1 ships the read view; the spawn route
 * (POST …/delegation-spawn, contract `8a546e3f`) lands in the same controller once the
 * approval replay is wired.
 */
@RestController
@RequestMapping("/api/v1/sessions/{sessionId}")
public class DelegationController {

    private final SessionService sessionService;
    private final DelegationBudgetService delegationBudgetService;

    public DelegationController(SessionService sessionService,
                                DelegationBudgetService delegationBudgetService) {
        this.sessionService = sessionService;
        this.delegationBudgetService = delegationBudgetService;
    }

    /**
     * Read-only delegation budget view. Resolved at the same evaluation point as the budget
     * gate ({@link DelegationBudgetService#usageFor}); an unreadable stored policy fails
     * closed with the gate's own 409 DELEGATION_POLICY_INVALID.
     */
    @PreAuthorize("isAuthenticated()")
    @GetMapping("/delegation-usage")
    public ResponseEntity<?> usage(@PathVariable String sessionId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.workspaceContextRequired();
        }
        UUID sessionUuid;
        try {
            sessionUuid = UUID.fromString(sessionId);
        } catch (IllegalArgumentException invalid) {
            return ProblemDetailsHandler.problemResponse(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_REQUEST", "sessionId must be a UUID");
        }
        Session session;
        try {
            session = sessionService.requireCurrent(sessionUuid.toString(), userId, workspaceId);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        DelegationBudgetService.DelegationUsage usage;
        try {
            usage = delegationBudgetService.usageFor(session);
        } catch (DelegationRefusedException refused) {
            return ProblemDetailsHandler.problemResponse(refused.getStatus(), refused.getCode(),
                    refused.getMessage());
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("rootSessionId", usage.rootSessionId());
        body.put("usedSessions", usage.usedSessions());
        body.put("maxCount", usage.maxCount());
        body.put("currentDepth", usage.currentDepth());
        body.put("maxDepth", usage.maxDepth());
        body.put("principalId", usage.principalId());
        body.put("principalName", usage.principalName());
        body.put("policySource", usage.policySource());
        body.put("disabled", usage.disabled());
        return ResponseEntity.ok(body);
    }
}
