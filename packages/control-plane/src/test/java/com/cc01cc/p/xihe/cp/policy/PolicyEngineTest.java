package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class PolicyEngineTest {

    private PolicyEngine createEngine() {
        return new PolicyEngine(mock(AuditLogger.class));
    }

    @Test
    void autoAllow_readFile_returnsAllow() {
        PolicyEngine.PolicyDecision decision = createEngine().evaluate("read_file", "{}", "s1");
        assertEquals(PolicyEngine.PolicyDecision.PolicyResult.ALLOW, decision.getResult());
    }

    @Test
    void autoAllow_listDirectory_returnsAllow() {
        PolicyEngine.PolicyDecision decision = createEngine().evaluate("list_directory", "{}", "s1");
        assertEquals(PolicyEngine.PolicyDecision.PolicyResult.ALLOW, decision.getResult());
    }

    @Test
    void requireApproval_writeFile_returnsApproval() {
        PolicyEngine.PolicyDecision decision = createEngine().evaluate("write_file", "{}", "s1");
        assertEquals(PolicyEngine.PolicyDecision.PolicyResult.REQUIRE_APPROVAL, decision.getResult());
        assertTrue(decision.getReason().contains("write_file"));
    }

    @Test
    void requireApproval_executeCommand_returnsApproval() {
        PolicyEngine.PolicyDecision decision = createEngine().evaluate("execute_command", "{}", "s1");
        assertEquals(PolicyEngine.PolicyDecision.PolicyResult.REQUIRE_APPROVAL, decision.getResult());
    }

    @Test
    void requireApproval_applyPatch_returnsApproval() {
        PolicyEngine.PolicyDecision decision = createEngine().evaluate("apply_patch", "{}", "s1");
        assertEquals(PolicyEngine.PolicyDecision.PolicyResult.REQUIRE_APPROVAL, decision.getResult());
    }

    @Test
    void deny_unknownTool_returnsDeny() {
        PolicyEngine.PolicyDecision decision = createEngine().evaluate("unknown_tool", "{}", "s1");
        assertEquals(PolicyEngine.PolicyDecision.PolicyResult.DENY, decision.getResult());
        assertTrue(decision.getReason().contains("unknown"));
    }

    @Test
    void deny_emptyTool_returnsDeny() {
        PolicyEngine.PolicyDecision decision = createEngine().evaluate("", "{}", "s1");
        assertEquals(PolicyEngine.PolicyDecision.PolicyResult.DENY, decision.getResult());
    }

    @Test
    void deny_nullTool_returnsDeny() {
        PolicyEngine.PolicyDecision decision = createEngine().evaluate(null, "{}", "s1");
        assertEquals(PolicyEngine.PolicyDecision.PolicyResult.DENY, decision.getResult());
    }

    @Test
    void evaluate_recordsAuditLog() {
        AuditLogger audit = mock(AuditLogger.class);
        PolicyEngine engine = new PolicyEngine(audit);
        engine.evaluate("read_file", "{}", "session-1");
        verify(audit).record("session-1", "read_file", "policy_check", "auto_allow");
    }
}
