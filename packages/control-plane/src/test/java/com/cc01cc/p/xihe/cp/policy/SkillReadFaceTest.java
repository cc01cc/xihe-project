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
     * 27 atoms after PLAN-0651 M2 T2.1: {@code 17 existing + 10 added by this plan} = 27, where
     * N1 ({@code MANAGE_AGENT_PRINCIPALS}) and N10 ({@code MANAGE_WORKSPACE_MEMBERS}) landed in M1
     * (17 → 19) and N2–N9 — {@code READ_INSTANCE_CONTENT}, {@code WRITE_INSTANCE_CONTENT},
     * {@code VIEW_SECRET_CONTENT}, {@code MANAGE_SKILL_LIBRARY},
     * {@code MANAGE_PROVIDER_CONNECTIONS}, {@code USE_WORKSPACE_RUNTIME},
     * {@code MANAGE_WORKSPACE_RUNTIME}, {@code MANAGE_WORKSPACE_POLICY} — add the remaining 8
     * (19 → 27). Frozen here so an added atom has to be an explicit, reviewed decision.
     */
    private static final int BUILTIN_ACTION_CLASS_COUNT = 27;

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
