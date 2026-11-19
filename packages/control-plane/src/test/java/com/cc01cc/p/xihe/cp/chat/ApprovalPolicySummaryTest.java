package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.policy.LayeredPolicyResolver;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyLayer;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
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
        PolicyContext context = new PolicyContext(Map.of(),
                LayeredPolicyResolver.MODE_AUTO, PolicyLayer.SESSION);
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
        // D-1908 §6：描述符同时带生效档位、来源层与主体（主体在 107b 接线前恒为 null）。
        assertEquals(Set.of("effect", "sourceLayer", "matchedRule", "reason", "mode",
                "actionClass", "shape", "tier", "tierSourceLayer", "principalId"), policy.keySet());
        assertNull(policy.get("tier"));
        assertNull(policy.get("tierSourceLayer"));
        assertNull(policy.get("principalId"));
        assertEquals("ask", policy.get("effect"));
        assertEquals("builtin", policy.get("sourceLayer"));
        assertEquals("WriteCustom", policy.get("actionClass"));
        assertEquals("structured", policy.get("shape"));
        assertEquals("auto", policy.get("mode"));
        assertTrue(policy.get("reason") instanceof String reason && !reason.isBlank());
        assertFalse(policy.containsKey("arguments"));
        assertFalse(policy.containsKey("details"));
        verify(engine).evaluateVerdict(context, "write_file", "", SESSION, null, USER, WORKSPACE);
    }

    /** D-1908 §6：判定用的档位与来源层必须进描述符，否则审计只能看到派生的 mode。 */
    @Test
    void buildAtCreationCarriesTheEffectiveTierAndItsLayer() {
        PolicyEngine engine = mock(PolicyEngine.class);
        PolicyContext context = new PolicyContext(Map.of(),
                LayeredPolicyResolver.MODE_MANUAL, PolicyLayer.SESSION, LayeredPolicyResolver.MODE_MANUAL,
                null, PolicyLayer.BUILTIN, "view", PolicyLayer.SESSION, null);
        PolicyVerdict verdict = PolicyVerdict.of(PolicyEffect.ASK,
                "{ write, \"*\", ask }", PolicyLayer.BUILTIN, null, "requires approval");
        when(engine.loadContext(USER, WORKSPACE, SESSION)).thenReturn(context);
        when(engine.evaluateVerdict(context, "write_file", "", SESSION, null, USER, WORKSPACE))
                .thenReturn(verdict);
        when(engine.faceOf(context, "write_file"))
                .thenReturn(new ToolFaceRegistry.Face("WriteCustom", ToolShape.STRUCTURED));
        ApprovalPolicySummary summary = new ApprovalPolicySummary(engine);

        Map<String, Object> policy = summary.buildAtCreation("write_file", SESSION, USER, WORKSPACE).orElseThrow();

        assertEquals("view", policy.get("tier"));
        assertEquals("session", policy.get("tierSourceLayer"));
        assertEquals("manual", policy.get("mode"));
    }

    /** 新形状里 tier 值不在白名单 ⇒ 整条快照作废（不猜成 manual/view）。 */
    @Test
    void readStoredRejectsAnUnsupportedTierValue() {
        ApprovalPolicySummary summary = new ApprovalPolicySummary(mock(PolicyEngine.class));
        String serialized = "{\"effect\":\"ask\",\"sourceLayer\":\"builtin\","
                + "\"matchedRule\":null,\"reason\":\"requires approval\",\"mode\":\"manual\","
                + "\"actionClass\":\"write\",\"shape\":\"structured\","
                + "\"tier\":\"workspace-write\",\"tierSourceLayer\":\"session\",\"principalId\":null}";

        assertTrue(summary.readStored(serialized).isEmpty());
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
        PolicyContext context = PolicyContext.failedClosed(LayeredPolicyResolver.MODE_MANUAL);
        when(engine.loadContext(USER, WORKSPACE, SESSION)).thenReturn(context);
        when(engine.evaluateVerdict(context, "write_file", "", SESSION, null, USER, WORKSPACE))
                .thenReturn(verdict);
        when(engine.faceOf(context, "write_file"))
                .thenReturn(new ToolFaceRegistry.Face("write", ToolShape.STRUCTURED));
        ApprovalPolicySummary summary = new ApprovalPolicySummary(engine);

        assertEquals(LayeredPolicyResolver.MODE_MANUAL,
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
                "mode", "manual",
                "actionClass", "WriteCustom",
                "shape", "structured");
        String serialized = new ObjectMapper().writeValueAsString(expected);

        Map<String, Object> parsed = summary.readStored(serialized).orElseThrow();

        // 旧 7 键快照仍然合法：缺的档位/主体键如实报 null，不从 mode 反推档位。
        Map<String, Object> expectedWithTier = new java.util.LinkedHashMap<>(expected);
        expectedWithTier.put("tier", null);
        expectedWithTier.put("tierSourceLayer", null);
        expectedWithTier.put("principalId", null);
        assertEquals(expectedWithTier, parsed);
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

    @Test
    void storedSummaryWithVersionedHooksAdviceParsesAndKeepsTheAdvice() {
        PolicyEngine engine = mock(PolicyEngine.class);
        ApprovalPolicySummary summary = new ApprovalPolicySummary(engine);

        String stored = "{\"effect\":\"ask\",\"sourceLayer\":\"builtin\",\"matchedRule\":null,"
                + "\"reason\":\"requires approval\",\"mode\":null,\"actionClass\":\"write\","
                + "\"shape\":\"structured\",\"hooks\":{\"version\":1,\"advisors\":[{\"kind\":\"guard\","
                + "\"verdict\":\"deny\",\"reason\":\"touches prod config\"}]}}";
        var parsed = summary.readStored(stored);
        assertTrue(parsed.isPresent(), "advice must not poison the policy parse (task-83 Gap A)");
        assertEquals("ask", parsed.get().get("effect"));
        assertEquals("deny", ((java.util.Map<?, ?>) parsed.get().get("hooks"))
                .get("advisors") instanceof java.util.List<?> advisors
                ? ((java.util.Map<?, ?>) advisors.get(0)).get("verdict") : null);
    }

    @Test
    void malformedHooksSectionIsDroppedButPolicySurvives() {
        PolicyEngine engine = mock(PolicyEngine.class);
        ApprovalPolicySummary summary = new ApprovalPolicySummary(engine);

        String badHooks = "{\"effect\":\"ask\",\"sourceLayer\":\"builtin\",\"matchedRule\":null,"
                + "\"reason\":\"requires approval\",\"mode\":null,\"actionClass\":\"write\","
                + "\"shape\":\"structured\",\"hooks\":{\"advisors\":\"not-an-array\"}}";
        var parsed = summary.readStored(badHooks);
        assertTrue(parsed.isPresent(), "bad advice is dropped, the policy still reads");
        org.junit.jupiter.api.Assertions.assertFalse(parsed.get().containsKey("hooks"));
    }
}
