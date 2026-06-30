package com.cc01cc.p.xihe.cp.policy;

import org.springframework.stereotype.Component;
import com.cc01cc.p.xihe.cp.audit.AuditLogger;

/**
 * PolicyEngine evaluates whether a tool call should be allowed.
 * MVP implementation: allow all + audit logging.
 * Future: Cedar-based policy evaluation (DESIGN-011).
 */
@Component
public class PolicyEngine {

    private final AuditLogger audit;

    public PolicyEngine(AuditLogger audit) {
        this.audit = audit;
    }

    public static class PolicyDecision {
        private final PolicyResult result;
        private final String reason;

        public enum PolicyResult { ALLOW, DENY, REQUIRE_APPROVAL }

        public PolicyDecision(PolicyResult result, String reason) {
            this.result = result;
            this.reason = reason;
        }

        public PolicyResult getResult() { return result; }
        public String getReason() { return reason; }

        public static PolicyDecision allow() {
            return new PolicyDecision(PolicyResult.ALLOW, "MVP: allow all");
        }

        public static PolicyDecision deny(String reason) {
            return new PolicyDecision(PolicyResult.DENY, reason);
        }
    }

    public PolicyDecision evaluate(String toolName, String body, String sessionId) {
        audit.record(sessionId, toolName, "policy_check", "allow_all_mvp");
        return PolicyDecision.allow();
    }
}
