package com.cc01cc.p.xihe.cp.policy.condition;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator.GrantAtom;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator.GrantExplanation;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator.PrincipalLevel;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-867 / D-1922 第 3 条 (c): the condition gate is <b>reachable through the CP evaluation
 * entry</b> but <b>not wired</b> into it.
 *
 * <p>task-863 delivered the fail-closed kernel. Its only production call sites still go through
 * the two-argument overload, which passes {@link ConditionGate#none()}; no production code
 * constructs a {@link ConditionGate} with real conditions, because no condition storage exists.
 * This test is the integration-level counterpart of the kernel test: it builds the level from real
 * {@link AuthorizationGrant} rows (via {@link GrantIntersectionEvaluator#unionAttributed}) and
 * drives the same public {@code explain}/{@code allows} entry with a four-argument gate.</p>
 *
 * <p>Three assertions, and each one is required:</p>
 * <ol>
 *   <li>four-argument overload + unregistered key ⇒ DENY with code and level;</li>
 *   <li>the same request through the two-argument overload (what production uses) keeps the
 *       pre-task-863 verdict even while a failing gate exists in memory — this pins "the seam is
 *       reachable, it is just not connected", so wiring it later is a deliberate change instead of
 *       an accidental one;</li>
 *   <li>four-argument overload + registered key with the field present ⇒ ALLOW, proving the deny
 *       in (1) comes from "unregistered", not from a gate that rejects everything.</li>
 * </ol>
 */
class ConditionGateWiringTest {

    private static final UUID CONDITIONED_GRANT_ID = UUID.fromString("33333333-3333-4333-8333-333333333333");
    private static final String WORKSPACE_ID = "ws-867";
    private static final String SESSION_ID = "sess-867";

    private final GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();

    /** (1) A failing gate reaches the decision when the four-argument overload is used. */
    @Test
    void fourArgOverloadDeniesUnregisteredConditionKey() {
        PolicyRequest request = request();
        List<PrincipalLevel> levels = levels();
        ConditionGate gate = new ConditionGate(
                ConditionContext.of(WORKSPACE_ID, SESSION_ID),
                Map.of(CONDITIONED_GRANT_ID.toString(), List.of(new Condition("trace_id"))));

        GrantExplanation explanation = evaluator.explain(request, levels, List.of(), gate);

        assertFalse(explanation.allowed(), "unregistered condition key must deny through the entry");
        assertEquals(0, explanation.deepestMissingLevel(), "the denial is attributed to level 0");
        assertNotNull(explanation.missingAtom());
        assertEquals(GrantIntersectionEvaluator.REASON_CONDITION_KEY_UNREGISTERED,
                explanation.missingAtom().reason(), "the DENY must carry the condition code");
        assertEquals(ConditionBaseline.CODE_KEY_UNREGISTERED,
                explanation.missingAtom().reason(), "code spelling is part of the contract");
    }

    /**
     * (2) Production today goes through the two-argument overload. Even with a failing gate in
     * memory, that path returns the pre-task-863 verdict; this is the documented gap, not a
     * regression of the judgement.
     */
    @Test
    void productionTwoArgOverloadIsUnchangedByAnExistingFailingGate() {
        PolicyRequest request = request();
        List<PrincipalLevel> levels = levels();
        ConditionGate failingGate = new ConditionGate(
                ConditionContext.of(WORKSPACE_ID, SESSION_ID),
                Map.of(CONDITIONED_GRANT_ID.toString(), List.of(new Condition("trace_id"))));

        GrantExplanation production = evaluator.explain(request, levels);
        GrantExplanation inertFourArg = evaluator.explain(request, levels, List.of(), ConditionGate.none());
        GrantExplanation withFailingGate = evaluator.explain(request, levels, List.of(), failingGate);

        assertTrue(ConditionGate.none().isInert(), "the default gate is inert by construction");
        assertTrue(production.allowed(), "production path keeps the pre-task-863 verdict");
        assertEquals(inertFourArg.allowed(), production.allowed(),
                "an inert gate must be indistinguishable from the two-argument default");
        assertEquals(inertFourArg.deepestMissingLevel(), production.deepestMissingLevel());
        assertEquals(inertFourArg.missingAtom(), production.missingAtom());
        assertEquals(inertFourArg.matchedGrantRefs(), production.matchedGrantRefs(),
                "an inert gate must not change which row authorized");
        assertEquals(inertFourArg.evaluatedLevels(), production.evaluatedLevels());

        // Counterproof: the same gate would deny if it were wired. Without this, "production is
        // unchanged" would also hold for a gate that does nothing at all.
        assertFalse(withFailingGate.allowed(), "the gate itself is effective on the four-arg path");
        assertEquals(1, production.matchedGrantRefs().size());
        assertEquals(CONDITIONED_GRANT_ID.toString(), production.matchedGrantRefs().get(0).grantId());
    }

    /** (3) A registered key with its field present allows the same request. */
    @Test
    void fourArgOverloadAllowsRegisteredKeyWithPresentField() {
        PolicyRequest request = request();
        List<PrincipalLevel> levels = levels();
        ConditionGate gate = new ConditionGate(
                ConditionContext.of(WORKSPACE_ID, SESSION_ID),
                Map.of(CONDITIONED_GRANT_ID.toString(), List.of(new Condition(ConditionKeys.WORKSPACE))));

        GrantExplanation explanation = evaluator.explain(request, levels, List.of(), gate);

        assertTrue(explanation.allowed(),
                "registered key + present field must allow; the deny in (1) is about registration");
        assertEquals(-1, explanation.deepestMissingLevel());
        assertEquals(List.of(), explanation.missingLevels());
        assertEquals(1, explanation.matchedGrantRefs().size());
        assertEquals(CONDITIONED_GRANT_ID.toString(), explanation.matchedGrantRefs().get(0).grantId());
    }

    private static PolicyRequest request() {
        return new PolicyRequest("tool-867", List.of("read"), List.of("*"), ToolShape.OPAQUE,
                "user-867", WORKSPACE_ID, SESSION_ID);
    }

    /** Real grant rows, attributed exactly as the production read does. */
    private List<PrincipalLevel> levels() {
        List<GrantAtom> atoms = evaluator.unionAttributed(List.of(
                grant(CONDITIONED_GRANT_ID, "assigned", "read", "*")));
        return List.of(new PrincipalLevel("level-0", atoms));
    }

    private static AuthorizationGrant grant(UUID id, String source, String actionClass, String resource) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(id);
        grant.setSource(source);
        ObjectNode atom = JsonNodeFactory.instance.objectNode();
        atom.put("actionClass", actionClass);
        atom.put("resource", resource);
        ArrayNode permissions = JsonNodeFactory.instance.arrayNode();
        permissions.add(atom);
        grant.setPermissions(permissions);
        return grant;
    }
}
