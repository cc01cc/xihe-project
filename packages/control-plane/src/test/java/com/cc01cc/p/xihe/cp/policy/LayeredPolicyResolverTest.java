package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * PLAN-0328 M1: layered resolution semantics (spec §4.2) and the code-built hard guard (§13.1).
 */
class LayeredPolicyResolverTest {

    private final LayeredPolicyResolver resolver = new LayeredPolicyResolver();

    private static PolicyRequest request(String actionClass, String... resources) {
        // exec 域按解释器型建模：resource 为命令串，通配不受路径分隔符限制（spec §8.1）
        ToolShape shape = ToolFaceRegistry.ACTION_EXEC.equals(actionClass)
                ? ToolShape.INTERPRETER : ToolShape.STRUCTURED;
        return new PolicyRequest("tool_" + actionClass, List.of(actionClass),
                List.of(resources.length == 0 ? "*" : resources[0]),
                shape, "u1", "ws1", "s1");
    }

    private static PolicyRequest multiDomain(List<String> domains, List<String> resources) {
        ToolShape shape = domains.stream().allMatch(ToolFaceRegistry.ACTION_EXEC::equals)
                ? ToolShape.INTERPRETER : ToolShape.STRUCTURED;
        return new PolicyRequest("tool_multi", domains, resources, shape, "u1", "ws1", "s1");
    }

    private static LayeredPolicyResolver.LayerInput layer(PolicyLayer layer, PolicyRule... rules) {
        return new LayeredPolicyResolver.LayerInput(layer, List.of(rules));
    }

    @Test
    void selectsHighestConfiguredLayerPerDomain() {
        var layers = List.of(
                layer(PolicyLayer.USER, PolicyRule.of("exec", "*", PolicyEffect.DENY)),
                layer(PolicyLayer.WORKSPACE, PolicyRule.of("exec", "pnpm test *", PolicyEffect.ALLOW)));

        PolicyVerdict verdict = resolver.resolve(request("exec", "pnpm test -- --run"), layers,
                LayeredPolicyResolver.MODE_DEFAULT, PolicyLayer.BUILTIN);

        // workspace configures the domain → user's broader deny is not merged in
        assertEquals(PolicyEffect.ALLOW, verdict.effect());
        assertEquals(PolicyLayer.WORKSPACE, verdict.sourceLayer());
    }

    @Test
    void sameLayerDenyWinsOverAllowAtSameSpecificity() {
        var layers = List.of(layer(PolicyLayer.WORKSPACE,
                PolicyRule.of("exec", "pnpm *", PolicyEffect.ALLOW, 10, 1),
                PolicyRule.of("exec", "pnpm *", PolicyEffect.DENY, 0, 2)));

        PolicyVerdict verdict = resolver.resolve(request("exec", "pnpm test"), layers,
                LayeredPolicyResolver.MODE_DEFAULT, PolicyLayer.BUILTIN);

        assertEquals(PolicyEffect.DENY, verdict.effect());
    }

    @Test
    void exactDenyIsNotOverriddenByBroadAllow() {
        var layers = List.of(layer(PolicyLayer.WORKSPACE,
                PolicyRule.of("exec", "*", PolicyEffect.ALLOW, 99, 1),
                PolicyRule.of("exec", "git push *", PolicyEffect.DENY, 0, 2)));

        PolicyVerdict verdict = resolver.resolve(request("exec", "git push origin main"), layers,
                LayeredPolicyResolver.MODE_DEFAULT, PolicyLayer.BUILTIN);

        assertEquals(PolicyEffect.DENY, verdict.effect());
        assertTrue(verdict.matchedRule().contains("git push *"));
    }

    @Test
    void allowRequiresEveryResourceCovered() {
        var layers = List.of(layer(PolicyLayer.WORKSPACE,
                PolicyRule.of("write", "src/**", PolicyEffect.ALLOW)));

        PolicyVerdict covered = resolver.resolve(
                multiDomain(List.of("write"), List.of("src/a.ts", "src/b.ts")), layers,
                LayeredPolicyResolver.MODE_DEFAULT, PolicyLayer.BUILTIN);
        assertEquals(PolicyEffect.ALLOW, covered.effect());

        PolicyVerdict partial = resolver.resolve(
                multiDomain(List.of("write"), List.of("src/a.ts", "etc/passwd")), layers,
                LayeredPolicyResolver.MODE_DEFAULT, PolicyLayer.BUILTIN);
        assertEquals(PolicyEffect.ASK, partial.effect());
    }

    @Test
    void noMatchDefaultsToAsk() {
        var layers = List.of(layer(PolicyLayer.WORKSPACE,
                PolicyRule.of("read", "*", PolicyEffect.ALLOW)));

        PolicyVerdict verdict = resolver.resolve(request("exec", "ls"), layers,
                LayeredPolicyResolver.MODE_DEFAULT, PolicyLayer.BUILTIN);

        assertEquals(PolicyEffect.ASK, verdict.effect());
    }

    @Test
    void lockedInstanceRuleAlwaysParticipatesAndOnlyTightens() {
        var layers = List.of(
                layer(PolicyLayer.INSTANCE, new PolicyRule("exec", "*", PolicyEffect.DENY, 0, true, 1)),
                layer(PolicyLayer.WORKSPACE, PolicyRule.of("exec", "*", PolicyEffect.ALLOW, 99, 2)));

        PolicyVerdict verdict = resolver.resolve(request("exec", "pnpm test"), layers,
                LayeredPolicyResolver.MODE_DEFAULT, PolicyLayer.BUILTIN);

        assertEquals(PolicyEffect.DENY, verdict.effect());
    }

    @Test
    void lockedAllowIsRejectedAtConstruction() {
        assertThrows(IllegalArgumentException.class,
                () -> new PolicyRule("exec", "*", PolicyEffect.ALLOW, 0, true, 1));
    }

    @Test
    void multiDomainAnyDenyWins() {
        var layers = List.of(layer(PolicyLayer.WORKSPACE,
                PolicyRule.of("write", "*", PolicyEffect.ALLOW),
                PolicyRule.of("delete", "*", PolicyEffect.DENY)));

        PolicyVerdict verdict = resolver.resolve(
                multiDomain(List.of("write", "delete"), List.of("src/a.ts")), layers,
                LayeredPolicyResolver.MODE_DEFAULT, PolicyLayer.BUILTIN);

        assertEquals(PolicyEffect.DENY, verdict.effect());
    }

    @Test
    void bypassTurnsAskIntoAllowButNeverOverridesDeny() {
        var askLayers = List.of(layer(PolicyLayer.SESSION, PolicyRule.of("exec", "*", PolicyEffect.ASK)));
        PolicyVerdict allowed = resolver.resolve(request("exec", "pnpm test"), askLayers,
                LayeredPolicyResolver.MODE_BYPASS, PolicyLayer.SESSION);
        assertEquals(PolicyEffect.ALLOW, allowed.effect());
        assertEquals("bypass@SESSION", allowed.allowedBy());

        var denyLayers = List.of(layer(PolicyLayer.INSTANCE,
                new PolicyRule("exec", "rm -rf *", PolicyEffect.DENY, 0, true, 1)));
        PolicyVerdict denied = resolver.resolve(request("exec", "rm -rf /"), denyLayers,
                LayeredPolicyResolver.MODE_BYPASS, PolicyLayer.SESSION);
        assertEquals(PolicyEffect.DENY, denied.effect());
        assertEquals(null, denied.allowedBy());
    }

    @Test
    void managedConsidersInstanceRulesOnly() {
        var layers = List.of(
                layer(PolicyLayer.INSTANCE, PolicyRule.of("exec", "*", PolicyEffect.ASK)),
                layer(PolicyLayer.USER, PolicyRule.of("exec", "*", PolicyEffect.ALLOW)));

        PolicyVerdict verdict = resolver.resolve(request("exec", "pnpm test"), layers,
                LayeredPolicyResolver.MODE_MANAGED, PolicyLayer.INSTANCE);

        assertEquals(PolicyEffect.ASK, verdict.effect());
    }

    @Test
    void acceptEditsOnlyAutoAllowsWriteDomain() {
        var writeLayers = List.of(layer(PolicyLayer.SESSION, PolicyRule.of("write", "*", PolicyEffect.ASK)));
        assertEquals(PolicyEffect.ALLOW, resolver.resolve(multiDomain(List.of("write"), List.of("src/a.ts")),
                writeLayers, LayeredPolicyResolver.MODE_ACCEPT_EDITS, PolicyLayer.SESSION).effect());

        var execLayers = List.of(layer(PolicyLayer.SESSION, PolicyRule.of("exec", "*", PolicyEffect.ASK)));
        assertEquals(PolicyEffect.ASK, resolver.resolve(multiDomain(List.of("exec"), List.of("*")),
                execLayers, LayeredPolicyResolver.MODE_ACCEPT_EDITS, PolicyLayer.SESSION).effect());
    }

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
}
