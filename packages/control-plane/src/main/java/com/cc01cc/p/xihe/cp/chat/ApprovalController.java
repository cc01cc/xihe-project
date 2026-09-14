package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/v1/chat/approvals")
public class ApprovalController {

    private final ApprovalService approvalService;

    public ApprovalController(ApprovalService approvalService) {
        this.approvalService = approvalService;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/{requestId}/decision")
    public ResponseEntity<?> decide(@PathVariable String requestId, @RequestBody Map<String, Object> body) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        try {
            return ResponseEntity.ok(approvalService.decide(requestId, userId, workspaceId, parseDecision(body)));
        } catch (com.cc01cc.p.xihe.cp.config.CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /**
     * PLAN-0328 M1: accepts the new {@code decision} body and keeps the legacy {@code approved}
     * boolean working (mapped to once / reject). Unknown shapes fail closed with 400.
     */
    private static ApprovalDecision parseDecision(Map<String, Object> body) {
        if (body == null) {
            throw new com.cc01cc.p.xihe.cp.config.CpApiException(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "decision or approved is required");
        }
        Object rawDecision = body.get("decision");
        Object rawApproved = body.get("approved");
        ApprovalDecision.Kind kind;
        if (rawDecision != null) {
            kind = ApprovalDecision.Kind.fromWire(String.valueOf(rawDecision));
        } else if (rawApproved instanceof Boolean approved) {
            kind = approved ? ApprovalDecision.Kind.ONCE : ApprovalDecision.Kind.REJECT;
        } else {
            throw new com.cc01cc.p.xihe.cp.config.CpApiException(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "decision or approved is required");
        }
        String actionClass = null;
        String resource = null;
        Object rule = body.get("rule");
        if (rule instanceof Map<?, ?> ruleMap) {
            actionClass = asText(ruleMap.get("actionClass"));
            resource = asText(ruleMap.get("resource"));
        }
        return ApprovalDecision.of(kind, asText(body.get("feedback")), asText(body.get("layer")),
                actionClass, resource);
    }

    private static String asText(Object value) {
        return value == null ? null : String.valueOf(value);
    }
}
