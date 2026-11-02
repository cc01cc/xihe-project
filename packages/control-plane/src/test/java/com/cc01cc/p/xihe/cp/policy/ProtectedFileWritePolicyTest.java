package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import com.cc01cc.p.xihe.cp.files.WorkspaceFileController;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0627 D27-20 (Q2 = C′): path-conditional three-tier write policy for protected files.
 *
 * <p>The tiers are expressed with the existing vocabulary, not a new enum:
 * <ul>
 *   <li><b>ask</b> (default) — mutating a protected file name always asks, and {@code auto}
 *       mode deliberately does not bypass it;</li>
 *   <li><b>deny</b> (read-only principal) — owned upstream by the grant gate / hard guard, so
 *       this branch must never produce a DENY of its own;</li>
 *   <li><b>allow</b> — every other path keeps its current verdict (a "trusted editor" is an
 *       ordinary {@code write} grant scoped to the protected-file glob, still approval-gated).</li>
 * </ul>
 *
 * <p>Also pins the boundary the user cares about: the browser write path
 * ({@link WorkspaceFileController} to Runtime) does not run this engine at all, so a user
 * editing their own {@code AGENTS.md} in the UI is unrestricted.
 */
class ProtectedFileWritePolicyTest {
    private static final String SESSION = UUID.randomUUID().toString();
    private static final String USER = UUID.randomUUID().toString();
    private static final String WORKSPACE = UUID.randomUUID().toString();

    private final AuditLogger audit = mock(AuditLogger.class);
    private final PolicyEngine engine = new PolicyEngine(audit, new BuiltinPolicyContextProvider());

    private static String writeBody(String path) {
        // JSON-escape the path so a Windows-style separator survives parsing.
        String escaped = path.replace("\\", "\\\\").replace("\"", "\\\"");
        return "{\"params\":{\"arguments\":{\"path\":\"" + escaped + "\"}}}";
    }

    private PolicyVerdict verdict(String tool, String body, String mode) {
        return engine.evaluateVerdict(PolicyContext.EMPTY, tool, body, SESSION, mode, USER, WORKSPACE);
    }

    // ---- ask tier: the protected-file default -------------------------------------------
    @Test
    void protectedFileWriteAsksInManualMode() {
        // In manual mode `write` is already on the default ask list, so the ask comes from the
        // existing tier; the protected-file branch must not weaken or duplicate it.
        PolicyVerdict result = verdict("write_file", writeBody("src/AGENTS.md"), "manual");
        assertEquals(PolicyEffect.ASK, result.effect());
    }

    @Test
    void autoModeDoesNotBypassTheProtectedFileAsk() {
        PolicyVerdict result = verdict("write_file", writeBody("src/AGENTS.md"), "auto");
        assertEquals(PolicyEffect.ASK, result.effect());
        assertNull(result.allowedBy(), "auto mode must not bypass a protected-file write");
        assertTrue(result.reason().startsWith("protected file requires approval"),
                "the protected-file branch is what stops the auto bypass, got: " + result.reason());
    }

    @Test
    void protectedFileIsMatchedAtAnyDepthAndRegardlessOfSeparatorOrCase() {
        for (String path : List.of(
                "AGENTS.md",
                "a/b/AGENTS.md",
                "a\\b\\agents.md",
                "./deep/Agents.MD")) {
            PolicyVerdict result = verdict("write_file", writeBody(path), "auto");
            assertEquals(PolicyEffect.ASK, result.effect(), "path should be protected: " + path);
        }
    }

    @Test
    void protectedFilePatternRejectsLookalikes() {
        for (String path : List.of("AGENTS.md.bak", "docs/AGENTS.md.txt", "src/agent.md", "src/NOTES.md")) {
            PolicyVerdict result = verdict("write_file", writeBody(path), "auto");
            assertEquals(PolicyEffect.ALLOW, result.effect(), "path must stay unprotected: " + path);
        }
    }

    @Test
    void applyPatchTargetingProtectedFileAlsoAsks() {
        String body = "{\"params\":{\"arguments\":{\"path\":\"pkg/AGENTS.md\"}}}";
        PolicyVerdict result = verdict("apply_patch", body, "auto");
        assertEquals(PolicyEffect.ASK, result.effect());
        assertNull(result.allowedBy());
    }

    // ---- allow tier: unchanged behaviour everywhere else --------------------------------
    @Test
    void nonProtectedWriteKeepsTheExistingAutoBypass() {
        PolicyVerdict result = verdict("write_file", writeBody("src/NOTES.md"), "auto");
        assertEquals(PolicyEffect.ALLOW, result.effect());
        assertTrue(result.allowedBy() != null && result.allowedBy().startsWith("auto@"),
                "non-protected writes keep the pre-existing auto bypass");
    }

    @Test
    void readingAProtectedFileIsNotGatedByThisRule() {
        PolicyVerdict result = verdict("read_file", writeBody("src/AGENTS.md"), "auto");
        assertEquals(PolicyEffect.ALLOW, result.effect());
    }

    // ---- deny tier: owned upstream, never produced by this branch ------------------------
    @Test
    void readOnlyPrincipalIsDeniedUpstreamNotByTheProtectedFileBranch() {
        GrantAuthorizationService grants = mock(GrantAuthorizationService.class);
        when(grants.allows(any())).thenReturn(false);
        when(grants.allowsUserOnly(any())).thenReturn(false);
        PolicyEngine gatedEngine = new PolicyEngine(audit, new BuiltinPolicyContextProvider(), grants);

        boolean allowed = gatedEngine.allowsByGrant(PolicyContext.EMPTY, "write_file",
                writeBody("src/AGENTS.md"), SESSION, USER, WORKSPACE, false);

        assertFalse(allowed, "a read-only principal is denied by the grant gate");
        // The verdict layer never turns that denial into an ALLOW, and never invents a DENY.
        PolicyVerdict result = gatedEngine.evaluateVerdict(PolicyContext.EMPTY, "write_file",
                writeBody("src/AGENTS.md"), SESSION, "auto", USER, WORKSPACE);
        assertEquals(PolicyEffect.ASK, result.effect());
    }

    @Test
    void hardGuardSemanticsAreUntouchedByTheProtectedFileRule() {
        // delete_file is classified as ACTION_WRITE in this codebase and `write` is on the
        // default ask list, so auto bypasses it exactly as before this change. What matters
        // here is non-interference: the new branch must not fire and must not deny; critical
        // path denials stay with HardGuard (deliberately not modified by PLAN-0627).
        PolicyVerdict result = verdict("delete_file", writeBody(".git/config"), "auto");
        assertEquals(PolicyEffect.ALLOW, result.effect());
        assertFalse(result.reason() != null && result.reason().startsWith("protected file"),
                "protected-file rule must stay scoped to protected file names");
    }

    // ---- boundary pin: the UI/user write path is unrestricted ---------------------------
    @Test
    void browserFileWritesDoNotRunTheAgentPolicy() {
        List<Class<?>> dependencies = Arrays.stream(WorkspaceFileController.class.getDeclaredFields())
                .map(Field::getType)
                .toList();
        List<Class<?>> constructorDependencies = Arrays.stream(WorkspaceFileController.class.getDeclaredConstructors())
                .map(Constructor::getParameterTypes)
                .flatMap(Arrays::stream)
                .toList();
        List<Class<?>> all = new java.util.ArrayList<>(dependencies);
        all.addAll(constructorDependencies);
        assertFalse(all.contains(PolicyEngine.class),
                "UI file writes must not consult the agent policy engine (user edits own files)");
        assertFalse(all.contains(HardGuard.class) || all.contains(ToolFaceRegistry.class),
                "UI file writes must not consult tool-face/hard-guard classification");
    }

    // ---- registry classification ------------------------------------------------------
    @Test
    void registryClassifiesProtectedFileNames() {
        assertEquals(java.util.Set.of("AGENTS.md"), ToolFaceRegistry.PROTECTED_WRITE_FILENAMES);
        assertTrue(ToolFaceRegistry.mutatesProtectedFile(List.of("src/AGENTS.md")));
        assertTrue(ToolFaceRegistry.mutatesProtectedFile(List.of("a", "b/AGENTS.md")));
        assertFalse(ToolFaceRegistry.mutatesProtectedFile(List.of("src/agent.md")));
        assertFalse(ToolFaceRegistry.mutatesProtectedFile(List.of("*")));
        assertFalse(ToolFaceRegistry.mutatesProtectedFile(null));
    }
}
