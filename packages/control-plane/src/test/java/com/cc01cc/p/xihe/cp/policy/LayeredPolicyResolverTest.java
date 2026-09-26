package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
    void lockedAllowIsRejectedAtConstruction() {
        assertThrows(IllegalArgumentException.class,
                () -> new PolicyRule("exec", "*", PolicyEffect.ALLOW, 0, true, 1));
    }
}
