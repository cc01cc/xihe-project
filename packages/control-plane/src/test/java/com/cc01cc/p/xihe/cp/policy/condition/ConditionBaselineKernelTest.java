package com.cc01cc.p.xihe.cp.policy.condition;

import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator.GrantAtom;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator.GrantExplanation;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator.PrincipalLevel;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-863 / spec/security/authorization.md §2.2: the two <b>MVP fail-closed</b> condition rules,
 * pinned at the evaluation kernel (no Spring, no database).
 *
 * <p>A: an unregistered condition key makes the carrying grant row inapplicable ⇒ DENY, with the
 * reason code and the level index. B: a registered condition whose field is absent from the
 * request context is not satisfied ⇒ DENY. C: swapping only the key to a registered one (and
 * supplying the field) flips the same request to ALLOW — without this, "unknown key denies" and
 * "everything denies" are indistinguishable. D: a satisfied condition does not change the two-axis
 * verdict, adds no matching axis, and never turns a deny into an allow.</p>
 */
class ConditionBaselineKernelTest {

    private static final String CONDITIONED_GRANT = "11111111-1111-4111-8111-111111111111";
    private static final String PLAIN_GRANT = "22222222-2222-4222-8222-222222222222";
    private static final String WORKSPACE_ID = "ws-863";
    private static final String SESSION_ID = "sess-863";

    private final GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();

    /** Case A: the key is not in ConditionKeys, so the row cannot hold the atom. */
    @Test
    void unregisteredConditionKeyDeniesTheCarryingRow() {
        GrantExplanation denied = evaluator.explain(
                request(WORKSPACE_ID),
                levels(atom("read", CONDITIONED_GRANT)),
                List.of(),
                gate(Map.of(CONDITIONED_GRANT, List.of(new Condition("trace_id")))));

        assertFalse(denied.allowed(), "unregistered key must deny, never be skipped");
        assertEquals(0, denied.deepestMissingLevel(), "the refusal is at level 0");
        assertEquals(GrantIntersectionEvaluator.REASON_CONDITION_KEY_UNREGISTERED,
                denied.missingAtom().reason(), "DENY must carry the condition code");
        assertEquals("condition-key-unregistered",
                GrantIntersectionEvaluator.REASON_CONDITION_KEY_UNREGISTERED,
                "code spelling is part of the explanation contract");
    }

    /** Case B: the key is registered but the request context lacks the field it reads. */
    @Test
    void registeredConditionWithMissingFieldIsNotSatisfied() {
        GrantExplanation denied = evaluator.explain(
                request(WORKSPACE_ID),
                levels(atom("read", CONDITIONED_GRANT)),
                List.of(),
                new ConditionGate(ConditionContext.EMPTY,
                        Map.of(CONDITIONED_GRANT, List.of(new Condition(ConditionKeys.WORKSPACE)))));

        assertFalse(denied.allowed(), "a missing context field means the narrowing fails");
        assertEquals(0, denied.deepestMissingLevel());
        assertEquals(GrantIntersectionEvaluator.REASON_CONDITION_FIELD_MISSING,
                denied.missingAtom().reason());
        assertEquals("condition-field-missing",
                GrantIntersectionEvaluator.REASON_CONDITION_FIELD_MISSING);
    }

    /**
     * Case C (counterproof): identical request, identical level, identical atom — only the
     * condition key changes from an unregistered one to a registered one whose field is present.
     */
    @Test
    void swappingTheUnknownKeyForARegisteredKeyFlipsDenyToAllow() {
        PolicyRequest request = request(WORKSPACE_ID);
        List<PrincipalLevel> levels = levels(atom("read", CONDITIONED_GRANT));

        GrantExplanation unknownKey = evaluator.explain(request, levels, List.of(),
                gate(Map.of(CONDITIONED_GRANT, List.of(new Condition("trace_id")))));
        GrantExplanation knownKey = evaluator.explain(request, levels, List.of(),
                gate(Map.of(CONDITIONED_GRANT, List.of(new Condition(ConditionKeys.WORKSPACE)))));

        assertFalse(unknownKey.allowed(), "unknown key ⇒ deny");
        assertTrue(knownKey.allowed(), "same request, registered key + present field ⇒ allow");
        assertNotEquals(unknownKey.allowed(), knownKey.allowed(),
                "if both denied, the test would not distinguish fail-closed from deny-all");
    }

    /** Case D: a satisfied condition changes nothing about the two-axis verdict. */
    @Test
    void satisfiedConditionDoesNotChangeTheTwoAxisVerdict() {
        PolicyRequest request = request(WORKSPACE_ID);
        List<PrincipalLevel> levels = levels(atom("read", CONDITIONED_GRANT));
        ConditionGate satisfied = gate(Map.of(CONDITIONED_GRANT,
                List.of(new Condition(ConditionKeys.WORKSPACE))));

        GrantExplanation withoutConditions = evaluator.explain(request, levels);
        GrantExplanation withConditions = evaluator.explain(request, levels, List.of(), satisfied);

        assertTrue(withoutConditions.allowed());
        assertEquals(withoutConditions.allowed(), withConditions.allowed(),
                "conditions narrow, they do not add an axis");
        assertEquals(withoutConditions.deepestMissingLevel(), withConditions.deepestMissingLevel());
        assertEquals(withoutConditions.matchedGrantRefs(), withConditions.matchedGrantRefs(),
                "a satisfied condition must not change which row authorized");
    }

    /** Case D (negative half): a satisfied condition can never turn a deny into an allow. */
    @Test
    void satisfiedConditionNeverWidensADeniedRequest() {
        PolicyRequest request = request(WORKSPACE_ID);
        // The level holds write only; the request is for read.
        List<PrincipalLevel> levels = levels(atom("write", CONDITIONED_GRANT));
        ConditionGate satisfied = gate(Map.of(CONDITIONED_GRANT,
                List.of(new Condition(ConditionKeys.WORKSPACE))));

        assertFalse(evaluator.explain(request, levels).allowed());
        assertFalse(evaluator.explain(request, levels, List.of(), satisfied).allowed(),
                "the gate only removes hits; it must never supply a missing atom");
    }

    /** Union semantics: a failing row does not subtract an atom another row grants unconditionally. */
    @Test
    void failingRowDoesNotOverrideAnotherRowGrantingTheSameAtom() {
        List<PrincipalLevel> levels = levels(
                atom("read", CONDITIONED_GRANT),
                atom("read", PLAIN_GRANT));
        ConditionGate gate = gate(Map.of(CONDITIONED_GRANT, List.of(new Condition("bogus_key"))));

        GrantExplanation explanation = evaluator.explain(
                request(WORKSPACE_ID), levels, List.of(), gate);

        assertTrue(explanation.allowed(), "the unconditioned row still holds the atom");
        assertEquals(1, explanation.matchedGrantRefs().size(), "only the plain row matched");
        assertEquals(PLAIN_GRANT, explanation.matchedGrantRefs().get(0).grantId());
    }

    /** The registry is closed: null/blank, a visibility concept and an atom name are all unregistered. */
    @Test
    void registryRejectsEverythingItDoesNotList() {
        assertTrue(ConditionKeys.isRegistered(ConditionKeys.WORKSPACE));
        assertTrue(ConditionKeys.isRegistered(ConditionKeys.SESSION));
        assertFalse(ConditionKeys.isRegistered(null));
        assertFalse(ConditionKeys.isRegistered(""));
        assertFalse(ConditionKeys.isRegistered(" workspace"));
        assertFalse(ConditionKeys.isRegistered("in_subtree"), "visibility is not a condition operator");
        assertFalse(ConditionKeys.isRegistered("org"), "the org tree stays in the visibility guard");
        assertFalse(ConditionKeys.isRegistered("workspace:admin"), "capability atom, not a context field");
        assertEquals(Set.of(ConditionKeys.WORKSPACE, ConditionKeys.SESSION), ConditionKeys.registered());
    }

    /** The inert gate is exactly the pre-task-863 behaviour. */
    @Test
    void inertGateIsIndistinguishableFromNoGate() {
        PolicyRequest request = request(null);
        List<PrincipalLevel> levels = levels(atom("read", CONDITIONED_GRANT));

        assertTrue(ConditionGate.none().isInert());
        assertEquals(evaluator.explain(request, levels).allowed(),
                evaluator.explain(request, levels, List.of(), ConditionGate.none()).allowed());
    }

    private static ConditionGate gate(Map<String, List<Condition>> byGrant) {
        return new ConditionGate(ConditionContext.of(WORKSPACE_ID, SESSION_ID), byGrant);
    }

    private static PolicyRequest request(String workspaceId) {
        return new PolicyRequest("tool-863", List.of("read"), List.of("*"), ToolShape.OPAQUE,
                "user-863", workspaceId, SESSION_ID);
    }

    private static List<PrincipalLevel> levels(GrantAtom... atoms) {
        return List.of(new PrincipalLevel("level-0", List.of(atoms)));
    }

    private static GrantAtom atom(String actionClass, String grantId) {
        // task-933: the origin column is provenance only; these kernel rows are unattributed.
        return new GrantAtom(actionClass, "*", grantId, GrantSources.ASSIGNED, null);
    }
}
