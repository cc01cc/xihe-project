package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
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
 * exactly the same {@code role_permissions} rows as {@link SystemAccessRoleCatalog#roleSeeds()} —
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
            ToolFaceRegistry.ACTION_MANAGE_ROLES);

    /**
     * The reviewed default-grant contract for the governed atoms (2026-11-05, D-166/D-168 + D51-26):
     * role → atoms it holds. Kept hard-coded on purpose — deriving it from the catalog would compare
     * the catalog with itself. {@code MANAGE_ROLES} is the 12th column because V125 gave it to ADMIN.
     */
    private static final Map<String, Set<String>> EXPECTED = expected();

    private static Map<String, Set<String>> expected() {
        Set<String> all = Set.copyOf(GOVERNED_ATOMS);
        Map<String, Set<String>> table = new LinkedHashMap<>();
        table.put(SystemAccessRoleCatalog.SUPER_ADMIN, all);
        table.put(SystemAccessRoleCatalog.ADMIN, Set.copyOf(GOVERNED_ATOMS.stream()
                .filter(atom -> !ToolFaceRegistry.ACTION_GRANT_ANY_ATOM.equals(atom))
                .toList()));
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
        // V127 / D-174: the agent default INSTANCE role (read/write/delete/exec/network, all `*`) —
        // none of the governed atoms, so every governance cell is false.
        table.put(SystemAccessRoleCatalog.AGENT_USER, Set.of());
        return table;
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

    /** role name → "actionClass|resourcePattern" set, read from the migrated {@code role_permissions}. */
    private static Map<String, Set<String>> dbAtoms() throws SQLException {
        Map<String, Set<String>> rows = new LinkedHashMap<>();
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT r.name, rp.action_class, rp.resource_pattern"
                        + " FROM role_permissions rp JOIN roles r ON r.id = rp.role_id"
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
        for (SystemAccessRoleCatalog.RoleSeed seed : SystemAccessRoleCatalog.roleSeeds()) {
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
        Set<String> superAdmin = db.get(SystemAccessRoleCatalog.SUPER_ADMIN);
        Set<String> admin = db.get(SystemAccessRoleCatalog.ADMIN);
        assertTrue(superAdmin.contains(ToolFaceRegistry.ACTION_GRANT_ANY_ATOM + "|*"),
                "SUPER_ADMIN must hold GRANT_ANY_ATOM after V125");
        assertFalse(admin.contains(ToolFaceRegistry.ACTION_GRANT_ANY_ATOM + "|*"),
                "ADMIN must never hold GRANT_ANY_ATOM (D-166)");
        assertTrue(admin.contains(ToolFaceRegistry.ACTION_MANAGE_ROLES + "|*"),
                "ADMIN must hold MANAGE_ROLES after V125 (D-168)");

        for (String workspaceRole : List.of(SystemAccessRoleCatalog.WS_OWNER,
                SystemAccessRoleCatalog.WS_EDITOR, SystemAccessRoleCatalog.WS_VIEWER)) {
            assertFalse(db.get(workspaceRole).contains(ToolFaceRegistry.ACTION_GRANT_ANY_ATOM + "|*"),
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
        Map<String, Set<String>> db = dbAtoms();
        assertEquals(catalogSize, db.get(SystemAccessRoleCatalog.SUPER_ADMIN).size(),
                "SUPER_ADMIN must materialize every action atom plus every capability atom");
    }
}
