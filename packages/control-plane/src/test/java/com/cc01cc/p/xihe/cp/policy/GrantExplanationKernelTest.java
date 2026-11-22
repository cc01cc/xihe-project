package com.cc01cc.p.xihe.cp.policy;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * DSD-1497 (task-125) acceptance ③: the trail, not just the verdict.
 *
 * <p>Six families that a caller actually hits are pinned here so {@code deepestMissingLevel} cannot
 * quietly collapse into "somewhere": an atom missing on a shared level (交汇), a missing level deep in
 * a parent chain (父链两级), an fs declaration that does not cover the request (fs 前缀), a level that
 * only holds instance-scope atoms (instance-only), an atom outside the action vocabulary (能力原子),
 * and a level that carries no grants at all (空 grants). Each case asserts the level index AND the
 * reason token, because "denied at level 1" is only useful if it says whether the level was empty or
 * simply did not match.</p>
 *
 * <p>Everything here is the pure kernel: no Spring, no database. The wiring that fills the level
 * from real grant rows is {@code RequesterAuthority.explainForUser} and is pinned by the golden-row
 * test and the HTTP contract test.</p>
 */
class GrantExplanationKernelTest {

    private static final String GRANT_ID = "11111111-2222-3333-4444-555555555555";

    private GrantIntersectionEvaluator evaluator() {
        Map<String, ResourceIdentity.RootScope> scopes = new LinkedHashMap<>();
        scopes.put("ws-root", new ResourceIdentity.RootScope(ResourceIdentity.ScopeKind.WORKSPACE, "H:/ws"));
        scopes.put("inst-root", new ResourceIdentity.RootScope(ResourceIdentity.ScopeKind.INSTANCE, "H:/"));
        GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();
        evaluator.useScopeResolver(scopes::get);
        return evaluator;
    }

    @Test
    void anAtomMissingOnASharedLevelStopsTheIntersectionAtThatLevel() {
        GrantIntersectionEvaluator evaluator = evaluator();
        PolicyRequest request = request(List.of("read", "write"), List.of("*"), ToolShape.OPAQUE);
        List<GrantIntersectionEvaluator.PrincipalLevel> levels = List.of(
                level("session snapshot", atom("read", "*", GRANT_ID, "role")),
                level("workspace binding", atom("read", "*", "22222222-2222-3333-4444-555555555555", "direct")));

        GrantIntersectionEvaluator.GrantExplanation explanation = evaluator.explain(request, levels);

        assertFalse(explanation.allowed());
        assertEquals(1, explanation.deepestMissingLevel(), "缺的是第 2 级（索引 1）的 write");
        assertNotNull(explanation.missingAtom());
        assertEquals(1, explanation.missingAtom().level());
        assertEquals("action:write", explanation.missingAtom().actionClass());
        assertEquals(GrantIntersectionEvaluator.REASON_NO_MATCHING_ATOM, explanation.missingAtom().reason());
        assertEquals(2, explanation.missingLevels().size(), "两个层级都缺 write");
        assertTrue(explanation.matchedGrantRefs().stream()
                        .allMatch(ref -> "action:read".equals(ref.actionClass())),
                "只有 read 有可引用的命中行: " + explanation.matchedGrantRefs());
    }

    @Test
    void aParentChainMissingTwoLevelsReportsTheDeepestOne() {
        GrantIntersectionEvaluator evaluator = evaluator();
        PolicyRequest request = request(List.of("read"), List.of("*"), ToolShape.OPAQUE);
        List<GrantIntersectionEvaluator.PrincipalLevel> levels = List.of(
                level("principal", atom("read", "*", GRANT_ID, "role")),
                level("session snapshot", atom("write", "*", GRANT_ID, "role")),
                level("workspace binding", atom("read", "credential:other", GRANT_ID, "role")));

        GrantIntersectionEvaluator.GrantExplanation explanation = evaluator.explain(request, levels);

        assertFalse(explanation.allowed());
        assertEquals(2, explanation.deepestMissingLevel(), "最深缺失级是索引 2");
        assertEquals(2, explanation.missingAtom().level());
        assertEquals(2, explanation.missingLevels().size(), "索引 1 与 2 都缺");
        assertEquals(3, explanation.evaluatedLevels().size());
        assertTrue(explanation.evaluatedLevels().get(0).matched(), "第 1 级命中");
        assertFalse(explanation.evaluatedLevels().get(1).matched());
        assertFalse(explanation.evaluatedLevels().get(2).matched());
        assertEquals(1, explanation.evaluatedLevels().get(2).atomCount());
    }

    @Test
    void anFsDeclarationCoversOnlyItsOwnSubtree() {
        GrantIntersectionEvaluator evaluator = evaluator();
        List<GrantIntersectionEvaluator.PrincipalLevel> levels = List.of(
                level("workspace snapshot", atom("read", "fs:ws-root/a/b", GRANT_ID, "role")));

        GrantIntersectionEvaluator.GrantExplanation inside = evaluator.explain(
                request(List.of("read"), List.of("fs:ws-root/a/b/c"), ToolShape.STRUCTURED), levels);
        assertTrue(inside.allowed(), "子路径必须被前缀声明覆盖: " + inside);
        assertEquals(-1, inside.deepestMissingLevel());
        assertNull(inside.missingAtom());

        GrantIntersectionEvaluator.GrantExplanation outside = evaluator.explain(
                request(List.of("read"), List.of("fs:ws-root/a/bc"), ToolShape.STRUCTURED), levels);
        assertFalse(outside.allowed(), "同前缀但不是子段（bc != b）不得被覆盖");
        assertEquals(0, outside.deepestMissingLevel());
        assertEquals(GrantIntersectionEvaluator.REASON_NO_MATCHING_ATOM, outside.missingAtom().reason());
    }

    @Test
    void anInstanceOnlyLevelCannotAnswerAWorkspaceScopedAtom() {
        GrantIntersectionEvaluator evaluator = evaluator();
        // The user path reads instance rows always and workspace rows only for the addressed
        // workspace (findScopedGrants). A level built from instance rows therefore holds read but
        // never MANAGE_ROLES, and the explanation must say so at level 0 rather than blame the request.
        List<GrantIntersectionEvaluator.PrincipalLevel> instanceOnly = List.of(
                level("user-grants",
                        atom("read", "*", GRANT_ID, "role"),
                        atom("exec", "*", "33333333-2222-3333-4444-555555555555", "role")));

        GrantIntersectionEvaluator.GrantExplanation readable = evaluator.explain(
                request(List.of("read"), List.of("*"), ToolShape.OPAQUE), instanceOnly);
        assertTrue(readable.allowed());

        GrantIntersectionEvaluator.GrantExplanation governed = evaluator.explain(
                request(List.of("MANAGE_ROLES"), List.of("*"), ToolShape.OPAQUE), instanceOnly);
        assertFalse(governed.allowed());
        assertEquals(0, governed.deepestMissingLevel());
        assertEquals("action:MANAGE_ROLES", governed.missingAtom().actionClass());
        assertEquals(GrantIntersectionEvaluator.REASON_NO_MATCHING_ATOM, governed.missingAtom().reason());
        assertEquals(2, governed.evaluatedLevels().get(0).atomCount(), "该级确实有 2 个原子，只是不含目标原子");
    }

    @Test
    void aCapabilityAtomIsRefusedBeforeAnyLevelIsEvaluated() {
        GrantIntersectionEvaluator evaluator = evaluator();
        GrantIntersectionEvaluator.GrantExplanation explanation = evaluator.explain(
                request(List.of("instance:admin"), List.of("*"), ToolShape.OPAQUE),
                List.of(level("user-grants", atom("read", "*", GRANT_ID, "role"))));

        assertFalse(explanation.allowed());
        assertEquals(-1, explanation.deepestMissingLevel(), "词汇表拒绝发生在级别求值之前");
        assertNotNull(explanation.missingAtom());
        assertEquals(-1, explanation.missingAtom().level());
        assertEquals(GrantIntersectionEvaluator.REASON_UNKNOWN_ACTION_CLASS, explanation.missingAtom().reason());
        assertTrue(explanation.matchedGrantRefs().isEmpty());
        assertTrue(explanation.evaluatedLevels().isEmpty());
    }

    @Test
    void anEmptyLevelIsNamedAsEmptyNotEmptyAsMismatched() {
        GrantIntersectionEvaluator evaluator = evaluator();
        GrantIntersectionEvaluator.GrantExplanation explanation = evaluator.explain(
                request(List.of("read"), List.of("*"), ToolShape.OPAQUE),
                List.of(level("user-grants")));

        assertFalse(explanation.allowed());
        assertEquals(0, explanation.deepestMissingLevel());
        assertEquals(GrantIntersectionEvaluator.REASON_LEVEL_WITHOUT_GRANTS, explanation.missingAtom().reason());
        assertEquals(0, explanation.evaluatedLevels().get(0).atomCount());
    }

    @Test
    void preChecksCarryTheirOwnReasonTokens() {
        GrantIntersectionEvaluator evaluator = evaluator();
        List<GrantIntersectionEvaluator.PrincipalLevel> levels = List.of(
                level("user-grants", atom("read", "*", GRANT_ID, "role")));

        GrantIntersectionEvaluator.GrantExplanation emptyRequest = evaluator.explain(null, levels);
        assertFalse(emptyRequest.allowed());
        assertEquals(GrantIntersectionEvaluator.REASON_EMPTY_REQUEST, emptyRequest.missingAtom().reason());

        GrantIntersectionEvaluator.GrantExplanation emptyPath = evaluator.explain(
                request(List.of("read"), List.of("*"), ToolShape.OPAQUE), List.of());
        assertFalse(emptyPath.allowed());
        assertEquals(GrantIntersectionEvaluator.REASON_EMPTY_PRINCIPAL_PATH, emptyPath.missingAtom().reason());

        GrantIntersectionEvaluator.GrantExplanation blankResource = evaluator.explain(
                request(List.of("read"), List.of("  "), ToolShape.OPAQUE), levels);
        assertFalse(blankResource.allowed());
        assertEquals(GrantIntersectionEvaluator.REASON_BLANK_RESOURCE, blankResource.missingAtom().reason());
    }

    @Test
    void matchedRefsCiteTheRowThatAuthorizedAndDoNotRepeatIt() {
        GrantIntersectionEvaluator evaluator = evaluator();
        String secondGrant = "66666666-2222-3333-4444-555555555555";
        List<GrantIntersectionEvaluator.PrincipalLevel> levels = List.of(
                level("user-grants",
                        atom("read", "*", GRANT_ID, "role"),
                        atom("read", "*", secondGrant, "template")));

        GrantIntersectionEvaluator.GrantExplanation explanation = evaluator.explain(
                request(List.of("read"), List.of("*"), ToolShape.OPAQUE), levels);

        assertTrue(explanation.allowed());
        assertEquals(2, explanation.matchedGrantRefs().size(), "两行都真的授权了，都要能引用");
        Set<String> cited = new java.util.LinkedHashSet<>();
        for (GrantIntersectionEvaluator.MatchedGrant ref : explanation.matchedGrantRefs()) {
            cited.add(ref.grantId() + "|" + ref.grantSource());
            assertEquals(0, ref.level());
            assertEquals("user-grants", ref.levelLabel());
        }
        assertEquals(Set.of(GRANT_ID + "|role", secondGrant + "|template"), cited);
    }

    @Test
    void allowsAndExplainNeverDisagreeOnTheSameInputs() {
        GrantIntersectionEvaluator evaluator = evaluator();
        List<List<GrantIntersectionEvaluator.PrincipalLevel>> paths = List.of(
                List.of(),
                List.of(level("empty")),
                List.of(level("one", atom("read", "*", GRANT_ID, "role"))),
                List.of(level("one", atom("write", "*", GRANT_ID, "role")),
                        level("two", atom("read", "*", GRANT_ID, "role"))),
                List.of(level("one", atom("read", "*", GRANT_ID, "role")),
                        level("two", atom("read", "*", GRANT_ID, "role"))));
        List<PolicyRequest> requests = List.of(
                request(List.of("read"), List.of("*"), ToolShape.OPAQUE),
                request(List.of("write"), List.of("*"), ToolShape.OPAQUE),
                request(List.of("read", "write"), List.of("*"), ToolShape.OPAQUE),
                request(List.of("read"), List.of("fs:ws-root/a"), ToolShape.STRUCTURED),
                request(List.of("instance:admin"), List.of("*"), ToolShape.OPAQUE));
        int checked = 0;
        for (PolicyRequest request : requests) {
            for (List<GrantIntersectionEvaluator.PrincipalLevel> path : paths) {
                checked++;
                List<Set<GrantIntersectionEvaluator.PermissionAtom>> atoms = new ArrayList<>();
                for (GrantIntersectionEvaluator.PrincipalLevel level : path) {
                    List<GrantIntersectionEvaluator.PermissionAtom> converted = new ArrayList<>();
                    level.atoms().forEach(row -> converted.add(row.toPermissionAtom()));
                    atoms.add(Set.copyOf(converted));
                }
                boolean decided = evaluator.allows(request, atoms);
                boolean explained = evaluator.explain(request, path).allowed();
                assertEquals(decided, explained, "同一输入上 allows 与 explain 分歧: request="
                        + request.actionClasses() + " levels=" + path.size());
            }
        }
        assertEquals(25, checked);
    }

    private static GrantIntersectionEvaluator.PrincipalLevel level(String label,
                                                                   GrantIntersectionEvaluator.GrantAtom... atoms) {
        return new GrantIntersectionEvaluator.PrincipalLevel(label, List.of(atoms));
    }

    private static GrantIntersectionEvaluator.GrantAtom atom(String actionClass, String resource,
                                                             String grantId, String grantSource) {
        // task-835: grant rows carry canonical atoms; fixtures follow the stored form.
        return new GrantIntersectionEvaluator.GrantAtom(
                com.cc01cc.p.xihe.cp.policy.AtomNames.action(actionClass),
                resource, grantId, grantSource);
    }

    private static PolicyRequest request(List<String> actionClasses, List<String> resources, ToolShape shape) {
        return new PolicyRequest("test_tool", actionClasses, resources, shape, "user-1", "workspace-1", "session-1");
    }
}
