package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class PolicyEngineTest {

    @Test
    void evaluate_returnsAllowInMvp() {
        AuditLogger audit = mock(AuditLogger.class);
        PolicyEngine engine = new PolicyEngine(audit);
        PolicyEngine.PolicyDecision decision = engine.evaluate("read_file", "{}", "session-1");
        assertEquals(PolicyEngine.PolicyDecision.PolicyResult.ALLOW, decision.getResult());
    }

    @Test
    void evaluate_recordsAuditLog() {
        AuditLogger audit = mock(AuditLogger.class);
        PolicyEngine engine = new PolicyEngine(audit);
        engine.evaluate("read_file", "{}", "session-1");
        verify(audit).record("session-1", "read_file", "policy_check", "allow_all_mvp");
    }

    @Test
    void policyDecision_allow_createsAllow() {
        PolicyEngine.PolicyDecision decision = PolicyEngine.PolicyDecision.allow();
        assertEquals(PolicyEngine.PolicyDecision.PolicyResult.ALLOW, decision.getResult());
        assertNotNull(decision.getReason());
    }

    @Test
    void policyDecision_deny_createsDeny() {
        PolicyEngine.PolicyDecision decision = PolicyEngine.PolicyDecision.deny("custom reason");
        assertEquals(PolicyEngine.PolicyDecision.PolicyResult.DENY, decision.getResult());
        assertEquals("custom reason", decision.getReason());
    }
}
