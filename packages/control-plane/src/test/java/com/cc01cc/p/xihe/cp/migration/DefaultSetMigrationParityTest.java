package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import com.cc01cc.p.xihe.cp.policy.OrgUnitGovernancePolicy;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.SystemGrantPresetCatalog;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0651 M2 T2.3: the <b>code catalog vs migration materialization</b> consistency check.
 *
 * <p>{@code DefaultSetAtomMatrixTest} pins the reviewed contract (hard-coded governed-atom matrix)
 * against the code catalog. This class covers the other half: a <b>fresh, Flyway-only</b> PostgreSQL
 * database (no booted Spring context, so nothing seeds from the code catalog) must materialize
 * exactly the same {@code grant_preset_atoms} rows as {@link SystemGrantPresetCatalog#presetSeeds()} —
 * every atom of every built-in role, including the newest rows from V125
 * ({@code SUPER_ADMIN × GRANT_ANY_ATOM}, {@code ADMIN × MANAGE_ROLES}) and the V127 role
 * {@code AGENT_USER} (D-174 agent default instance role).</p>
 *
 * <p><b>BL-326 (2026-11-05):</b> role-set assertions compare <b>by name</b> against the reviewed
 * {@code EXPECTED} table, never by a bare count — the literal {@code 7} silently broke the moment
 * V127 intentionally added an eighth default role.</p>
 *
 * <p>Why Flyway-only matters: a booted context calls {@code ensureSeeded()} and would copy the code
 * catalog into the DB, making the comparison self-fulfilling.</p>
 */
class DefaultSetMigrationParityTest {

    /** PLAN-eff/task-13 M1（A1）：空库由 JVM 单例容器下发；本类自行 Flyway 到 head。 */
    // empty-db-required: 本类断言要求 Flyway-only 库；快照克隆含启动期 seed（admin/SUPER_ADMIN/instance_owner）会污染 catalog 对比
    static TestDatabaseProvider.DatabaseRef postgres = TestDatabaseProvider.emptyDatabase("defaultsetpar");

    private static Connection connection;

    /** The eleven governance atoms (N1–N10 + GRANT_ANY_ATOM) plus MANAGE_ROLES (V125 widened ADMIN). */
    private static final List<String> GOVERNED_ATOMS = List.of(
            ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS,
            ToolFaceRegistry.ACTION_READ_INSTANCE_CONTENT,
            ToolFaceRegistry.ACTION_WRITE_INSTANCE_CONTENT,
            ToolFaceRegistry.ACTION_VIEW_SECRET_CONTENT,
            ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY,
            ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS,
            ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME,
            ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_RUNTIME,
            ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY,
            ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS,
            ToolFaceRegistry.ACTION_GRANT_ANY_ATOM,
            ToolFaceRegistry.ACTION_MANAGE_ROLES).stream()
            .map(com.cc01cc.p.xihe.cp.policy.AtomNames::action)
            .toList();

    /**
     * The reviewed default-grant contract for the governed atoms (2026-11-05, D-166/D-168 + D51-26):
     * role → atoms it holds. Kept hard-coded on purpose — deriving it from the catalog would compare
     * the catalog with itself. {@code MANAGE_ROLES} is the 12th column because V125 gave it to ADMIN.
     */
    private static final Map<String, Set<String>> EXPECTED = expected();

    private static Map<String, Set<String>> expected() {
        Set<String> all = Set.copyOf(GOVERNED_ATOMS);
        Map<String, Set<String>> table = new LinkedHashMap<>();
        table.put(SystemGrantPresetCatalog.SUPER_ADMIN, all);
        table.put(SystemGrantPresetCatalog.ADMIN, Set.copyOf(GOVERNED_ATOMS.stream()
                .filter(atom -> !com.cc01cc.p.xihe.cp.policy.AtomNames.action(
                        ToolFaceRegistry.ACTION_GRANT_ANY_ATOM).equals(atom))
                .toList()));
        table.put(SystemGrantPresetCatalog.USER, Set.of());
        table.put(SystemGrantPresetCatalog.WS_OWNER, canonical(Set.of(
                ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY,
                ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS,
                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_RUNTIME,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY)));
        table.put(SystemGrantPresetCatalog.WS_EDITOR, canonical(Set.of(
                ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS,
                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY)));
        table.put(SystemGrantPresetCatalog.WS_VIEWER, canonical(Set.of(
                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME)));
        table.put(SystemGrantPresetCatalog.AGENT_DELEGATOR, Set.of());
        // V127 / D-174: the agent default INSTANCE role (read/write/delete/exec/network, all `*`) —
        // none of the governed atoms, so every governance cell is false. (DSD-1500/V179 dropped exec
        // from its atoms; the governance cells were and stay false.)
        table.put(SystemGrantPresetCatalog.AGENT_USER, Set.of());
        // DSD-1500 (Q-93) R3 / V179: AGENT_READER mirrors WS_VIEWER (N7 only), AGENT_WORKER is
        // read/write/delete only, WS_RUNNER is exec + N7. Reviewed here because the parity test's
        // EXPECTED table is the hand-checked side that a new migration must match by name.
        table.put(SystemGrantPresetCatalog.AGENT_READER, canonical(Set.of(
                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME)));
        table.put(SystemGrantPresetCatalog.AGENT_WORKER, Set.of());
        table.put(SystemGrantPresetCatalog.WS_RUNNER, canonical(Set.of(
                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME)));
        // M2-3 (task-835/V162): the org-unit governance preset. None of the twelve governed atoms
        // is an org atom, so every governance cell is false; its own whitelist is asserted by
        // orgLeaderSeedsTheGovernanceWhitelist below.
        table.put(SystemGrantPresetCatalog.ORG_LEADER, Set.of());
        return table;
    }

    private static Set<String> canonical(Set<String> atoms) {
        return atoms.stream().map(com.cc01cc.p.xihe.cp.policy.AtomNames::action)
                .collect(java.util.stream.Collectors.toUnmodifiableSet());
    }

    @BeforeAll
    static void migrateToHead() throws SQLException {
        String url = postgres.jdbcUrl();
        Flyway.configure()
                .dataSource(url, postgres.username(), postgres.password())
                .locations("classpath:db/migration")
                .load()
                .migrate();
        connection = DriverManager.getConnection(url, postgres.username(), postgres.password());
    }

    /** role name → "actionClass|resourcePattern" set, read from the migrated {@code grant_preset_atoms}. */
    private static Map<String, Set<String>> dbAtoms() throws SQLException {
        Map<String, Set<String>> rows = new LinkedHashMap<>();
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT r.name, rp.action_class, rp.resource_pattern"
                        + " FROM grant_preset_atoms rp JOIN grant_presets r ON r.id = rp.role_id"
                        + " WHERE r.is_system = true")) {
            try (ResultSet result = statement.executeQuery()) {
                while (result.next()) {
                    rows.computeIfAbsent(result.getString(1), ignored -> new LinkedHashSet<>())
                            .add(result.getString(2) + "|" + result.getString(3));
                }
            }
        }
        return rows;
    }

    /** role name → "actionClass|resourcePattern" set, read from the code-side catalog. */
    private static Map<String, Set<String>> codeAtoms() {
        Map<String, Set<String>> rows = new LinkedHashMap<>();
        for (SystemGrantPresetCatalog.PresetSeed seed : SystemGrantPresetCatalog.presetSeeds()) {
            Set<String> atoms = new LinkedHashSet<>();
            seed.atoms().forEach(ref -> atoms.add(ref.actionClass() + "|" + ref.resourcePattern()));
            rows.put(seed.name(), atoms);
        }
        return rows;
    }

    private static Set<String> actionClasses(Set<String> atomPairs) {
        Set<String> atoms = new LinkedHashSet<>();
        for (String pair : atomPairs) {
            int separator = pair.indexOf('|');
            atoms.add(separator < 0 ? pair : pair.substring(0, separator));
        }
        return atoms;
    }

    @Test
    void freshDatabaseMaterializesExactlyTheCodeSideCatalog() throws SQLException {
        Map<String, Set<String>> code = codeAtoms();
        Map<String, Set<String>> db = dbAtoms();

        // BL-326 (2026-11-05): no bare role count. EXPECTED is the frozen, hand-reviewed side, so
        // comparing BY NAME keeps the freeze while surviving a migration that intentionally adds a
        // role (V127 added AGENT_USER; the literal `7` was the only thing that broke).
        assertEquals(EXPECTED.keySet(), code.keySet(),
                "the code catalog must hold exactly the reviewed built-in roles — review a new role "
                        + "into EXPECTED instead of raising a count");
        assertEquals(code.keySet(), db.keySet(), "migrated system roles must match the catalog role names");

        for (Map.Entry<String, Set<String>> role : code.entrySet()) {
            Set<String> expected = role.getValue();
            Set<String> actual = db.get(role.getKey());
            Set<String> missing = new LinkedHashSet<>(expected);
            missing.removeAll(actual);
            Set<String> extra = new LinkedHashSet<>(actual);
            extra.removeAll(expected);
            assertEquals(Set.of(), missing,
                    "role " + role.getKey() + " is missing atoms the code catalog seeds: " + missing);
            assertEquals(Set.of(), extra,
                    "role " + role.getKey() + " has atoms the code catalog does not seed: " + extra);
            assertEquals(expected, actual, "role " + role.getKey() + " atom sets must be equal");
        }
    }

    @Test
    void governedAtomMatrixMatchesTheContractOnAFreshDatabase() throws SQLException {
        Map<String, Set<String>> db = dbAtoms();
        assertEquals(db.keySet(), EXPECTED.keySet(),
                "the matrix must cover exactly the migrated built-in roles (BL-326: compare by name, "
                        + "never by a hard-coded count)");
        assertEquals(12, GOVERNED_ATOMS.size(),
                "N1–N10 + GRANT_ANY_ATOM (11 governance atoms) + MANAGE_ROLES (V125)");

        int checked = 0;
        for (Map.Entry<String, Set<String>> role : EXPECTED.entrySet()) {
            Set<String> held = actionClasses(db.get(role.getKey()));
            for (String atom : GOVERNED_ATOMS) {
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
        // Derived from the two lists (governed atoms × reviewed roles), never a literal count.
        assertEquals(GOVERNED_ATOMS.size() * EXPECTED.size(), checked,
                "every atom × role cell must be visited; a shrunken table proves less");
    }

    @Test
    void v125RowsLandInTheFreshDatabase() throws SQLException {
        // D-166: the bypass is SUPER_ADMIN-only; D-168: ADMIN gains MANAGE_ROLES but not the bypass.
        Map<String, Set<String>> db = dbAtoms();
        Set<String> superAdmin = db.get(SystemGrantPresetCatalog.SUPER_ADMIN);
        Set<String> admin = db.get(SystemGrantPresetCatalog.ADMIN);
        assertTrue(superAdmin.contains(
                        com.cc01cc.p.xihe.cp.policy.AtomNames.action(ToolFaceRegistry.ACTION_GRANT_ANY_ATOM) + "|*"),
                "SUPER_ADMIN must hold GRANT_ANY_ATOM after V125");
        assertFalse(admin.contains(
                        com.cc01cc.p.xihe.cp.policy.AtomNames.action(ToolFaceRegistry.ACTION_GRANT_ANY_ATOM) + "|*"),
                "ADMIN must never hold GRANT_ANY_ATOM (D-166)");
        assertTrue(admin.contains(
                        com.cc01cc.p.xihe.cp.policy.AtomNames.action(ToolFaceRegistry.ACTION_MANAGE_ROLES) + "|*"),
                "ADMIN must hold MANAGE_ROLES after V125 (D-168)");

        for (String workspaceRole : List.of(SystemGrantPresetCatalog.WS_OWNER,
                SystemGrantPresetCatalog.WS_EDITOR, SystemGrantPresetCatalog.WS_VIEWER)) {
            assertFalse(db.get(workspaceRole).contains(
                            com.cc01cc.p.xihe.cp.policy.AtomNames.action(ToolFaceRegistry.ACTION_GRANT_ANY_ATOM) + "|*"),
                    "workspace role must not hold the instance bypass: " + workspaceRole);
        }

        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '125' AND success")) {
            try (ResultSet result = statement.executeQuery()) {
                assertTrue(result.next());
                assertEquals(1, result.getInt(1), "V125 must be applied successfully on a fresh database");
            }
        }
    }

    @Test
    void superAdminHoldsEveryCatalogAtom() throws SQLException {
        // Cross-check the two counts so a future atom added to PermissionAtomCatalog but forgotten in
        // the SQL mirror fails here with an explicit message instead of a matrix diff.
        int catalogSize = PermissionAtomCatalog.actionAtoms().size()
                + PermissionAtomCatalog.capabilityAtoms().size();
        // task-870: the MCP ceiling is a second resource row per gateway action, not a new atom.
        int mcpCeilingRows = SystemGrantPresetCatalog.mcpCeilingAtoms().size();
        Map<String, Set<String>> db = dbAtoms();
        assertEquals(catalogSize + mcpCeilingRows, db.get(SystemGrantPresetCatalog.SUPER_ADMIN).size(),
                "SUPER_ADMIN must materialize every action atom, every capability atom, and the "
                        + "`mcp:*` ceiling rows");
    }

    @Test
    void mcpCeilingIsHumanAdministrationOnly() throws SQLException {
        // task-870 / D-1921: `mcp:*` is the gateway channel ceiling. Only the human administration
        // presets hold it; every agent preset must be granted per server explicitly.
        Map<String, Set<String>> db = dbAtoms();
        Set<String> fullCeiling = SystemGrantPresetCatalog.mcpCeilingAtoms().stream()
                .map(ref -> ref.actionClass() + "|" + ref.resourcePattern())
                .collect(java.util.stream.Collectors.toUnmodifiableSet());
        for (String role : List.of(SystemGrantPresetCatalog.SUPER_ADMIN,
                SystemGrantPresetCatalog.ADMIN)) {
            Set<String> missing = new LinkedHashSet<>(fullCeiling);
            missing.removeAll(db.get(role));
            assertEquals(Set.of(), missing, "role " + role + " must hold the full mcp ceiling");
        }
        // WS_OWNER holds no `network` atom, so its ceiling omits that row on both sides.
        Set<String> ownerCeiling = fullCeiling.stream()
                .filter(pair -> !pair.startsWith(
                        com.cc01cc.p.xihe.cp.policy.AtomNames.action(
                                ToolFaceRegistry.ACTION_NETWORK) + "|"))
                .collect(java.util.stream.Collectors.toUnmodifiableSet());
        assertEquals(ownerCeiling, db.get(SystemGrantPresetCatalog.WS_OWNER).stream()
                        .filter(pair -> pair.endsWith("|mcp:*"))
                        .collect(java.util.stream.Collectors.toUnmodifiableSet()),
                "WS_OWNER must hold exactly its own action set with mcp:*");
        for (String role : List.of(SystemGrantPresetCatalog.USER,
                SystemGrantPresetCatalog.WS_EDITOR,
                SystemGrantPresetCatalog.WS_VIEWER,
                SystemGrantPresetCatalog.AGENT_DELEGATOR,
                SystemGrantPresetCatalog.AGENT_USER,
                SystemGrantPresetCatalog.AGENT_READER,
                SystemGrantPresetCatalog.AGENT_WORKER,
                SystemGrantPresetCatalog.WS_RUNNER,
                SystemGrantPresetCatalog.ORG_LEADER)) {
            assertTrue(db.get(role).stream().noneMatch(pair -> pair.endsWith("|mcp:*")),
                    "role " + role + " must not hold an mcp:* wildcard (explicit per-server grants only)");
        }
    }

    @Test
    void orgLeaderSeedsTheGovernanceWhitelist() throws SQLException {
        // M2-3 (task-835): the preset exists and its atom set is exactly the D-1118 whitelist, so
        // OrgUnitGovernancePolicy accepts an org-unit binding of it. Derived on both sides, never a
        // literal count.
        Set<String> db = actionClasses(dbAtoms().get(SystemGrantPresetCatalog.ORG_LEADER));
        assertEquals(OrgUnitGovernancePolicy.governanceAtoms(), db,
                "ORG_LEADER must carry exactly the governance whitelist");
        assertTrue(OrgUnitGovernancePolicy.isGovernanceRole(db));
        assertTrue(codeAtoms().containsKey(SystemGrantPresetCatalog.ORG_LEADER),
                "the code catalog must seed ORG_LEADER too");
    }
}
