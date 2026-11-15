package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.Test;

/**
 * D-1561 (task-194): the runtime evaluator ({@link LayeredPolicyResolver}) is the authorization
 * semantics SSOT. {@link ToolFaceRegistry#resourceCovers} runs on the write/derivation face
 * (template-to-principal derivation, role-editor precheck, credential binding) and used to answer
 * the exact-or-bare-{@code *} rule only, so a {@code <kind>:*} ceiling such as {@code skill:*} was
 * reported as "not covered" while the runtime evaluator allowed it (over-strict => false rejects).
 *
 * <p>This guard feeds the same (ceiling, candidate) matrix to both matchers and requires the same
 * verdict, so any future divergence fails here with the offending row printed. The credential
 * family is the one documented exception (its own stricter rule: wide {@code credential:*} or an
 * exact id, never a partial glob) and is pinned as such rather than folded into the shared matcher.
 */
class ResourceCoverageParityTest {

    private static final String ID = "11111111-1111-4111-8111-111111111111";
    private static final String OTHER = "22222222-2222-4222-8222-222222222222";

    /** Ceilings a grant or a template capability can carry, across families and shapes. */
    private static final List<String> CEILINGS = List.of(
            "*", "skill:" + ID, "skill:*", "workspace:" + ID, "workspace:*",
            "credential:" + ID, "credential:*", "notes/today.md", "src/*.ts", "src/**");

    /** Candidates a derivation or a request can carry. */
    private static final List<String> CANDIDATES = List.of(
            "skill:" + ID, "skill:" + OTHER, "workspace:" + ID,
            "credential:" + ID, "credential:" + OTHER, "notes/today.md",
            "src/a.ts", "src/nested/a.ts");

    private static final List<String> NON_CREDENTIAL_ACTIONS =
            List.of("read", "write", "skill_read", "exec");

    @Test
    void bothMatchersAgreeForEveryNonCredentialFamilyShape() {
        List<String> divergences = new ArrayList<>();
        for (String action : NON_CREDENTIAL_ACTIONS) {
            for (String ceiling : CEILINGS) {
                for (String candidate : CANDIDATES) {
                    boolean derivation = ToolFaceRegistry.resourceCovers(action, ceiling, candidate);
                    boolean runtime = LayeredPolicyResolver.matches(ceiling, candidate, ToolShape.STRUCTURED);
                    if (derivation != runtime) {
                        divergences.add("action=" + action + " ceiling=" + ceiling + " candidate=" + candidate
                                + " derivation=" + derivation + " runtime=" + runtime);
                    }
                }
            }
        }
        assertEquals(List.of(), divergences, "the derivation face and the runtime evaluator must agree (D-1561)");
    }

    @Test
    void aKindWildcardCeilingCoversAConcreteSchemeValue() {
        // The over-strict reading that motivated D-1561, now pinned as a positive.
        assertTrue(ToolFaceRegistry.resourceCovers("read", "skill:*", "skill:" + ID),
                "a skill:* ceiling must cover a concrete skill id on the derivation face too");
        assertTrue(ToolFaceRegistry.resourceCovers("skill_read", "skill:*", "skill:" + ID));
        // and it is not a blanket allow
        assertFalse(ToolFaceRegistry.resourceCovers("read", "skill:" + ID, "skill:" + OTHER),
                "an exact ceiling still covers only its own id");
    }

    @Test
    void theCredentialFamilyKeepsItsOwnStricterRule() {
        assertTrue(ToolFaceRegistry.resourceCovers("credential_use", "credential:*", "credential:" + ID));
        assertTrue(ToolFaceRegistry.resourceCovers("credential_use", "credential:" + ID, "credential:" + ID));
        assertFalse(ToolFaceRegistry.resourceCovers("credential_use", "credential:" + OTHER, "credential:" + ID),
                "an exact ceiling covers only its own id");
        // The wide ceiling covers the whole namespace (write-time canonicalisation is what keeps a
        // partial glob out of storage); a *partial glob ceiling* is where the two matchers really
        // diverge, and the credential family is deliberately the stricter one (D-1561 item 3).
        assertTrue(ToolFaceRegistry.resourceCovers("credential_use", "credential:*", "credential:ab*"),
                "the wide credential ceiling covers every credential-prefixed candidate");
        assertFalse(ToolFaceRegistry.resourceCovers("credential_use", "credential:ab*", "credential:abc"),
                "the credential namespace never admits a partial glob as a ceiling");
        assertTrue(LayeredPolicyResolver.matches("credential:ab*", "credential:abc", ToolShape.STRUCTURED),
                "pin: the shared matcher WOULD glob it — the credential family is deliberately stricter");
    }
}
