package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.skill.SkillImportValidator;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0628 M1 (D28-29 follow-up): <b>parity tripwire</b> between the two copies of the workspace
 * path rule family.
 *
 * <p>PLAN-0627's {@code NestedAgentsMdResolver.normalizeTouchedPath} lives in {@code cp.context};
 * {@code cp.skill} may not depend on that slice (it would create a cycle that
 * {@code CpArchitectureTest} rejects), so {@code SkillImportValidator.normalizePath} is a
 * deliberate re-spelling. "Deliberate duplication" is one refactor away from "different semantics",
 * so both implementations are pinned here against one shared sample set:</p>
 * <ul>
 *   <li>accepted inputs must normalise to <b>the same string</b> (not merely both accept);</li>
 *   <li>unsafe inputs must be refused by <b>both</b>.</li>
 * </ul>
 *
 * <p>The single intentional difference is documented and asserted explicitly: the nested resolver
 * answers {@code ""} for "nothing was given" (its input is optional) while the skill validator
 * answers {@code null} (a skill's {@code sourcePath} is required). Both mean "no usable path", and
 * {@link #blankInputMeansNoUsablePathInBothCopies()} pins that reading.</p>
 */
class PathRuleParityTest {

    /** Inputs both copies must accept, with the exact normalised form they must agree on. */
    private static final List<String[]> ACCEPTED = List.of(
            new String[]{"a/b/SKILL.md", "a/b/SKILL.md"},
            new String[]{"a\\b\\SKILL.md", "a/b/SKILL.md"},
            new String[]{"./a/b.md", "a/b.md"},
            new String[]{"a//b.md", "a/b.md"},
            new String[]{"  a/b.md  ", "a/b.md"},
            new String[]{".agents/skills/x/SKILL.md", ".agents/skills/x/SKILL.md"});

    /** Inputs both copies must refuse. */
    private static final List<String> REFUSED = List.of(
            "/abs/SKILL.md",
            "//unc/share/SKILL.md",
            "\\\\srv\\share\\SKILL.md",
            "C:/win/SKILL.md",
            "C:\\win\\SKILL.md",
            "a/../b.md",
            "../escape/SKILL.md",
            "..",
            "a/" + (char) 0 + "b.md");

    @Test
    void acceptedPathsNormaliseIdenticallyInBothCopies() {
        for (String[] sample : ACCEPTED) {
            String nested = NestedAgentsMdResolver.normalizeTouchedPath(sample[0]);
            String skill = SkillImportValidator.normalizePath(sample[0]);
            assertEquals(sample[1], nested, "nested resolver drifted on: " + sample[0]);
            assertEquals(nested, skill, "skill validator drifted from the nested resolver on: "
                    + sample[0]);
        }
    }

    @Test
    void unsafePathsAreRefusedByBothCopies() {
        for (String sample : REFUSED) {
            assertNull(NestedAgentsMdResolver.normalizeTouchedPath(sample),
                    "nested resolver accepted an unsafe path: " + sample);
            assertNull(SkillImportValidator.normalizePath(sample),
                    "skill validator accepted an unsafe path: " + sample);
        }
    }

    @Test
    void blankInputMeansNoUsablePathInBothCopies() {
        for (String sample : new String[]{null, "", "   ", "\n\t "}) {
            String nested = NestedAgentsMdResolver.normalizeTouchedPath(sample);
            String skill = SkillImportValidator.normalizePath(sample);
            // Nested: "" = nothing given. Skill: null = not a usable path. Both = "no path".
            assertTrue(nested == null || nested.isEmpty(), "nested: " + sample);
            assertTrue(skill == null, "skill validator: " + sample);
            assertFalse(nested != null && !nested.isEmpty(), "nested must not invent a path");
        }
    }

    private static void assertNull(String actual, String message) {
        assertTrue(actual == null, message + " (got: " + actual + ")");
    }
}
