package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

/** PLAN-0328 M1: L0 hard guard checks (spec §13.1). */
class HardGuardTest {

    private final HardGuard guard = new HardGuard();

    private static PolicyRequest withResource(String resource) {
        return new PolicyRequest("write_file", List.of("write"), List.of(resource),
                ToolShape.STRUCTURED, "u1", "ws1", "s1");
    }

    @Test
    void blocksWorkspaceEscape() {
        var deny = guard.check(withResource("../../etc/passwd"));
        assertTrue(deny.isPresent());
        assertEquals(HardGuard.Kind.PATH_ESCAPE, deny.get().kind());
        assertTrue(deny.get().kind().enforceableHere());
    }

    @Test
    void blocksCriticalPathDeletion() {
        var deny = guard.check(withResource("/workspace/ws1/.git/config"));
        assertTrue(deny.isPresent());
        assertEquals(HardGuard.Kind.CRITICAL_PATH_DELETION, deny.get().kind());
    }

    @Test
    void flagsCredentialLikeMaterial() {
        var deny = guard.check(withResource("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
        assertTrue(deny.isPresent());
        assertEquals(HardGuard.Kind.CREDENTIAL_EXFILTRATION, deny.get().kind());
    }

    @Test
    void allowsOrdinaryWorkspacePath() {
        assertTrue(guard.check(withResource("src/parser.ts")).isEmpty());
    }

    @Test
    void rejectsEmptyRequest() {
        var deny = guard.check(null);
        assertTrue(deny.isPresent());
        assertEquals(HardGuard.Kind.OBJECT_MISMATCH, deny.get().kind());
    }
}
