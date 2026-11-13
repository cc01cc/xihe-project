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
     * 28 atoms after PLAN-0651 M2 T2.1 + PLAN-0673 M2 (D-166): {@code 17 existing + 10 added by
     * PLAN-0651 + GRANT_ANY_ATOM} = 28, where N1 ({@code MANAGE_AGENT_PRINCIPALS}) and N10
     * ({@code MANAGE_WORKSPACE_MEMBERS}) landed in M1 (17 → 19), N2–N9 —
     * {@code READ_INSTANCE_CONTENT}, {@code WRITE_INSTANCE_CONTENT}, {@code VIEW_SECRET_CONTENT},
     * {@code MANAGE_SKILL_LIBRARY}, {@code MANAGE_PROVIDER_CONNECTIONS},
     * {@code USE_WORKSPACE_RUNTIME}, {@code MANAGE_WORKSPACE_RUNTIME},
     * {@code MANAGE_WORKSPACE_POLICY} — added the remaining 8 (19 → 27), and PLAN-0673 M2 added
     * {@code GRANT_ANY_ATOM} (27 → 28). Frozen here so an added atom has to be an explicit,
     * reviewed decision.
     */
    // BL-345/V129 (2026-11-06) added MEMORY_WRITE_SELF (28 → 29); PLAN-0691 T1.3 (V137) added the
    // four plugin atoms (29 → 33); BL-312 (2026-11-09) removed CREATE_OWN_AGENT (33 → 32);
    // PLAN-0750 M1 (G1, 2026-11-10) restored it with user-level semantics (32 → 33).
    // PLAN-0766 (task-158 / V153, 2026-11-11) added MANAGE_WORKSPACE_DEFAULT_CONFIG (33 → 34).
    // V156 (task-221, D-1019, 2026-11-12) added MANAGE_PERSONAL_SKILLS (34 → 35).
    // task-229 / PLAN-0773 (V157, 2026-11-12) added WRITE_WORKSPACE_CONTENT + MANAGE_WORKSPACE_MCP
    // (35 → 37). PLAN-0773 M2-2 (task-158 / V162, 2026-11-13) added the three org-unit governance
    // atoms (37 → 40).
    private static final int BUILTIN_ACTION_CLASS_COUNT = 40;

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
