package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

/**
 * The surviving resolver surface after PLAN-0407 T2.8 (design #18/#21/#27): the shape-aware
 * resource matcher shared with the grant evaluator, plus the rule-row invariants still written by
 * the approval storage path. Layered rule adjudication tests retired with {@code resolve()}.
 */
class LayeredPolicyResolverTest {

    @Test
    void wildcardMatchingSupportsPrefixAndGlob() {
        // 解释器型（命令串）：* 可跨 / 与空格
        assertTrue(LayeredPolicyResolver.matches("git push *", "git push origin main", ToolShape.INTERPRETER));
        assertFalse(LayeredPolicyResolver.matches("git push *", "git pull", ToolShape.INTERPRETER));
        assertTrue(LayeredPolicyResolver.matches("rm -rf *", "rm -rf /tmp/x", ToolShape.INTERPRETER));
        // 结构化（路径）：单 * 不跨 /，** 跨
        assertTrue(LayeredPolicyResolver.matches("*", "anything"));
        assertTrue(LayeredPolicyResolver.matches("src/*.ts", "src/a.ts"));
        assertFalse(LayeredPolicyResolver.matches("src/*.ts", "src/nested/a.ts"));
        assertTrue(LayeredPolicyResolver.matches("src/**", "src/nested/a.ts"));
    }

    @Test
    void pathComparisonAgreesAcrossBothSides() {
        // task-505: containment (PathKey) and policy matching must reach the same verdict on a
        // physically identical path even when case / trailing slashes differ.
        String base = "H:/ws";
        String candidate = "h:\\WS\\A\\";
        assertTrue(PathKey.withinLexical(candidate, base));
        assertTrue(LayeredPolicyResolver.matches("H:/ws/**", candidate, ToolShape.STRUCTURED));
        assertTrue(LayeredPolicyResolver.matches("H:/ws/a", candidate, ToolShape.STRUCTURED));
        assertTrue(LayeredPolicyResolver.matches("h:/WS/A", "H:/ws/a", ToolShape.STRUCTURED));
    }

    @Test
    void dotSegmentsFailClosed() {
        assertFalse(LayeredPolicyResolver.matches("H:/ws/a", "H:/ws/../secrets", ToolShape.STRUCTURED));
        assertFalse(LayeredPolicyResolver.matches("H:/ws/../a", "H:/ws/a", ToolShape.STRUCTURED));
        assertTrue(LayeredPolicyResolver.matches("H:/ws/a", "H:/ws/a", ToolShape.STRUCTURED));
    }

    @Test
    void preFixMatcherWasRedOnCaseAndTrailingSlash() {
        // The pre-task-505 matcher folded only backslashes ("no case fold, no trailing-slash
        // strip"); this witness keeps that shape so the red side is explicit: it says NO MATCH
        // while the containment check and the unified PathKey say MATCH.
        String pattern = "H:/ws/a";
        String value = "h:\\WS\\A\\";
        assertFalse(legacyBackslashOnly(pattern).equals(legacyBackslashOnly(value))); // red side
        assertTrue(PathKey.sameLexical(pattern, value));                              // unified side
    }

    private static String legacyBackslashOnly(String raw) {
        return raw.replace('\\', '/');
    }

    @Test
    void realResolvesSymlinkButLexicalDoesNot() throws IOException {
        // task-505 third negative case: a symlink/junction is lexically OUTSIDE the authorized root
        // but really INSIDE it — the two levels must never be mixed.
        Path root = Files.createTempDirectory("task505-symlink");
        Path inside = Files.createDirectories(root.resolve("inside"));
        Path link = root.resolve("link");
        try {
            Files.createSymbolicLink(link, inside);
        } catch (UnsupportedOperationException | IOException | SecurityException unsupported) {
            Assumptions.assumeTrue(false, "symlink creation unsupported: " + unsupported);
            return;
        }
        assertNotEquals(PathKey.lexical(link.toString()), PathKey.lexical(inside.toString()));
        assertEquals(PathKey.real(link.toString()), PathKey.real(inside.toString()));
    }

    @Test
    void lexicalRejectsUncAndExtendedPrefixes() {
        assertEquals(null, PathKey.lexical("\\\\server\\share\\a"));
        assertEquals(null, PathKey.lexical("\\\\?\\C:\\ws"));
        assertEquals(null, PathKey.lexical("C:/ws/../secrets"));
    }

    @Test
    void lockedAllowIsRejectedAtConstruction() {
        assertThrows(IllegalArgumentException.class,
                () -> new PolicyRule("exec", "*", PolicyEffect.ALLOW, 0, true, 1));
    }
}
