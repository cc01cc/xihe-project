package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
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
    void unclassified_unknownTool_returnsAsk() {
        PolicyVerdict verdict = createEngine().evaluateVerdict("unknown_tool", "{}", "s1", null, null, null);
        assertEquals(PolicyEffect.ASK, verdict.effect());
        assertEquals(PolicyLayer.BUILTIN, verdict.sourceLayer());
        assertEquals(LayeredPolicyResolver.MODE_DEFAULT, verdict.mode());
        assertNull(verdict.allowedBy());
        assertTrue(verdict.reason().contains("unclassified tool requires explicit classification"));
    }

    @Test
    void unclassified_unknownTool_bypassStillAsks() {
        PolicyVerdict verdict = createEngine().evaluateVerdict("unknown_tool", "", "s1",
                LayeredPolicyResolver.MODE_BYPASS, null, null);

        assertEquals(PolicyEffect.ASK, verdict.effect());
        assertEquals(LayeredPolicyResolver.MODE_BYPASS, verdict.mode());
        assertNull(verdict.allowedBy());
    }

    @Test
    void unclassified_unknownTool_neverUsesOtherAutomaticModes() {
        for (String mode : List.of(LayeredPolicyResolver.MODE_ACCEPT_EDITS,
                LayeredPolicyResolver.MODE_PLAN)) {
            PolicyVerdict verdict = createEngine().evaluateVerdict("unknown_tool", "", "s1",
                    mode, null, null);

            assertEquals(PolicyEffect.ASK, verdict.effect(), mode);
            assertNull(verdict.allowedBy(), mode);
        }
    }

    @Test
    void unclassified_unknownTool_hardGuardDenyWins() {
        String body = "{\"params\":{\"arguments\":{\"path\":\"../../etc/passwd\"}}}";

        PolicyVerdict verdict = createEngine().evaluateVerdict("unknown_tool", body, "s1",
                LayeredPolicyResolver.MODE_BYPASS, null, null);

        assertEquals(PolicyEffect.DENY, verdict.effect());
        assertTrue(verdict.reason().startsWith("hard guard:"));
    }

    @Test
    void classifiedTool_usesNormalResolverAfterFaceIsPersisted() {
        PolicyContext context = new PolicyContext(List.of(), Map.of(
                "third_party_tool", new ToolFaceRegistry.Face(ToolFaceRegistry.ACTION_READ,
                        ToolShape.STRUCTURED)), null, null);
        PolicyEngine engine = new PolicyEngine(mock(AuditLogger.class), (userId, workspaceId, sessionId) -> context);

        PolicyVerdict verdict = engine.evaluateVerdict("third_party_tool", "{}", "s1", null, "u1", "ws1");

        assertEquals(PolicyEffect.ALLOW, verdict.effect());
        assertEquals("allowed by read rules", verdict.reason());
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
