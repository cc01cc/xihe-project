package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0773 M1-9 / D-1118: the org-unit governance-role judgement, at <b>function level</b>.
 *
 * <p><b>Evidence level, stated up front</b> (this is the whole point of the card): these tests
 * exercise the predicate and its two call shapes. They are <b>not</b> integration evidence —
 * {@code org_units} / {@code org_unit_role_bindings} /
 * {@code PUT /api/v1/org-units/{unitId}/role-bindings} do not exist yet ({@code M1-1} / {@code M1-9}
 * DDL and {@code M2-8c} wiring are still open), so "the row did not change" and "a directly
 * inserted row is filtered" are simulated at the collection level. The real-insert verification
 * must be added by {@code M2-8c} on top of the real table; do not read these three arms as
 * integration proof.</p>
 *
 * <p>The three arms the card asks for:</p>
 * <ol>
 *   <li>a pure governance role is accepted;</li>
 *   <li>a role carrying a workspace-bindable atom is refused with {@code 409} and the offending
 *       atoms are named;</li>
 *   <li>the evaluation side drops an illegal binding that reached it without passing the write
 *       side — i.e. it does not merely trust the write side.</li>
 * </ol>
 */
class OrgUnitGovernancePolicyTest {

    private static final List<String> ORG_LEADER_ATOMS = List.of(
            OrgUnitGovernancePolicy.ATOM_MANAGE_ORG_UNITS,
            OrgUnitGovernancePolicy.ATOM_MANAGE_ORG_UNIT_MEMBERS,
            OrgUnitGovernancePolicy.ATOM_READ_ORG_UNIT_MEMBERS);

    /** Arm 1: the role the plan intends to seed ({@code M2-3} ORG_LEADER) passes. */
    @Test
    void pureGovernanceRoleIsAccepted() {
        assertTrue(OrgUnitGovernancePolicy.isGovernanceRole(ORG_LEADER_ATOMS));
        assertEquals(List.of(), OrgUnitGovernancePolicy.offendingAtoms(ORG_LEADER_ATOMS));
        OrgUnitGovernancePolicy.requireGovernanceRole(ORG_LEADER_ATOMS);
    }

    /** A subset is also a governance role: the whitelist is a superset test, not an equality. */
    @Test
    void subsetOfWhitelistIsAccepted() {
        assertTrue(OrgUnitGovernancePolicy.isGovernanceRole(
                List.of(OrgUnitGovernancePolicy.ATOM_READ_ORG_UNIT_MEMBERS)));
    }

    /**
     * Arm 2: one non-governance atom is enough to refuse, and the {@code 409} names it.
     *
     * <p>{@code EXEC} is a real catalog atom (scope class {@code both}), not a made-up string:
     * the point of the whitelist is that a workspace-executable atom can never travel into a
     * subtree, however it is spelled.</p>
     */
    @Test
    void roleWithNonGovernanceAtomIsRefusedWith409() {
        List<String> atoms = List.of(OrgUnitGovernancePolicy.ATOM_READ_ORG_UNIT_MEMBERS,
                ToolFaceRegistry.ACTION_EXEC);
        assertFalse(OrgUnitGovernancePolicy.isGovernanceRole(atoms));
        assertEquals(List.of(ToolFaceRegistry.ACTION_EXEC),
                OrgUnitGovernancePolicy.offendingAtoms(atoms));

        CpApiException refused = assertThrows(CpApiException.class,
                () -> OrgUnitGovernancePolicy.requireGovernanceRole(atoms));
        assertEquals(HttpStatus.CONFLICT, refused.getStatus());
        assertEquals(OrgUnitGovernancePolicy.CODE_FORBIDDEN, refused.getCode());
        assertTrue(refused.getMessage().contains(ToolFaceRegistry.ACTION_EXEC),
                "the refusal must name the offending atom, not just say no: "
                        + refused.getMessage());
    }

    /**
     * Arm 2 variant: a workspace write face from the catalog (scope class {@code both}) is
     * refused the same way — the judgement follows the atom, never the role name.
     */
    @Test
    void roleCarryingCatalogWorkspaceAtomIsRefused() {
        List<String> atoms = List.of(OrgUnitGovernancePolicy.ATOM_MANAGE_ORG_UNIT_MEMBERS,
                ToolFaceRegistry.ACTION_WRITE_WORKSPACE_CONTENT);
        assertFalse(OrgUnitGovernancePolicy.isGovernanceRole(atoms));
        assertThrows(CpApiException.class,
                () -> OrgUnitGovernancePolicy.requireGovernanceRole(atoms));
    }

    /** A binding that was never checked by the write side, as a direct insert would produce. */
    private record Binding(String role, List<String> atoms) {
    }

    /**
     * Arm 3: the evaluation side drops the illegal binding on its own.
     *
     * <p><b>This is a function-level simulation of a direct insert</b>: there is no table to write
     * to yet, so the "illegal row" is a collection element that the write-side gate never saw. The
     * real-insert arm belongs to {@code M2-8c}; keeping that sentence next to the assertion is
     * deliberate — an evidence level that is not written down gets read as a stronger one later.</p>
     */
    @Test
    void evaluationSideDropsIllegalBindingThatBypassedTheWriteSide() {
        List<Binding> rowsReachingTheEvaluator = new ArrayList<>();
        rowsReachingTheEvaluator.add(new Binding("ORG_LEADER", ORG_LEADER_ATOMS));
        // "inserted by hand": the role carries a workspace-executable atom, so the write side
        // would have answered 409 — but this row exists and the evaluator has to cope.
        rowsReachingTheEvaluator.add(new Binding("WS_EDITOR_SMELL",
                List.of(OrgUnitGovernancePolicy.ATOM_READ_ORG_UNIT_MEMBERS, ToolFaceRegistry.ACTION_EXEC)));

        List<Binding> effective = OrgUnitGovernancePolicy.filterGovernanceRoles(
                rowsReachingTheEvaluator, Binding::atoms);

        assertEquals(1, effective.size());
        assertEquals("ORG_LEADER", effective.get(0).role());
    }

    /**
     * An unresolved atom set is dropped on the evaluation side: evaluation fails closed, unlike
     * the vacuous {@code true} the pure predicate returns for an empty set.
     */
    @Test
    void evaluationSideDropsBindingWithUnresolvedAtoms() {
        List<Binding> rows = List.of(new Binding("UNKNOWN", null),
                new Binding("ORG_LEADER", ORG_LEADER_ATOMS));
        List<Binding> effective = OrgUnitGovernancePolicy.filterGovernanceRoles(rows, Binding::atoms);
        assertEquals(1, effective.size());
        assertEquals("ORG_LEADER", effective.get(0).role());
    }

    /**
     * Empty role: allowed, and pinned on purpose. It grants nothing, so nothing can leak; the
     * escalation risk (a later role-definition update filling it) belongs to the role-update path
     * and is recorded in the class javadoc under {@code M2-8c}. Pinned so nobody flips the
     * semantics silently.
     */
    @Test
    void emptyRoleIsGovernanceRoleVacuously() {
        assertTrue(OrgUnitGovernancePolicy.isGovernanceRole(List.of()));
        assertTrue(OrgUnitGovernancePolicy.isGovernanceRole(null));
    }

    /**
     * Forward-compatibility: the three governance atoms do not exist in
     * {@link PermissionAtomCatalog} yet ({@code M2-2} registers them). The moment they do, they
     * must be instance-scoped — otherwise the whitelist itself would be handing out a
     * workspace-bindable atom.
     *
     * <p><b>Today this assertion is vacuous</b> (no catalog hits) and that is stated here rather
     * than left for a reader to discover: a passing test that cannot fail yet is not evidence, it
     * is a tripwire armed for {@code M2-2}.</p>
     */
    @Test
    void governanceAtomsAreInstanceScopedOnceCatalogued() {
        int catalogHits = 0;
        for (String atom : OrgUnitGovernancePolicy.governanceAtoms()) {
            if (PermissionAtomCatalog.allAtomNames().contains(atom)) {
                catalogHits++;
                assertEquals(PermissionAtomCatalog.SCOPE_CLASS_INSTANCE,
                        PermissionAtomCatalog.scopeClassOf(atom),
                        atom + " is a governance atom and must stay instance-scoped");
            }
        }
        assertTrue(catalogHits <= 3);
    }

    /** The whitelist is exactly three atoms — the judgement has no hidden members. */
    @Test
    void whitelistHasExactlyThreeAtoms() {
        Collection<String> atoms = OrgUnitGovernancePolicy.governanceAtoms();
        assertEquals(3, atoms.size());
    }
}
