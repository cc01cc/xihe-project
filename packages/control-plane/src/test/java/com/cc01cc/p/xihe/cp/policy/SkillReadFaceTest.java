package com.cc01cc.p.xihe.cp.policy;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0628 M2b (#1): {@code skill_read} is a <b>read</b>, not a new permission atom.
 *
 * <p>The design's whole permission argument (D28-36) is that this tool costs nothing on the atom
 * side: it reuses {@code read} + {@code STRUCTURED}, so no default-role seeder, no UI word list and
 * no CLI vocabulary has to move. That claim is only worth anything if it is falsifiable, so the atom
 * count below is a <b>literal</b>: adding an 18th atom — even one nobody seeds — breaks this test on
 * purpose.</p>
 */
class SkillReadFaceTest {

    /**
     * 17 atoms before M2b: the last one is {@code MEMORY_WRITE} (PLAN-0629 M1). Frozen here so an
     * added atom has to be an explicit, reviewed decision rather than an accident.
     */
    private static final int BUILTIN_ACTION_CLASS_COUNT = 17;

    @Test
    void skillReadResolvesToTheExistingReadFace() {
        ToolFaceRegistry registry = new ToolFaceRegistry();

        assertTrue(registry.known("skill_read"), "the tool must be classified, not UNCLASSIFIED/OPAQUE");
        ToolFaceRegistry.Face face = registry.faceOf("skill_read");
        assertEquals(ToolFaceRegistry.ACTION_READ, face.actionClass());
        // STRUCTURED, not OPAQUE (that one means "unknown third-party semantics, default ask") and
        // not INTERPRETER (no argv): the skill id is the resolved target of a bounded read.
        assertEquals(ToolShape.STRUCTURED, face.shape());
    }

    @Test
    void builtinAtomCountIsUnchanged() {
        assertEquals(BUILTIN_ACTION_CLASS_COUNT, ToolFaceRegistry.builtinActionClasses().size(),
                "skill_read must live inside `read`, not add an atom");
        assertFalse(ToolFaceRegistry.builtinActionClasses().contains("skill_read"),
                "a tool name is not an action class");
    }

    @Test
    void skillResourceSpellingMirrorsTheCredentialNamespace() {
        // D28-36: only the resource spelling is new — skill:<uuid>, shaped like credential:<uuid>.
        assertEquals("skill:", ToolFaceRegistry.SKILL_RESOURCE_PREFIX);
    }
}
