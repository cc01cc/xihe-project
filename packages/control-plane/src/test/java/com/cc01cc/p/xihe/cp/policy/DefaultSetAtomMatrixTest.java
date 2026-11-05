package com.cc01cc.p.xihe.cp.policy;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0651 T2.3: the default-grant matrix for the ten atoms this plan adds (N1–N10) across the
 * seven built-in roles, as a <b>hard-coded table</b>.
 *
 * <p>Why hard-coded: generating the expectation from {@code SystemAccessRoleCatalog} would compare
 * the catalog with itself (self-fulfilling). The table below is the reviewed contract (spec
 * {@code atom-contract.md} §3 "默认授予集"); the test asserts the code matches it cell by cell and
 * names the offending atom × role, so a wrong default points at the exact cell instead of
 * "matrix mismatch".</p>
 *
 * <p>The migration side of the parity check (DB {@code role_permissions} == this table) belongs to
 * T2.2's verifier: it must run on a <b>Flyway-only</b> database, because a booted context seeds the
 * rows from this very code catalog and would prove nothing.</p>
 */
class DefaultSetAtomMatrixTest {

    /** N1–N10 in the order the plan introduced them. */
    private static final List<String> PLAN_ATOMS = List.of(
            ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS,
            ToolFaceRegistry.ACTION_READ_INSTANCE_CONTENT,
            ToolFaceRegistry.ACTION_WRITE_INSTANCE_CONTENT,
            ToolFaceRegistry.ACTION_VIEW_SECRET_CONTENT,
            ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY,
            ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS,
            ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME,
            ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_RUNTIME,
            ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY,
            ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS);

    /**
     * The reviewed contract: role → the plan atoms it holds. Every role not listed here holds none.
     * equality. Read it as a table, not as a program.
     */
    private static final Map<String, Set<String>> EXPECTED = expected();

    private static Map<String, Set<String>> expected() {
        Map<String, Set<String>> table = new LinkedHashMap<>();
        table.put(SystemAccessRoleCatalog.SUPER_ADMIN, Set.copyOf(PLAN_ATOMS));
        table.put(SystemAccessRoleCatalog.ADMIN, Set.copyOf(PLAN_ATOMS));
        table.put(SystemAccessRoleCatalog.USER, Set.of());
        table.put(SystemAccessRoleCatalog.WS_OWNER, Set.of(
                ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY,
                ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS,
                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_RUNTIME,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY));
        table.put(SystemAccessRoleCatalog.WS_EDITOR, Set.of(
                ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS,
                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY));
        table.put(SystemAccessRoleCatalog.WS_VIEWER, Set.of(
                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME));
        table.put(SystemAccessRoleCatalog.AGENT_DELEGATOR, Set.of());
        return table;
    }

    /** The atoms a built-in role carries according to the code catalog. */
    private static Set<String> codeAtomsOf(String roleName) {
        Set<String> atoms = new LinkedHashSet<>();
        SystemAccessRoleCatalog.roleSeeds().stream()
                .filter(seed -> seed.name().equals(roleName))
                .findFirst()
                .orElseThrow(() -> new AssertionError("role seed missing: " + roleName))
                .atoms()
                .forEach(ref -> atoms.add(ref.actionClass()));
        return atoms;
    }

    @Test
    void everyCellOfTheTenBySevenMatrixMatchesTheContract() {
        assertEquals(7, EXPECTED.size(), "the table must cover all seven built-in roles");
        assertEquals(10, PLAN_ATOMS.size(), "N1–N10 must all be in the matrix");

        int checked = 0;
        for (Map.Entry<String, Set<String>> role : EXPECTED.entrySet()) {
            Set<String> held = codeAtomsOf(role.getKey());
            for (String atom : PLAN_ATOMS) {
                boolean expected = role.getValue().contains(atom);
                String cell = "atom=" + atom + " role=" + role.getKey();
                if (expected) {
                    assertTrue(held.contains(atom), "cell must hold but does not: " + cell);
                } else {
                    assertFalse(held.contains(atom), "cell must not hold but does: " + cell);
                }
                checked++;
            }
        }
        assertEquals(70, checked, "10 atoms × 7 roles = 70 cells; a shrunken table proves less");
    }

    @Test
    void nobodyGrantsTheMemberAtomToAWorkspaceRole() {
        // D51-26: N10 is deliberately instance-only in the default sets — a workspace role that
        // silently gained it would widen member administration, so it is pinned separately.
        assertFalse(codeAtomsOf(SystemAccessRoleCatalog.WS_OWNER)
                        .contains(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS),
                "WS_OWNER must not gain MANAGE_WORKSPACE_MEMBERS by default (D51-26)");
        assertFalse(codeAtomsOf(SystemAccessRoleCatalog.WS_EDITOR)
                        .contains(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS));
        assertFalse(codeAtomsOf(SystemAccessRoleCatalog.WS_VIEWER)
                        .contains(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS));
    }

    @Test
    void onlyTheInstanceAndManagementFacesAreForbiddenToAgentPrincipals() {
        // PLAN-0651 M2 (Lead ruling 2026-11-05): forbidden = instance-domain administration plus the
        // workspace management faces (16 atoms). N5–N9 are workspace capabilities the owner hands
        // out through roles, so an agent CAN hold them — forbidding them made every WS_EDITOR role
        // unbindable and would have forbidden an agent from running code.
        Set<String> forbiddenByRuling = Set.of(
                ToolFaceRegistry.ACTION_READ_INSTANCE_CONTENT,
                ToolFaceRegistry.ACTION_WRITE_INSTANCE_CONTENT,
                ToolFaceRegistry.ACTION_VIEW_SECRET_CONTENT,
                ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS);
        Set<String> bindableByRuling = Set.of(
                ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY,
                ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS,
                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_RUNTIME,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY);

        for (String atom : forbiddenByRuling) {
            assertFalse(PermissionAtomCatalog.canBindToAgentPrincipal(List.of(atom)),
                    "must be forbidden to agent principals: " + atom);
        }
        for (String atom : bindableByRuling) {
            assertTrue(PermissionAtomCatalog.canBindToAgentPrincipal(List.of(atom)),
                    "must be grantable to agent principals (workspace capability): " + atom);
        }
        // The aggregate is the single source of truth 0667 derives from.
        assertEquals(17, PermissionAtomCatalog.agentPrincipalForbiddenAtoms().size(),
                "Lead ruling 2026-11-05: exactly 17 forbidden atoms (GRANT_ANY_ATOM added by PLAN-0673 M2)");
    }
}
