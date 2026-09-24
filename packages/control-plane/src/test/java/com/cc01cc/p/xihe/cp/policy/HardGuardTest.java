package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

/** PLAN-0328 M1: L0 hard guard checks (spec §13.1). */
class HardGuardTest {

    private final HardGuard guard = new HardGuard();

    private static PolicyRequest request(String actionClass, String resource) {
        return new PolicyRequest("tool_" + actionClass, List.of(actionClass), List.of(resource),
                ToolShape.STRUCTURED, "u1", "ws1", "s1");
    }

    @Test
    void blocksWorkspaceEscape() {
        var deny = guard.check(request("write", "../../etc/passwd"));
        assertTrue(deny.isPresent());
        assertEquals(HardGuard.Kind.PATH_ESCAPE, deny.get().kind());
        assertTrue(deny.get().kind().enforceableHere());
    }

    @Test
    void blocksCriticalPathDeletion() {
        var deny = guard.check(request("delete", "/workspace/ws1/.git/config"));
        assertTrue(deny.isPresent());
        assertEquals(HardGuard.Kind.CRITICAL_PATH_DELETION, deny.get().kind());
    }

    @Test
    void readingCriticalPathIsNotADeletion() {
        assertTrue(guard.check(request("read", "/workspace/sub/.gitignore")).isEmpty());
        assertTrue(guard.check(request("exec", "git log -- .git/config")).isEmpty());
    }

    @Test
    void flagsCredentialLikeMaterial() {
        var ghp = guard.check(request("write", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
        assertTrue(ghp.isPresent());
        assertEquals(HardGuard.Kind.CREDENTIAL_EXFILTRATION, ghp.get().kind());

        var akia = guard.check(request("write", "AKIA" + "IOSFODNN7EXAMPLE"));
        assertTrue(akia.isPresent());
        assertEquals(HardGuard.Kind.CREDENTIAL_EXFILTRATION, akia.get().kind());

        var openai = guard.check(request("write", "sk-proj-" + "abcdefghijklmnopqrstuvwxyz012345"));
        assertTrue(openai.isPresent());
        assertEquals(HardGuard.Kind.CREDENTIAL_EXFILTRATION, openai.get().kind());

        var pem = guard.check(request("write", "-----BEGIN " + "RSA PRIVATE KEY-----"));
        assertTrue(pem.isPresent());
        assertEquals(HardGuard.Kind.CREDENTIAL_EXFILTRATION, pem.get().kind());
    }

    @Test
    void ordinaryWordsWithCredentialLikeFragmentsAreAllowed() {
        assertTrue(guard.check(request("exec", "grep -r task-notes docs/")).isEmpty());
        assertTrue(guard.check(request("write", "risk-analysis.md")).isEmpty());
    }

    @Test
    void allowsOrdinaryWorkspacePath() {
        assertTrue(guard.check(request("write", "src/parser.ts")).isEmpty());
    }

    @Test
    void workspaceFileResourcesMustBeRelativeAndCannotTraverseParents() {
        for (String tool : List.of("read_file", "write_file", "delete_file", "apply_patch")) {
            for (String path : List.of("C:\\outside\\secret", "/outside/secret", "../secret", "src/../../secret")) {
                var deny = guard.checkWorkspaceResources(tool, List.of(path));
                assertTrue(deny.isPresent(), "expected " + tool + " path rejection for " + path);
                assertEquals(HardGuard.Kind.PATH_ESCAPE, deny.get().kind());
            }
            assertTrue(guard.checkWorkspaceResources(tool, List.of("src/main.java")).isEmpty(),
                    "workspace-relative path should be allowed for " + tool);
        }
        assertTrue(guard.checkWorkspaceResources("execute_command", List.of("C:\\tool.exe")).isEmpty(),
                "command resources have a separate sandbox enforcement contract");
        assertEquals(HardGuard.Kind.PATH_ESCAPE,
                guard.checkWorkspaceResources("apply_patch", List.of("*")).orElseThrow().kind(),
                "patch calls without extracted paths must fail closed");
        assertEquals(HardGuard.Kind.PATH_ESCAPE,
                guard.checkWorkspaceResources("write_file", PolicyResourceExtractor.extract(
                        "{\"params\":{\"arguments\":{\"path\":\"" + "a".repeat(2049) + "\"}}}"))
                        .orElseThrow().kind(),
                "truncated extraction must not authorize a wildcard resource");
    }

    @Test
    void rejectsEmptyRequest() {
        var deny = guard.check(null);
        assertTrue(deny.isPresent());
        assertEquals(HardGuard.Kind.OBJECT_MISMATCH, deny.get().kind());
    }
}
