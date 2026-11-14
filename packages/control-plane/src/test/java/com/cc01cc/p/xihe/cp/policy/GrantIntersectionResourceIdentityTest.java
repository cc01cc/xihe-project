package com.cc01cc.p.xihe.cp.policy;

import java.util.Map;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-521 Q-d：两层授权求交必须落在 {@code phys} 键上，不得退化成字符串相等。
 *
 * <p><b>测试设计约束</b>（501 §11.2）：声明键一律保持「未归一」的原始形态 —— 两条键在串上必须
 * 不同，否则上层归一已经把两条合成一条，phys 缺陷被掩盖，绿的用例测的是声明键归一而不是 phys 求交。
 * 与 task-517 那条「不删 V168 唯一索引，应用层缺陷红不出来」是同一形状：分层防线会互相掩盖。</p>
 */
class GrantIntersectionResourceIdentityTest {

    private static GrantIntersectionEvaluator withScopes(Map<String, ResourceIdentity.RootScope> scopes) {
        GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();
        Function<String, ResourceIdentity.RootScope> resolver = scopes::get;
        evaluator.useScopeResolver(resolver);
        return evaluator;
    }

    /** 红 1：实例级授予 D:/ws 与工作区根 d:/ws/ 是同一物理目录 ⇒ 求交必须非空。 */
    @Test
    void instanceGrantAndWorkspaceRootAreOneDirectory() {
        GrantIntersectionEvaluator evaluator = withScopes(Map.of(
                "inst-1", new ResourceIdentity.RootScope(ResourceIdentity.ScopeKind.INSTANCE, "D:/"),
                "ws-1", new ResourceIdentity.RootScope(ResourceIdentity.ScopeKind.WORKSPACE, "d:/ws/")));

        assertTrue(evaluator.matchesResource("fs:inst-1/D:/ws", "fs:ws-1", ToolShape.STRUCTURED),
                "实例级 D:/ws 与工作区根 d:/ws/ 必须相交（phys 相等）");
    }

    /** 红 2：fs:inst-2/H:/ws/a 与 fs:ws-2/a 指向同一物理目录 ⇒ 必须判同一。 */
    @Test
    void instanceAndWorkspaceSpellingsOfOneDirectoryIntersect() {
        GrantIntersectionEvaluator evaluator = withScopes(Map.of(
                "inst-2", new ResourceIdentity.RootScope(ResourceIdentity.ScopeKind.INSTANCE, "H:/"),
                "ws-2", new ResourceIdentity.RootScope(ResourceIdentity.ScopeKind.WORKSPACE, "H:/ws")));

        assertTrue(evaluator.matchesResource("fs:ws-2/a", "fs:inst-2/H:/ws/a", ToolShape.STRUCTURED),
                "同一物理目录的两种声明写法必须判同一");
    }

    /** 反例：不同物理目录不得相交 —— 挡住「一律返回 true」这种假绿。 */
    @Test
    void differentDirectoriesDoNotIntersect() {
        GrantIntersectionEvaluator evaluator = withScopes(Map.of(
                "inst-2", new ResourceIdentity.RootScope(ResourceIdentity.ScopeKind.INSTANCE, "H:/"),
                "ws-2", new ResourceIdentity.RootScope(ResourceIdentity.ScopeKind.WORKSPACE, "H:/ws")));

        assertFalse(evaluator.matchesResource("fs:ws-2/a", "fs:inst-2/H:/other", ToolShape.STRUCTURED),
                "不同物理目录不得相交");
    }

    /** 防假绿自检：两条声明键在串上确实不同（归一没有替我们合并）。 */
    @Test
    void declarationKeysAreDeliberatelyUnnormalized() {
        assertNotEquals("fs:ws-2/a", "fs:inst-2/H:/ws/a");
        assertNotEquals("fs:inst-1/D:/ws", "fs:ws-1");
    }

    /** ④ 点段 / UNC / 长路径前缀 / 反斜杠 / glob 一律不是声明键（fail-closed）。 */
    @Test
    void parseRejectsDotSegmentsUncExtendedPrefixBackslashAndGlob() {
        assertNull(ResourceIdentity.parseDeclaration(null));
        assertNull(ResourceIdentity.parseDeclaration("credential:abc"));
        assertNull(ResourceIdentity.parseDeclaration("fs:/a"));
        assertNull(ResourceIdentity.parseDeclaration("fs:ws-1/./a"));
        assertNull(ResourceIdentity.parseDeclaration("fs:ws-1/../etc"));
        assertNull(ResourceIdentity.parseDeclaration("fs:ws-1////etc"));
        assertNull(ResourceIdentity.parseDeclaration("fs:ws-1/a\\b"));
        assertNull(ResourceIdentity.parseDeclaration("fs:ws-1/*"));
        assertNull(ResourceIdentity.parseDeclaration("fs:ws-1/**"));
    }

    /** ⑥ 实例级 rel 必带盘符段；工作区级 rel 不得带 —— 两级算出同一个 phys 键。 */
    @Test
    void scopeKindsEnforceTheDriveSegmentRuleAndShareOnePhysicalKey() {
        ResourceIdentity.RootScope workspace =
                new ResourceIdentity.RootScope(ResourceIdentity.ScopeKind.WORKSPACE, "H:/ws");
        ResourceIdentity.RootScope instance =
                new ResourceIdentity.RootScope(ResourceIdentity.ScopeKind.INSTANCE, "H:/");

        assertNull(ResourceIdentity.physicalKeyOf(
                ResourceIdentity.parseDeclaration("fs:ws-1/D:/x"), workspace), "工作区级 rel 不得带盘符段");
        assertNull(ResourceIdentity.physicalKeyOf(
                ResourceIdentity.parseDeclaration("fs:inst-1/a"), instance), "实例级 rel 必带盘符段");

        assertEquals("phys:h:/ws/a", ResourceIdentity.physicalKeyOf(
                ResourceIdentity.parseDeclaration("fs:ws-1/a"), workspace));
        assertEquals("phys:h:/ws/a", ResourceIdentity.physicalKeyOf(
                ResourceIdentity.parseDeclaration("fs:inst-1/H:/ws/a"), instance));
    }

    /** 尾斜杠与根自身都折叠到同一个 phys 键。 */
    @Test
    void trailingSlashAndRootItselfCollapseToOnePhysicalKey() {
        ResourceIdentity.RootScope root =
                new ResourceIdentity.RootScope(ResourceIdentity.ScopeKind.WORKSPACE, "D:/ws/");
        assertEquals("phys:d:/ws", ResourceIdentity.physicalKeyOf(
                ResourceIdentity.parseDeclaration("fs:ws-1"), root));
        assertEquals("phys:d:/ws/a", ResourceIdentity.physicalKeyOf(
                ResourceIdentity.parseDeclaration("fs:ws-1/a/"), root), "尾斜杠折叠后仍是 a，不是根");
    }

    /** ⑦ 解析不出 phys 时拒绝；两侧都不是声明键才回退（通配仍走原匹配器）。 */
    @Test
    void unresolvableDeclarationsAreRefusedInsteadOfStringCompared() {
        assertEquals(Boolean.FALSE, ResourceIdentity.matchesDeclaration("fs:ws-1/a", "fs:ws-2/a", id -> null));
        assertEquals(Boolean.FALSE, ResourceIdentity.matchesDeclaration("fs:ws-1/a", "credential:abc", id -> null));
        assertNull(ResourceIdentity.matchesDeclaration("a/b", "c/d", id -> null));
        assertNull(ResourceIdentity.matchesDeclaration("*", "fs:ws-1/a", id -> null));
    }
}
