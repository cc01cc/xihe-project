package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
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
    void snapshotEntryKeepsRulesImmutable() {
        var mutableRules = new java.util.ArrayList<>(List.of(
                PolicyRule.of("exec", "pnpm test *", PolicyEffect.ALLOW)));
        SessionPolicyState.Entry entry = new SessionPolicyState.Entry(
                LayeredPolicyResolver.MODE_MANAGED, mutableRules, Instant.now());
        mutableRules.clear();

        assertEquals(1, entry.rules().size());
        assertThrows(UnsupportedOperationException.class,
                () -> entry.rules().add(PolicyRule.of("exec", "*", PolicyEffect.DENY)));
    }

    @Test
    void clearDropsEverythingForTheSession() {
        state.setMode("s1", LayeredPolicyResolver.MODE_BYPASS);
        state.addRule("s1", PolicyRule.of("exec", "*", PolicyEffect.ALLOW));
        state.addGrant("s1", grant("write_file", "sha256:abc", "default"));

        state.clear("s1");

        assertTrue(state.modeOf("s1").isEmpty());
        assertTrue(state.rulesOf("s1").isEmpty());
        assertTrue(state.grantOf("s1", "write_file", "sha256:abc").isEmpty());
    }

    private static SessionPolicyState.Grant grant(String tool, String hash, String modeAtGrant) {
        return new SessionPolicyState.Grant(hash, tool, modeAtGrant, 7L, 3, Instant.now());
    }

    @Test
    void grantsAreExactInvocationFingerprintsNotCoarseActionAllows() {
        state.addGrant("s1", grant("write_file", "sha256:abc", "default"));
        state.addGrant("s1", grant("execute_command", "sha256:def", "default"));

        assertEquals(7L, state.grantOf("s1", "write_file", "sha256:abc").orElseThrow().policyRevision());
        assertEquals("execute_command",
                state.grantOf("s1", "execute_command", "sha256:def").orElseThrow().tool());
        // A different tool or different canonical arguments never matches.
        assertTrue(state.grantOf("s1", "write_file", "sha256:def").isEmpty());
        assertTrue(state.grantOf("s1", "edit_file", "sha256:abc").isEmpty());
        assertTrue(state.grantOf("s2", "write_file", "sha256:abc").isEmpty());
    }

    @Test
    void regrantingTheSameFingerprintRefreshesInsteadOfDuplicating() {
        state.addGrant("s1", grant("write_file", "sha256:abc", "default"));
        state.addGrant("s1", new SessionPolicyState.Grant(
                "sha256:abc", "write_file", "managed", 9L, 4, Instant.now()));

        assertEquals("managed", state.grantOf("s1", "write_file", "sha256:abc").orElseThrow().modeAtGrant());
        assertEquals(1, state.snapshot("s1").orElseThrow().grants().size());
    }

    @Test
    void grantsAreBoundedPerSession() {
        for (int i = 0; i < SessionPolicyState.MAX_GRANTS_PER_SESSION + 5; i++) {
            state.addGrant("s1", grant("write_file", "sha256:" + i, "default"));
        }

        assertEquals(SessionPolicyState.MAX_GRANTS_PER_SESSION,
                state.snapshot("s1").orElseThrow().grants().size());
        // The oldest fingerprints fall out first (fail-closed), the newest stay.
        assertTrue(state.grantOf("s1", "write_file", "sha256:0").isEmpty());
        assertTrue(state.grantOf("s1", "write_file",
                "sha256:" + (SessionPolicyState.MAX_GRANTS_PER_SESSION + 4)).isPresent());
    }

    @Test
    void malformedGrantsAreIgnored() {
        state.addGrant("s1", new SessionPolicyState.Grant(" ", "write_file", "default", 0L, 0, Instant.now()));
        state.addGrant("s1", new SessionPolicyState.Grant("sha256:abc", null, "default", 0L, 0, Instant.now()));
        state.addGrant(null, grant("write_file", "sha256:abc", "default"));

        assertTrue(state.modeOf("s1").isEmpty());
        assertTrue(state.grantOf("s1", "write_file", "sha256:abc").isEmpty());
    }

    @Test
    void opportunisticSweepDropsExpiredEntriesButKeepsLiveOnes() throws InterruptedException {
        SessionPolicyState shortLived = new SessionPolicyState(Duration.ofMillis(500));
        for (int i = 0; i < 5; i++) {
            shortLived.addRule("stale-" + i, PolicyRule.of("exec", "*", PolicyEffect.ALLOW));
        }
        shortLived.addGrant("stale-grant", grant("write_file", "sha256:abc", "default"));
        Thread.sleep(600);
        shortLived.addRule("live", PolicyRule.of("exec", "*", PolicyEffect.ALLOW));

        for (int i = 0; i < 64; i++) {
            shortLived.rulesOf("live");
        }

        assertEquals(1, shortLived.size(), "only the live entry may remain after the sweep");
        assertTrue(shortLived.rulesOf("stale-0").isEmpty());
        assertTrue(shortLived.grantOf("stale-grant", "write_file", "sha256:abc").isEmpty());
        assertEquals(1, shortLived.rulesOf("live").size());
    }
}
