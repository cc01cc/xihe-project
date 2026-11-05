package com.cc01cc.p.xihe.cp.policy;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashSet;
import java.util.Set;
import java.util.TreeSet;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0667 T0.4/T1.6: the agent-principal forbidden atom set is a <b>pinned contract</b>.
 *
 * <p>Why the expectation is <b>derived</b> instead of a hard-coded list: two plans are developing
 * this vocabulary in parallel (PLAN-0651 T2.1 grows the atom count 19&rarr;27 and the forbidden set
 * 13&rarr;21). A literal list would make whichever lane merges second fail for no product reason.
 * The rule is therefore restated from the atom metadata — something the implementation and the test
 * read through different doors:</p>
 * <ul>
 *   <li>every atom whose {@code scope_class} is {@code instance} (an instance-only atom must never be
 *       grantable to an agent principal);</li>
 *   <li>every capability atom (an agent is a grantee, never an administrator);</li>
 *   <li>the two workspace-administration atoms an agent may be managed <em>by</em>, never
 *       <em>with</em>.</li>
 * </ul>
 *
 * <p>Equality (not "contains") keeps both directions honest: dropping one forbidden atom, or
 * forgetting a newly invented instance-only/capability atom, turns red with a printed diff. The
 * three structural atoms are asserted separately so no refactor can quietly remove them.</p>
 */
class PermissionAtomCatalogAgentPrincipalForbiddenAtomsTest {

    /** Structural atoms: forgetting one of these is a security regression, not a vocabulary change. */
    private static final Set<String> STRUCTURAL = new TreeSet<>(Set.of(
            "MANAGE_AGENT_PRINCIPALS",
            "MANAGE_WORKSPACE_AGENTS",
            "MANAGE_WORKSPACE_MEMBERS"));

    @Test
    void forbiddenSetMatchesTheDerivedDefinition() {
        Set<String> derived = derivedForbiddenSet();
        Set<String> actual = new TreeSet<>(PermissionAtomCatalog.agentPrincipalForbiddenAtoms());

        Set<String> missing = new TreeSet<>(derived);
        missing.removeAll(actual);
        Set<String> unexpected = new TreeSet<>(actual);
        unexpected.removeAll(derived);

        assertEquals(derived, actual,
                "agent principal forbidden atoms drifted from their derivation "
                        + "(instance-only atoms + capability atoms + workspace-administration atoms). "
                        + "removed(derived has, code lost)=" + missing
                        + " added(code has, derivation lacks)=" + unexpected);
    }

    @Test
    void structuralAtomsAreAlwaysForbidden() {
        Set<String> forbidden = PermissionAtomCatalog.agentPrincipalForbiddenAtoms();
        assertTrue(forbidden.containsAll(STRUCTURAL),
                "these atoms must stay forbidden regardless of any vocabulary refactor: "
                        + STRUCTURAL + " missing=" + missingFrom(forbidden, STRUCTURAL));
    }

    @Test
    void everyCapabilityAndInstanceOnlyAtomIsForbidden() {
        Set<String> forbidden = PermissionAtomCatalog.agentPrincipalForbiddenAtoms();
        for (String capability : PermissionAtomCatalog.capabilityAtoms()) {
            assertTrue(forbidden.contains(capability),
                    "a capability atom must never be grantable to an agent principal: " + capability);
        }
        for (String instanceOnly : PermissionAtomCatalog.instanceOnlyAtoms()) {
            assertTrue(forbidden.contains(instanceOnly),
                    "an instance-only atom must never be grantable to an agent principal: " + instanceOnly);
        }
    }

    @Test
    void canBindToAgentPrincipalUsesThePinnedSet() {
        assertTrue(PermissionAtomCatalog.canBindToAgentPrincipal(Set.of("read", "write", "exec")));
        assertTrue(PermissionAtomCatalog.canBindToAgentPrincipal(new LinkedHashSet<>()));
        assertTrue(!PermissionAtomCatalog.canBindToAgentPrincipal(Set.of("read", "MANAGE_ROLES")));
        assertTrue(!PermissionAtomCatalog.canBindToAgentPrincipal(Set.of("workspace:admin")));
        assertEquals("MANAGE_WORKSPACE_AGENTS",
                PermissionAtomCatalog.firstForbiddenAgentPrincipalAtom(
                        new LinkedHashSet<>(java.util.List.of("read", "MANAGE_WORKSPACE_AGENTS", "MANAGE_ROLES"))));
    }

    /**
     * The rule re-derived from the per-atom metadata flag only (never from
     * {@code agentPrincipalForbiddenAtoms()}), so a change in the aggregate method is visible instead
     * of being compared with itself. Adding/removing an atom from the forbidden set is therefore a
     * one-line metadata edit whose effect this test sees automatically (Lead ruling 2026-11-05:
     * derive by flag, not by a hand-written predicate — the predicate is what went stale when the
     * set was narrowed 21&rarr;16).
     */
    private static Set<String> derivedForbiddenSet() {
        Set<String> derived = new TreeSet<>();
        for (String name : PermissionAtomCatalog.allAtomNames()) {
            if (PermissionAtomCatalog.atom(name).agentPrincipalForbidden()) {
                derived.add(name);
            }
        }
        return derived;
    }

    private static Set<String> missingFrom(Set<String> actual, Set<String> expected) {
        Set<String> missing = new TreeSet<>(expected);
        missing.removeAll(actual);
        return missing;
    }
}
