package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.Mockito.mock;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * PLAN-0407 T2.8 (design #18/#19): the approval decision is driven by the approval-policy ask
 * list. Persisted rule layers no longer exist as a channel to the engine (PolicyContext dropped
 * them, the provider stopped loading them, and {@code LayeredPolicyResolver.resolve} is gone) —
 * these cases pin the ask-list behavior that replaced them (V14).
 */
class PolicyEngineLayersTest {

    private static PolicyContextProvider providerOf(String mode, PolicyLayer modeLayer,
                                                    List<String> askActionClasses, PolicyLayer askLayer) {
        PolicyContext context = new PolicyContext(Map.of(), mode, modeLayer, mode,
                askActionClasses, askLayer);
        return (userId, workspaceId, sessionId) -> context;
    }

    private PolicyEngine engine(PolicyContextProvider provider) {
        return new PolicyEngine(mock(AuditLogger.class), provider);
    }

    @Test
    void onListActionClassAsksUnderManualMode() {
        PolicyEngine engine = engine(providerOf(
                LayeredPolicyResolver.MODE_MANUAL, PolicyLayer.SESSION, null, null));

        PolicyVerdict verdict = engine.evaluateVerdict("execute_command", "{}", "s1", null, "u1", "ws1");

        assertEquals(PolicyEffect.ASK, verdict.effect());
        assertEquals("action class on the approval ask list", verdict.reason());
        assertNull(verdict.matchedRule(), "no rule participates in the decision anymore");
    }

    @Test
    void autoModeStillUpgradesAnOnListAskAndIsRecordedAsAllowedBy() {
        PolicyEngine engine = engine(providerOf(
                LayeredPolicyResolver.MODE_AUTO, PolicyLayer.WORKSPACE, null, null));

        PolicyVerdict verdict = engine.evaluateVerdict("write_file", "{}", "s1", null, "u1", "ws1");

        assertEquals(PolicyEffect.ALLOW, verdict.effect());
        assertEquals("auto@WORKSPACE", verdict.allowedBy());
    }

    @Test
    void sessionManualModeStillAsksOnListClasses() {
        PolicyEngine engine = engine(providerOf(
                LayeredPolicyResolver.MODE_MANUAL, PolicyLayer.SESSION, null, null));

        PolicyVerdict verdict = engine.evaluateVerdict("write_file", "{}", "s1", null, "u1", "ws1");

        assertEquals(PolicyEffect.ASK, verdict.effect());
        assertNull(verdict.allowedBy());
    }

    @Test
    void sessionAutoModeStillAutoPassesExec() {
        PolicyEngine engine = engine(providerOf(
                LayeredPolicyResolver.MODE_AUTO, PolicyLayer.SESSION, null, null));

        PolicyVerdict verdict = engine.evaluateVerdict("execute_command", "{}", "s1", null, "u1", "ws1");

        assertEquals(PolicyEffect.ALLOW, verdict.effect());
        assertEquals("auto@SESSION", verdict.allowedBy());
    }

    @Test
    void explicitModeArgumentOverridesSessionState() {
        PolicyEngine engine = engine(providerOf(
                LayeredPolicyResolver.MODE_AUTO, PolicyLayer.SESSION, null, null));

        PolicyVerdict verdict = engine.evaluateVerdict("execute_command", "{}", "s1",
                LayeredPolicyResolver.MODE_MANUAL, "u1", "ws1");

        assertEquals(PolicyEffect.ASK, verdict.effect());
        assertNull(verdict.allowedBy());
    }

    @Test
    void offListActionClassPassesDirectlyUnderManualMode() {
        PolicyEngine engine = engine(providerOf(LayeredPolicyResolver.MODE_MANUAL,
                PolicyLayer.SESSION, List.of("exec", "write"), PolicyLayer.WORKSPACE));

        PolicyVerdict verdict = engine.evaluateVerdict("read_file", "{}", "s1", null, "u1", "ws1");

        assertEquals(PolicyEffect.ALLOW, verdict.effect());
        assertEquals(PolicyLayer.WORKSPACE, verdict.sourceLayer(),
                "the ask list source layer is reported for audit/UI");
        assertEquals("action class not on the approval ask list", verdict.reason());
    }

    @Test
    void aConfiguredEmptyAskListAsksNothing() {
        PolicyEngine engine = engine(providerOf(null, null, List.of(), PolicyLayer.INSTANCE));

        assertEquals(PolicyEffect.ALLOW, engine.evaluateVerdict(
                "write_file", "{}", "s1", null, "u1", "ws1").effect());
        assertEquals(PolicyEffect.ALLOW, engine.evaluateVerdict(
                "execute_command", "{}", "s1", null, "u1", "ws1").effect());
    }

    @Test
    void builtinFloorStillAppliesWithoutPersistedContext() {
        PolicyEngine engine = engine(new BuiltinPolicyContextProvider());

        assertEquals(PolicyEffect.ALLOW, engine.evaluateVerdict("read_file", "{}", "s1", null, null, null).effect());
        assertEquals(PolicyEffect.ASK, engine.evaluateVerdict("write_file", "{}", "s1", null, null, null).effect());
        assertEquals(PolicyEffect.ASK, engine.evaluateVerdict("made_up_tool", "{}", "s1", null, null, null).effect());
    }
}
