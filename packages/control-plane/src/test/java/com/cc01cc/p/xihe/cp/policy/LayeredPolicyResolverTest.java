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

    @Test
    void schemeKeyedResourcesAreResourceIdentitiesNotOsPaths() {
        // D-1556 (task-177): `<kind>:<value>` atoms are resource identities, not filesystem paths.
        // `Path.of("credential:<uuid>")` throws InvalidPathException ON WINDOWS, which made every
        // narrow grant silently deny on the only platform the project runs on (Linux CI stayed green).
        String credentialId = "credential:" + java.util.UUID.randomUUID();
        assertTrue(LayeredPolicyResolver.matches(credentialId, credentialId, ToolShape.STRUCTURED),
                "an exact scheme atom must match itself (before D-1556 this was FALSE on Windows)");
        assertTrue(LayeredPolicyResolver.matches("credential:*", credentialId, ToolShape.STRUCTURED),
                "the ADMIN wildcard must cover a concrete credential id (a `*` that stops at `:` is not a wildcard)");
        assertFalse(LayeredPolicyResolver.matches(
                        "credential:" + java.util.UUID.randomUUID(), credentialId, ToolShape.STRUCTURED),
                "a different scheme value still does not match — the fix must not become a blanket allow");
        String skillId = "skill:" + java.util.UUID.randomUUID();
        assertTrue(LayeredPolicyResolver.matches(skillId, skillId, ToolShape.STRUCTURED),
                "skill:<id> is the same family (SkillReadResourceWiringTest's positive control)");
    }

    @Test
    void schemeNormalisationKeepsFailClosedRulesAndLeavesRealPathsAlone() {
        // Lead requirement on D-1556: only `scheme:value` gets the OS-free normalisation. Dot
        // segments / UNC / extended prefixes stay rejected, and real Windows paths keep Path.of.
        assertFalse(LayeredPolicyResolver.matches(
                        "credential:a/../b", "credential:a/../b", ToolShape.STRUCTURED),
                "dot segments stay fail-closed inside a scheme value too");
        assertFalse(LayeredPolicyResolver.matches(
                        "\\\\?\\C:\\ws", "\\\\?\\C:\\ws", ToolShape.STRUCTURED),
                "extended-length prefixes stay fail-closed");
        assertTrue(LayeredPolicyResolver.matches(
                        "C:/Work/Notes.md", "c:/work/notes.md", ToolShape.STRUCTURED),
                "a real Windows path still normalises through Path.of — control that the scheme branch"
                        + " did not swallow drive-letter paths");
        assertTrue(LayeredPolicyResolver.matches(
                        "Credential:ABC", "credential:abc", ToolShape.STRUCTURED),
                "scheme values fold case like every other lexical comparison");
    }

    @Test
    void schemeNormalisationAgreesWithTheOsNormaliserOnItsSharedDomain() {
        // D-1556 follow-up (Lead, 2026-11-15): the equivalence the fix leans on is
        // "collapseLexically agrees with Path.of().normalize() wherever Path.of accepts the input".
        // That is what makes the scheme branch a NO-OP on Linux (Path.of accepts `credential:<id>`
        // there and returns it unchanged), and it is checkable on any platform because the *value
        // part* of a scheme key is colon-free.
        //
        // (a) the path branch is byte-identical to the pre-D-1556 inline expression, and both
        // branches agree on the domain they share.
        for (String declared : new String[] {"ws/a", "WS/A/", "ws\\a\\", "H:/ws/a",
                "C:\\ws\\A\\", "notes/today.md"}) {
            assertEquals(preFixLexical(declared), PathKey.lexical(declared),
                    "the path branch must keep the pre-D-1556 result for `" + declared + "`");
            assertEquals(PathKey.lexical(declared), PathKey.lexicalPattern(declared),
                    "both branches must agree on the colon-free value `" + declared + "`");
        }
        // (b) the scheme branch = "<kind>:" + the path branch's collapse of the value part.
        String uuid = java.util.UUID.randomUUID().toString();
        assertEquals("credential:" + PathKey.lexical(uuid), PathKey.lexical("credential:" + uuid + "/"),
                "trailing slash inside a scheme key is stripped by the same rule the path branch uses");
        assertEquals("skill:" + PathKey.lexical(uuid), PathKey.lexical("SKILL:" + uuid),
                "case folding inside a scheme key is the path branch's folding, not a second rule set");
        // (c) the one deliberate divergence, pinned on purpose: Path.normalize() folds redundant
        // separators, the OS-free collapse does not. A scheme key never carries `//`; if one ever
        // does, the scheme side is the STRICTER one (no match => deny, never a wider allow).
        assertEquals("ws/a", PathKey.lexical("ws//a"));
        assertEquals("ws//a", PathKey.lexicalPattern("ws//a"));
    }

    /** The pre-D-1556 lexical expression, kept here as the reference the path branch must match. */
    private static String preFixLexical(String raw) {
        String normalized = Path.of(raw).normalize().toString().replace('\\', '/');
        int end = normalized.length();
        while (end > 1 && normalized.charAt(end - 1) == '/') {
            end--;
        }
        return normalized.substring(0, end).toLowerCase(java.util.Locale.ROOT);
    }
}
