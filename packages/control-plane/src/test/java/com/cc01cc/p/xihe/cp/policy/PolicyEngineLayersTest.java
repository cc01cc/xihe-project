package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.Mockito.mock;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * PLAN-0328 M1: the engine honours persisted/session layers and session modes
 * (spec §4.2 select-layer-first; §7 modes; §4.5 injection points).
 */
class PolicyEngineLayersTest {

    private static PolicyContextProvider providerOf(List<LayeredPolicyResolver.LayerInput> layers,
                                                    String mode, PolicyLayer modeLayer) {
        PolicyContext context = new PolicyContext(layers, Map.of(), mode, modeLayer);
        return (userId, workspaceId, sessionId) -> context;
    }

    private static LayeredPolicyResolver.LayerInput workspaceRule(PolicyRule rule) {
        return new LayeredPolicyResolver.LayerInput(PolicyLayer.WORKSPACE, List.of(rule));
    }

    private PolicyEngine engine(PolicyContextProvider provider) {
        return new PolicyEngine(mock(AuditLogger.class), provider);
    }

    @Test
    void workspaceRuleAllowsMutationToolWithoutApproval() {
        PolicyEngine engine = engine(providerOf(
                List.of(workspaceRule(PolicyRule.of("exec", "*", PolicyEffect.ALLOW))), null, null));

        PolicyVerdict verdict = engine.evaluateVerdict("execute_command", "{}", "s1", null, "u1", "ws1");

        assertEquals(PolicyEffect.ALLOW, verdict.effect());
        assertEquals(PolicyLayer.WORKSPACE, verdict.sourceLayer());
        assertNull(verdict.allowedBy());
    }

    @Test
    void sessionRuleAppliesWhenNoHigherLayerConfiguresTheDomain() {
        PolicyEngine engine = engine(providerOf(List.of(new LayeredPolicyResolver.LayerInput(
                PolicyLayer.SESSION, List.of(PolicyRule.of("write", "*", PolicyEffect.ALLOW)))), null, null));

        PolicyVerdict verdict = engine.evaluateVerdict("write_file", "{}", "s1", null, "u1", "ws1");

        assertEquals(PolicyEffect.ALLOW, verdict.effect());
        assertEquals(PolicyLayer.SESSION, verdict.sourceLayer());
    }

    @Test
    void sessionAutoModeAllowsAskButIsRecordedAsAllowedBy() {
        PolicyEngine engine = engine(providerOf(List.of(), LayeredPolicyResolver.MODE_AUTO, PolicyLayer.SESSION));

        PolicyVerdict verdict = engine.evaluateVerdict("execute_command", "{}", "s1", null, "u1", "ws1");

        assertEquals(PolicyEffect.ALLOW, verdict.effect());
        assertEquals("auto@SESSION", verdict.allowedBy());
    }

    @Test
    void sessionAutoCannotOverrideInstanceDeny() {
        PolicyEngine engine = engine(providerOf(List.of(new LayeredPolicyResolver.LayerInput(
                PolicyLayer.INSTANCE, List.of(new PolicyRule("exec", "*", PolicyEffect.DENY, 0, true, 1)))),
                LayeredPolicyResolver.MODE_AUTO, PolicyLayer.SESSION));

        PolicyVerdict verdict = engine.evaluateVerdict("execute_command", "{}", "s1", null, "u1", "ws1");

        assertEquals(PolicyEffect.DENY, verdict.effect());
        assertNull(verdict.allowedBy());
    }

    @Test
    void explicitModeArgumentOverridesSessionState() {
        PolicyEngine engine = engine(providerOf(List.of(), LayeredPolicyResolver.MODE_AUTO, PolicyLayer.SESSION));

        PolicyVerdict verdict = engine.evaluateVerdict("execute_command", "{}", "s1",
                LayeredPolicyResolver.MODE_MANUAL, "u1", "ws1");

        assertEquals(PolicyEffect.ASK, verdict.effect());
        assertNull(verdict.allowedBy());
    }

    @Test
    void manualModeHonoursWorkspaceRules() {
        PolicyEngine engine = engine(providerOf(List.of(
                new LayeredPolicyResolver.LayerInput(PolicyLayer.WORKSPACE,
                        List.of(PolicyRule.of("exec", "*", PolicyEffect.ALLOW)))),
                LayeredPolicyResolver.MODE_MANUAL, PolicyLayer.SESSION));

        PolicyVerdict verdict = engine.evaluateVerdict("execute_command", "{}", "s1", null, "u1", "ws1");

        assertEquals(PolicyEffect.ALLOW, verdict.effect());
        assertEquals(PolicyLayer.WORKSPACE, verdict.sourceLayer());
    }

    @Test
    void builtinFloorStillAppliesWithoutPersistedLayers() {
        PolicyEngine engine = engine(new BuiltinPolicyContextProvider());

        assertEquals(PolicyEffect.ALLOW, engine.evaluateVerdict("read_file", "{}", "s1", null, null, null).effect());
        assertEquals(PolicyEffect.ASK, engine.evaluateVerdict("write_file", "{}", "s1", null, null, null).effect());
        assertEquals(PolicyEffect.ASK, engine.evaluateVerdict("made_up_tool", "{}", "s1", null, null, null).effect());
    }
}
