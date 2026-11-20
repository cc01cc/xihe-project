package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * DSD-1500 R1 (task-115): the delete atom rewiring.
 *
 * <p>Before this change a deletion request carried only the {@code write} atom, so
 * {@link HardGuard}'s critical-path branch (keyed on {@code delete}) never ran and a write grant
 * silently authorized a delete. These tests pin the four faces of the rewiring:
 * <ol>
 *   <li>a deletion without a {@code delete} atom is refused by the L0 hard guard; </li>
 *   <li>a deletion <b>with</b> the atom on an ordinary path passes; </li>
 *   <li>a write-only principal cannot substitute {@code write} for {@code delete}; </li>
 *   <li>non-deletion tools keep their pre-change behaviour (the change must not widen).</li>
 * </ol>
 */
class DeleteAtomRewireTest {
    private static final String SESSION = UUID.randomUUID().toString();
    private static final String USER = UUID.randomUUID().toString();
    private static final String WORKSPACE = UUID.randomUUID().toString();

    private final AuditLogger audit = mock(AuditLogger.class);
    private final ToolFaceRegistry registry = new ToolFaceRegistry();
    private final GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();

    private static String body(String path) {
        String escaped = path.replace("\\", "\\\\").replace("\"", "\\\"");
        return "{\"params\":{\"arguments\":{\"path\":\"" + escaped + "\"}}}";
    }

    private PolicyRequest request(String tool, String path) {
        ToolFaceRegistry.Face face = registry.faceOf(tool);
        return new PolicyRequest(tool, registry.actionClassesOf(tool), List.of(path),
                face.shape(), USER, WORKSPACE, SESSION);
    }

    // ---- face table ---------------------------------------------------------------------
    @Test
    void deletionToolsCarryTheDeleteAtomAndOnlyThatAtom() {
        for (String tool : List.of("delete_file", "delete_directory")) {
            assertEquals(ToolFaceRegistry.ACTION_DELETE, registry.faceOf(tool).actionClass(), tool);
            assertEquals(List.of(ToolFaceRegistry.ACTION_DELETE), registry.actionClassesOf(tool), tool);
        }
        assertEquals(ToolFaceRegistry.ACTION_WRITE, registry.faceOf("write_file").actionClass());
        assertEquals(List.of(ToolFaceRegistry.ACTION_WRITE), registry.actionClassesOf("write_file"));
    }

    @Test
    void moveIsADeleteAndAWriteAndNeedsBoth() {
        assertEquals(List.of(ToolFaceRegistry.ACTION_DELETE, ToolFaceRegistry.ACTION_WRITE),
                registry.actionClassesOf("move_file"));

        var deleteOnly = List.of(Set.of(new GrantIntersectionEvaluator.PermissionAtom("delete", "*")));
        var writeOnly = List.of(Set.of(new GrantIntersectionEvaluator.PermissionAtom("write", "*")));
        var both = List.of(Set.of(
                new GrantIntersectionEvaluator.PermissionAtom("delete", "*"),
                new GrantIntersectionEvaluator.PermissionAtom("write", "*")));

        PolicyRequest move = request("move_file", "docs/a.md");
        assertFalse(evaluator.allows(move, deleteOnly), "delete alone must not authorize a move");
        assertFalse(evaluator.allows(move, writeOnly), "write alone must not authorize a move");
        assertTrue(evaluator.allows(move, both), "both domains authorize the move");
    }

    @Test
    void anExplicitlyClassifiedFaceInheritsNoBuiltinExtraDomains() {
        var overridden = new ToolFaceRegistry(Map.of(
                "move_file", new ToolFaceRegistry.Face(ToolFaceRegistry.ACTION_WRITE, ToolShape.STRUCTURED)));
        assertEquals(List.of(ToolFaceRegistry.ACTION_WRITE), overridden.actionClassesOf("move_file"),
                "an operator-declared face keeps exactly the class it declares");
    }

    @Test
    void mutationVocabularyIsWriteOrDelete() {
        assertTrue(ToolFaceRegistry.isMutationActionClass(ToolFaceRegistry.ACTION_WRITE));
        assertTrue(ToolFaceRegistry.isMutationActionClass(ToolFaceRegistry.ACTION_DELETE));
        assertFalse(ToolFaceRegistry.isMutationActionClass(ToolFaceRegistry.ACTION_READ));
        assertFalse(ToolFaceRegistry.isMutationActionClass(ToolFaceRegistry.ACTION_EXEC));
    }

    // ---- 正1: a deletion without the delete atom is refused by L0 ------------------------
    @Test
    void deletionOfACriticalPathIsRefusedByTheHardGuardBeforeAnyGrantIsConsulted() {
        // A fully permissive grant must not matter: the L0 floor decides first and alone. (A
        // two-argument engine has no grant service at all, and then allowsByGrant refuses for that
        // reason instead -- which would make this test prove nothing about the guard.)
        GrantAuthorizationService grants = mock(GrantAuthorizationService.class);
        when(grants.allows(any())).thenReturn(true);
        PolicyEngine engine = new PolicyEngine(audit, new BuiltinPolicyContextProvider(), grants);

        boolean allowed = engine.allowsByGrant(PolicyContext.EMPTY, "delete_file",
                body(".git/config"), SESSION, USER, WORKSPACE, false);

        assertFalse(allowed, "the L0 floor must refuse deleting .git even when every grant passes");
        verify(grants, never()).allows(any());
        verify(audit).record(eq(SESSION), eq("delete_file"), eq("policy_hard_deny"),
                contains(HardGuard.Kind.CRITICAL_PATH_DELETION.name()));

        PolicyVerdict verdict = engine.evaluateVerdict(PolicyContext.EMPTY, "delete_file",
                body(".git/config"), SESSION, "auto", USER, WORKSPACE);
        assertEquals(PolicyEffect.DENY, verdict.effect());
        assertEquals("hard guard: critical path is protected from irreversible deletion: .git/config",
                verdict.reason());
    }

    // ---- 反1: write does not substitute for delete ---------------------------------------
    @Test
    void writeAtomCannotSubstituteForDeleteOnANormalPath() {
        var writeOnly = List.of(Set.of(new GrantIntersectionEvaluator.PermissionAtom("write", "*")));
        var deleteAtom = List.of(Set.of(new GrantIntersectionEvaluator.PermissionAtom("delete", "*")));

        PolicyRequest deletion = request("delete_file", "src/old.ts");
        assertFalse(evaluator.allows(deletion, writeOnly),
                "a write-only principal must not authorize a delete");
        assertTrue(evaluator.allows(deletion, deleteAtom));

        // and the gate really forwards the delete atom to the grant service (not write)
        GrantAuthorizationService grants = mock(GrantAuthorizationService.class);
        when(grants.allows(any())).thenReturn(true);
        PolicyEngine engine = new PolicyEngine(audit, new BuiltinPolicyContextProvider(), grants);
        assertTrue(engine.allowsByGrant(PolicyContext.EMPTY, "delete_file", body("src/old.ts"),
                SESSION, USER, WORKSPACE, false));

        ArgumentCaptor<PolicyRequest> captured = ArgumentCaptor.forClass(PolicyRequest.class);
        verify(grants).allows(captured.capture());
        assertEquals(List.of(ToolFaceRegistry.ACTION_DELETE), captured.getValue().actionClasses(),
                "the grant gate must be asked about delete, not write");
    }

    // ---- 正2: delete atom plus an ordinary path passes ----------------------------------
    @Test
    void deletionWithTheDeleteAtomOnAnOrdinaryPathIsAllowed() {
        GrantAuthorizationService grants = mock(GrantAuthorizationService.class);
        when(grants.allows(any())).thenReturn(true);
        PolicyEngine engine = new PolicyEngine(audit, new BuiltinPolicyContextProvider(), grants);

        assertTrue(engine.allowsByGrant(PolicyContext.EMPTY, "delete_file", body("src/old.ts"),
                SESSION, USER, WORKSPACE, false));

        PolicyVerdict verdict = engine.evaluateVerdict(PolicyContext.EMPTY, "delete_file",
                body("src/old.ts"), SESSION, "auto", USER, WORKSPACE);
        assertEquals(PolicyEffect.ALLOW, verdict.effect());
        assertTrue(verdict.allowedBy() != null && verdict.allowedBy().startsWith("auto@"),
                "auto mode keeps its pre-existing bypass for an ordinary deletion");
    }

    // ---- 反2: non-deletion tools are unchanged ------------------------------------------
    @Test
    void nonDeletionToolsKeepTheirPreChangeBehaviour() {
        PolicyEngine engine = new PolicyEngine(audit, new BuiltinPolicyContextProvider());

        // write_file on a normal path: auto still bypasses, no hard deny
        PolicyVerdict writeVerdict = engine.evaluateVerdict(PolicyContext.EMPTY, "write_file",
                body("src/NOTES.md"), SESSION, "auto", USER, WORKSPACE);
        assertEquals(PolicyEffect.ALLOW, writeVerdict.effect());

        // write_file on .git/config is NOT a deletion: the critical-path floor must not fire
        assertTrue(new HardGuard().check(request("write_file", ".git/config")).isEmpty(),
                "the critical-path floor applies to deletions only");

        // reading a critical path stays allowed as well
        assertTrue(new HardGuard().check(request("read_file", ".git/config")).isEmpty());
    }
}
