package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class PolicyEngineTest {

    private PolicyEngine createEngine() {
        return new PolicyEngine(mock(AuditLogger.class), new BuiltinPolicyContextProvider());
    }

    @Test
    void autoAllow_readFile_returnsAllow() {
        PolicyVerdict verdict = createEngine().evaluateVerdict("read_file", "{}", "s1", null, null, null);
        assertEquals(PolicyEffect.ALLOW, verdict.effect());
    }

    @Test
    void autoAllow_listDirectory_returnsAllow() {
        PolicyVerdict verdict = createEngine().evaluateVerdict("list_directory", "{}", "s1", null, null, null);
        assertEquals(PolicyEffect.ALLOW, verdict.effect());
    }

    @Test
    void requireApproval_writeFile_returnsApproval() {
        PolicyVerdict verdict = createEngine().evaluateVerdict("write_file", "{}", "s1", null, null, null);
        assertEquals(PolicyEffect.ASK, verdict.effect());
        assertTrue(verdict.reason().contains("write"));
    }

    @Test
    void requireApproval_executeCommand_returnsApproval() {
        PolicyVerdict verdict = createEngine().evaluateVerdict("execute_command", "{}", "s1", null, null, null);
        assertEquals(PolicyEffect.ASK, verdict.effect());
    }

    @Test
    void requireApproval_applyPatch_returnsApproval() {
        PolicyVerdict verdict = createEngine().evaluateVerdict("apply_patch", "{}", "s1", null, null, null);
        assertEquals(PolicyEffect.ASK, verdict.effect());
    }

    @Test
    void deny_unknownTool_returnsDeny() {
        PolicyVerdict verdict = createEngine().evaluateVerdict("unknown_tool", "{}", "s1", null, null, null);
        assertEquals(PolicyEffect.DENY, verdict.effect());
        assertTrue(verdict.reason().contains("unknown"));
    }

    @Test
    void deny_emptyTool_returnsDeny() {
        PolicyVerdict verdict = createEngine().evaluateVerdict("", "{}", "s1", null, null, null);
        assertEquals(PolicyEffect.DENY, verdict.effect());
    }

    @Test
    void deny_nullTool_returnsDeny() {
        PolicyVerdict verdict = createEngine().evaluateVerdict(null, "{}", "s1", null, null, null);
        assertEquals(PolicyEffect.DENY, verdict.effect());
    }

    @Test
    void evaluateVerdict_recordsAuditLog() {
        AuditLogger audit = mock(AuditLogger.class);
        PolicyEngine engine = new PolicyEngine(audit, new BuiltinPolicyContextProvider());
        engine.evaluateVerdict("read_file", "{}", "session-1", null, null, null);
        verify(audit).record("session-1", "read_file", "policy_check", "auto_allow");
    }
}
