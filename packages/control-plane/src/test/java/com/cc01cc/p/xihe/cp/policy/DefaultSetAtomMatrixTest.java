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
 * built-in roles, as a <b>hard-coded table</b>.
 *
 * <p>Why hard-coded: generating the expectation from {@code SystemAccessRoleCatalog} would compare
 * the catalog with itself (self-fulfilling). The table below is the reviewed contract (spec
 * {@code atom-contract.md} §3 "默认授予集"); the test asserts the code matches it cell by cell and
 * names the offending atom × role, so a wrong default points at the exact cell instead of
 * "matrix mismatch".</p>
 *
 * <p><b>No bare role counts</b> (BL-326, 2026-11-05): the earlier version pinned
 * {@code assertEquals(7, EXPECTED.size())}, which went stale the moment V127 added a default role.
 * The role set is now compared <b>by name</b> against {@code SystemAccessRoleCatalog.roleSeeds()}, so
 * a new built-in role fails until it is reviewed into this table — the check bites, and it never
 * needs a magic number again.</p>
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
        // V127 / D-174: the agent default INSTANCE role — the base set (BL-312 removed the former
        // CREATE_OWN_AGENT differentiator), so none of N1–N10 (all cells false).
        table.put(SystemAccessRoleCatalog.AGENT_USER, Set.of());
        return table;
    }

    /** The built-in role names the code catalog declares — the single source the table must match. */
    private static Set<String> catalogRoleNames() {
        Set<String> names = new LinkedHashSet<>();
        SystemAccessRoleCatalog.roleSeeds().forEach(seed -> names.add(seed.name()));
        return names;
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
    void everyCellOfTheGovernedAtomMatrixMatchesTheContract() {
        assertEquals(catalogRoleNames(), EXPECTED.keySet(),
                "the matrix must cover exactly the built-in roles — review a new role into EXPECTED "
                        + "instead of raising a count (V127 added AGENT_USER this way)");
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
        // Derived from the two lists, never a literal: atoms × roles.
        assertEquals(PLAN_ATOMS.size() * EXPECTED.size(), checked,
                "every atom × role cell must be visited; a shrunken table proves less");
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
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS,
                // BL-345: the human ownership capability — an agent is a grantee, not an owner.
                ToolFaceRegistry.ACTION_MEMORY_WRITE_SELF,
                // PLAN-0750 M1 (G1): creating an agent principal is an account capability, same family.
                ToolFaceRegistry.ACTION_CREATE_OWN_AGENT,
                // PLAN-0691 T1.3: an agent may invoke a bound builtin plugin (PLUGIN_INVOKE, bindable)
                // but may not install one (PLUGIN_MANAGE), bind one (PLUGIN_BIND) or touch the plugin
                // data plane (PLUGIN_DATA) — the installed surface is instance administration.
                ToolFaceRegistry.ACTION_PLUGIN_MANAGE,
                ToolFaceRegistry.ACTION_PLUGIN_BIND,
                ToolFaceRegistry.ACTION_PLUGIN_DATA);
        Set<String> bindableByRuling = Set.of(
                ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY,
                ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS,
                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_RUNTIME,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY,
                // PLAN-0691 T1.3 / spec B-4: the one plugin atom an agent may hold.
                ToolFaceRegistry.ACTION_PLUGIN_INVOKE);

        for (String atom : forbiddenByRuling) {
            assertFalse(PermissionAtomCatalog.canBindToAgentPrincipal(List.of(atom)),
                    "must be forbidden to agent principals: " + atom);
        }
        for (String atom : bindableByRuling) {
            assertTrue(PermissionAtomCatalog.canBindToAgentPrincipal(List.of(atom)),
                    "must be grantable to agent principals (workspace capability): " + atom);
        }
        // The aggregate is the single source of truth 0667 derives from.
        assertEquals(22, PermissionAtomCatalog.agentPrincipalForbiddenAtoms().size(),
                "17 up to BL-345 (2026-11-06; BL-312 removed CREATE_OWN_AGENT from the 18)"
                        + " + PLUGIN_MANAGE/PLUGIN_BIND/PLUGIN_DATA (PLAN-0691 T1.3, 2026-11-08)"
                        + " = 20, + the PLAN-0750 M1 (G1) own-agent atom = 21; PLUGIN_INVOKE stays"
                        + " bindable");
    }
}
