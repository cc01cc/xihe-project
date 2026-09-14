package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import org.junit.jupiter.api.Test;

/** PLAN-0328 M1: session mode + session-only rules (L4) never leak into other scopes. */
class SessionPolicyStateTest {

    private final SessionPolicyState state = new SessionPolicyState();

    @Test
    void modeIsSessionScopedAndMemoryOnly() {
        state.setMode("s1", LayeredPolicyResolver.MODE_BYPASS);

        assertEquals(LayeredPolicyResolver.MODE_BYPASS, state.modeOf("s1").orElseThrow());
        assertTrue(state.modeOf("s2").isEmpty());
    }

    @Test
    void rejectsUnsupportedMode() {
        assertThrows(IllegalArgumentException.class, () -> state.setMode("s1", "yolo"));
    }

    @Test
    void sessionRulesAccumulateWithInsertionSequence() {
        state.addRule("s1", PolicyRule.of("exec", "pnpm test *", PolicyEffect.ALLOW));
        state.addRule("s1", PolicyRule.of("exec", "pnpm build *", PolicyEffect.ALLOW));

        var rules = state.rulesOf("s1");
        assertEquals(2, rules.size());
        assertTrue(rules.get(0).seq() < rules.get(1).seq());
        assertTrue(state.rulesOf("s2").isEmpty());
    }

    @Test
    void setModePreservesExistingRules() {
        state.addRule("s1", PolicyRule.of("exec", "*", PolicyEffect.ALLOW));
        state.setMode("s1", LayeredPolicyResolver.MODE_DEFAULT);

        assertEquals(1, state.rulesOf("s1").size());
        assertEquals(LayeredPolicyResolver.MODE_DEFAULT, state.modeOf("s1").orElseThrow());
    }

    @Test
    void clearDropsEverythingForTheSession() {
        state.setMode("s1", LayeredPolicyResolver.MODE_BYPASS);
        state.addRule("s1", PolicyRule.of("exec", "*", PolicyEffect.ALLOW));

        state.clear("s1");

        assertTrue(state.modeOf("s1").isEmpty());
        assertTrue(state.rulesOf("s1").isEmpty());
    }

    @Test
    void opportunisticSweepDropsExpiredEntriesButKeepsLiveOnes() throws InterruptedException {
        SessionPolicyState shortLived = new SessionPolicyState(Duration.ofMillis(500));
        for (int i = 0; i < 5; i++) {
            shortLived.addRule("stale-" + i, PolicyRule.of("exec", "*", PolicyEffect.ALLOW));
        }
        Thread.sleep(600);
        shortLived.addRule("live", PolicyRule.of("exec", "*", PolicyEffect.ALLOW));

        for (int i = 0; i < 64; i++) {
            shortLived.rulesOf("live");
        }

        assertEquals(1, shortLived.size(), "only the live entry may remain after the sweep");
        assertTrue(shortLived.rulesOf("stale-0").isEmpty());
        assertEquals(1, shortLived.rulesOf("live").size());
    }
}
