package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.policy.LayeredPolicyResolver;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyLayer;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ApprovalPolicySummaryTest {

    private static final String SESSION = "session-1";
    private static final String USER = "user-1";
    private static final String WORKSPACE = "workspace-1";

    @Test
    void buildAtCreationUsesEmptyMcpBodyAndEffectiveSessionMode() {
        PolicyEngine engine = mock(PolicyEngine.class);
        PolicyContext context = new PolicyContext(List.of(), Map.of(),
                LayeredPolicyResolver.MODE_BYPASS, PolicyLayer.SESSION);
        PolicyVerdict verdict = PolicyVerdict.of(PolicyEffect.ASK,
                "{ write, \"*\", ask }", PolicyLayer.BUILTIN, null, "requires approval");
        when(engine.loadContext(USER, WORKSPACE, SESSION)).thenReturn(context);
        when(engine.evaluateVerdict(context, "write_file", "", SESSION, null, USER, WORKSPACE))
                .thenReturn(verdict);
        when(engine.faceOf(context, "write_file"))
                .thenReturn(new ToolFaceRegistry.Face("WriteCustom", ToolShape.STRUCTURED));
        ApprovalPolicySummary summary = new ApprovalPolicySummary(engine);

        Optional<Map<String, Object>> result = summary.buildAtCreation(
                "write_file", SESSION, USER, WORKSPACE);

        assertTrue(result.isPresent());
        Map<String, Object> policy = result.orElseThrow();
        assertEquals(Set.of("effect", "sourceLayer", "matchedRule", "reason", "mode",
                "actionClass", "shape"), policy.keySet());
        assertEquals("ask", policy.get("effect"));
        assertEquals("builtin", policy.get("sourceLayer"));
        assertEquals("WriteCustom", policy.get("actionClass"));
        assertEquals("structured", policy.get("shape"));
        assertEquals("bypass", policy.get("mode"));
        assertTrue(policy.get("reason") instanceof String reason && !reason.isBlank());
        assertFalse(policy.containsKey("arguments"));
        assertFalse(policy.containsKey("details"));
        verify(engine).evaluateVerdict(context, "write_file", "", SESSION, null, USER, WORKSPACE);
    }

    @Test
    void descriptorFailureReturnsEmptyWithoutBlockingCaller() {
        PolicyEngine engine = mock(PolicyEngine.class);
        when(engine.loadContext(USER, WORKSPACE, SESSION)).thenReturn(PolicyContext.EMPTY);
        when(engine.evaluateVerdict(PolicyContext.EMPTY, "write_file", "", SESSION, null, USER, WORKSPACE))
                .thenThrow(new IllegalStateException("arguments must not be logged"));
        ApprovalPolicySummary summary = new ApprovalPolicySummary(engine);

        Optional<Map<String, Object>> result = summary.buildAtCreation(
                "write_file", SESSION, USER, WORKSPACE);

        assertTrue(result.isEmpty());
    }

    @Test
    void buildAtCreationKeepsExplicitSessionModeWhenContextFallsBack() {
        PolicyEngine engine = mock(PolicyEngine.class);
        PolicyVerdict verdict = PolicyVerdict.of(PolicyEffect.ASK,
                "{ write, \"*\", ask }", PolicyLayer.INSTANCE, null, "requires approval");
        PolicyContext context = PolicyContext.failedClosed(LayeredPolicyResolver.MODE_MANAGED);
        when(engine.loadContext(USER, WORKSPACE, SESSION)).thenReturn(context);
        when(engine.evaluateVerdict(context, "write_file", "", SESSION, null, USER, WORKSPACE))
                .thenReturn(verdict);
        when(engine.faceOf(context, "write_file"))
                .thenReturn(new ToolFaceRegistry.Face("write", ToolShape.STRUCTURED));
        ApprovalPolicySummary summary = new ApprovalPolicySummary(engine);

        assertEquals(LayeredPolicyResolver.MODE_MANAGED,
                summary.buildAtCreation("write_file", SESSION, USER, WORKSPACE).orElseThrow().get("mode"));
    }

    @Test
    void readStoredParsesOnlyTheExactSafeShape() throws Exception {
        PolicyEngine engine = mock(PolicyEngine.class);
        ApprovalPolicySummary summary = new ApprovalPolicySummary(engine);
        Map<String, Object> expected = Map.of(
                "effect", "ask",
                "sourceLayer", "builtin",
                "matchedRule", "{ write, \"*\", ask }",
                "reason", "requires approval",
                "mode", "default",
                "actionClass", "WriteCustom",
                "shape", "structured");
        String serialized = new ObjectMapper().writeValueAsString(expected);

        Map<String, Object> parsed = summary.readStored(serialized).orElseThrow();

        assertEquals(expected, parsed);
        verifyNoInteractions(engine);
    }

    @Test
    void readStoredOmitsNullAndMalformedSnapshotsWithoutEvaluating() {
        PolicyEngine engine = mock(PolicyEngine.class);
        ApprovalPolicySummary summary = new ApprovalPolicySummary(engine);

        assertTrue(summary.readStored(null).isEmpty());
        assertTrue(summary.readStored("not-json").isEmpty());
        assertTrue(summary.readStored("{\"effect\":\"ask\"}").isEmpty());
        assertTrue(summary.readStored(
                "{\"effect\":\"ask\",\"sourceLayer\":\"builtin\","
                        + "\"matchedRule\":null,\"reason\":\"requires approval\","
                        + "\"mode\":null,\"actionClass\":\"write\",\"shape\":\"structured\","
                        + "\"unexpected\":\"value\"}").isEmpty());
        verifyNoInteractions(engine);
    }
}
