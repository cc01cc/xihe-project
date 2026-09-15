package com.cc01cc.p.xihe.cp.policy;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** PLAN-0328 T1.7: pure reuse rules — shape ceilings and mode precedence. */
class ReusePolicyTest {

    @Test
    void structuredToolsAllowOnceSessionAndSaved() {
        var tiers = ReusePolicy.allowedTiers(ToolShape.STRUCTURED, ToolFaceRegistry.ACTION_WRITE);

        assertEquals(3, tiers.size());
        assertTrue(tiers.containsAll(java.util.List.of(
                ReusePolicy.Tier.ONCE, ReusePolicy.Tier.SESSION, ReusePolicy.Tier.SAVED)));
        assertTrue(ReusePolicy.allows(ReusePolicy.Tier.SAVED, ToolShape.STRUCTURED,
                ToolFaceRegistry.ACTION_WRITE));
    }

    @Test
    void structuredDeleteToolsAllowOnceOnly() {
        assertFalse(ReusePolicy.allows(ReusePolicy.Tier.SESSION, ToolShape.STRUCTURED,
                ToolFaceRegistry.ACTION_DELETE));
        assertFalse(ReusePolicy.allows(ReusePolicy.Tier.SAVED, ToolShape.STRUCTURED,
                ToolFaceRegistry.ACTION_DELETE));
        assertTrue(ReusePolicy.allows(ReusePolicy.Tier.ONCE, ToolShape.STRUCTURED,
                ToolFaceRegistry.ACTION_DELETE));
    }

    @Test
    void interpreterToolsAllowSessionButNeverSaved() {
        assertTrue(ReusePolicy.allows(ReusePolicy.Tier.SESSION, ToolShape.INTERPRETER,
                ToolFaceRegistry.ACTION_EXEC));
        assertFalse(ReusePolicy.allows(ReusePolicy.Tier.SAVED, ToolShape.INTERPRETER,
                ToolFaceRegistry.ACTION_EXEC));
    }

    @Test
    void opaqueAndUnclassifiedFailClosedToOnce() {
        assertFalse(ReusePolicy.allows(ReusePolicy.Tier.SESSION, ToolShape.OPAQUE, "external"));
        assertFalse(ReusePolicy.allows(ReusePolicy.Tier.SAVED, ToolShape.OPAQUE, "external"));
        assertFalse(ReusePolicy.allows(ReusePolicy.Tier.SESSION, ToolShape.STRUCTURED,
                PolicyLayer.UNCLASSIFIED_ACTION));
        assertFalse(ReusePolicy.allows(ReusePolicy.Tier.SAVED, null, null));
    }

    @Test
    void rejectsAreNotReuseTiers() {
        assertNull(ReusePolicy.tierOf("reject"));
        assertNull(ReusePolicy.tierOf("reject_always"));
        assertNull(ReusePolicy.tierOf(null));
        assertTrue(ReusePolicy.allows(null, ToolShape.OPAQUE, "external"));
    }

    @Test
    void modeRankIsStrictestFirstAndNullRanksAsDefault() {
        assertTrue(ReusePolicy.modeRank("plan") > ReusePolicy.modeRank("managed"));
        assertTrue(ReusePolicy.modeRank("managed") > ReusePolicy.modeRank("default"));
        assertTrue(ReusePolicy.modeRank("default") > ReusePolicy.modeRank("accept-edits"));
        assertTrue(ReusePolicy.modeRank("accept-edits") > ReusePolicy.modeRank("bypass"));
        assertEquals(ReusePolicy.modeRank("default"), ReusePolicy.modeRank(null));
        assertEquals(ReusePolicy.modeRank("default"), ReusePolicy.modeRank("unknown-mode"));
    }

    @Test
    void normalizeArgumentsHashAlwaysCarriesTheAlgorithmPrefix() {
        assertEquals("sha256:abc", ReusePolicy.normalizeArgumentsHash("abc"));
        assertEquals("sha256:abc", ReusePolicy.normalizeArgumentsHash("sha256:abc"));
        assertEquals("sha256:abc", ReusePolicy.normalizeArgumentsHash("  abc  "));
        assertNull(ReusePolicy.normalizeArgumentsHash(null));
        assertNull(ReusePolicy.normalizeArgumentsHash("   "));
    }
}
