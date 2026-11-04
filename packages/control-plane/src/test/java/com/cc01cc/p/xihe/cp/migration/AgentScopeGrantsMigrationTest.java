package com.cc01cc.p.xihe.cp.migration;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0629 (user ruling 2026-11-04): an agent principal's permission is a <b>role binding</b>,
 * exactly like a human account's — permissions live in the config surface (roles /
 * role_permissions, V87) and every subject only gets bindings.
 *
 * <p>V108 is the data half of that ruling, asserted here against a real PostgreSQL:</p>
 * <ul>
 *   <li><b>mapping</b> — an existing {@code workspace_agents} binding becomes a workspace-scoped
 *       {@code role_bindings} row with the smallest seeded role that covers its frozen snapshot
 *       (this fixture: read/write/exec ⇒ {@code WS_EDITOR});</li>
 *   <li><b>uncovered atoms</b> — a snapshot carrying an atom no seeded role covers gets the
 *       {@code agent-default} role instead of silently losing permission;</li>
 *   <li><b>materialization</b> — the binding is expanded into {@code source='role'} grants with the
 *       binding scope, i.e. the same rows {@code RoleGrantMaterializer} writes at runtime;</li>
 *   <li><b>idempotency</b> — re-executing the migration SQL changes no row count;</li>
 *   <li><b>two states</b> — a principal with a binding is reachable through the read path's query, a
 *       principal without one is not.</li>
 * </ul>
 */
@Testcontainers
class AgentScopeGrantsMigrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_v108")
            .withUsername("test")
            .withPassword("test");

    private static final String MIGRATION =
            "db/migration/V108__agent_principal_role_bindings_backfill.sql";

    private static final UUID USER_ID = UUID.randomUUID();
    private static final UUID WORKSPACE_ID = UUID.randomUUID();
    /** Snapshot covered by WS_EDITOR (read/write/exec). */
    private static final UUID EDITOR_PRINCIPAL_ID = UUID.randomUUID();
    /** Snapshot with an atom no seeded workspace role carries ⇒ agent-default. */
    private static final UUID SPAWN_PRINCIPAL_ID = UUID.randomUUID();
    /** No binding at all: the "no role ⇒ not reachable" state. */
    private static final UUID UNBOUND_PRINCIPAL_ID = UUID.randomUUID();

    private static Connection connection;

    @BeforeAll
    static void migrateToJustBeforeV108ThenSeedFixtures() throws SQLException, IOException {
        String url = postgres.getJdbcUrl();
        // Stop at V106 so the fixtures exist before the backfill runs — the real upgrade path.
        Flyway.configure()
                .dataSource(url, postgres.getUsername(), postgres.getPassword())
                .target(MigrationVersion.fromVersion("106"))
                .load()
                .migrate();
        connection = DriverManager.getConnection(url, postgres.getUsername(), postgres.getPassword());
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + USER_ID
                + "', 'plan0629-scope@test.local', 'x', 'plan0629scope')");
        execute("INSERT INTO workspaces (id, name) VALUES ('" + WORKSPACE_ID + "', 'v108-scope-ws')");
        for (UUID principalId : List.of(EDITOR_PRINCIPAL_ID, SPAWN_PRINCIPAL_ID, UNBOUND_PRINCIPAL_ID)) {
            execute("INSERT INTO agent_principals (id, name, created_by_user_id) VALUES ('" + principalId
                    + "', 'v108 principal " + principalId + "', '" + USER_ID + "')");
        }
        execute("INSERT INTO workspace_agents (principal_id, workspace_id, permissions_snapshot) VALUES ('"
                + EDITOR_PRINCIPAL_ID + "', '" + WORKSPACE_ID + "', "
                + "'[{\"actionClass\":\"read\",\"resource\":\"*\"},"
                + "{\"actionClass\":\"write\",\"resource\":\"*\"},"
                + "{\"actionClass\":\"exec\",\"resource\":\"*\"}]'::jsonb)");
        execute("INSERT INTO workspace_agents (principal_id, workspace_id, permissions_snapshot) VALUES ('"
                + SPAWN_PRINCIPAL_ID + "', '" + WORKSPACE_ID + "', "
                + "'[{\"actionClass\":\"read\",\"resource\":\"*\"},"
                + "{\"actionClass\":\"SPAWN_AGENT\",\"resource\":\"*\"}]'::jsonb)");
        // The upgrade itself.
        Flyway.configure().dataSource(url, postgres.getUsername(), postgres.getPassword()).load().migrate();
        // PLAN-0651 M2 T2.1 widened the seeded role sets AFTER V108 ran during the upgrade. The
        // backfill is deliberately re-runnable, so settle it once here; both tests then measure the
        // same state regardless of JUnit's method order (a test that re-runs the migration mutates
        // the database for the others).
        execute(migrationSql());
    }

    @Test
    void mapsEachBindingToTheSmallestCoveringSeededRole() throws SQLException {
        assertEquals("WS_EDITOR", scalarString("SELECT r.name FROM role_bindings rb "
                + "JOIN roles r ON r.id = rb.role_id WHERE rb.subject_type = 'agent_principal' "
                + "AND rb.subject_id = '" + EDITOR_PRINCIPAL_ID + "'"));
        assertEquals(1, scalarInt("SELECT count(*) FROM role_bindings WHERE subject_type = "
                + "'agent_principal' AND subject_id = '" + EDITOR_PRINCIPAL_ID + "' "
                + "AND scope_type = 'workspace' AND scope_id = '" + WORKSPACE_ID + "'"));
    }

    @Test
    void uncoveredAtomsFallThroughToTheAgentDefaultRole() throws SQLException {
        assertEquals("AGENT_DEFAULT", scalarString("SELECT r.name FROM role_bindings rb "
                + "JOIN roles r ON r.id = rb.role_id WHERE rb.subject_type = 'agent_principal' "
                + "AND rb.subject_id = '" + SPAWN_PRINCIPAL_ID + "'"));
        // The uncovered atom is the reason the role exists — it must not be dropped silently.
        assertEquals(1, scalarInt("SELECT count(*) FROM role_permissions rp JOIN roles r "
                + "ON r.id = rp.role_id WHERE r.name = 'AGENT_DEFAULT' "
                + "AND lower(rp.action_class) = 'spawn_agent'"));
    }

    @Test
    void materializesRoleGrantsWithTheBindingScope() throws SQLException {
        // V108 ran during the upgrade from V106; later migrations (0651 M2 T2.1) widened the seeded
        // role sets, and the backfill is deliberately re-runnable, so the settled state is measured.
        // Expected rows are derived from the CURRENT role_permissions rows, not a literal: WS_EDITOR
        // moved 4→7 (N6/N7/N9), AGENT_DEFAULT keeps its single SPAWN_AGENT row.
        int editorAtoms = roleAtomCount("WS_EDITOR");
        assertEquals(editorAtoms, scalarInt("SELECT count(*) FROM grants WHERE subject_type = 'agent_principal' "
                + "AND subject_id = '" + EDITOR_PRINCIPAL_ID + "' AND source = 'role' "
                + "AND scope_type = 'workspace' AND scope_id = '" + WORKSPACE_ID + "'"));
        // One atom per row, and the unique atom key really is one row per atom.
        assertEquals(editorAtoms, scalarInt("SELECT count(DISTINCT permissions -> 0 ->> 'actionClass') "
                + "FROM grants WHERE subject_type = 'agent_principal' AND subject_id = '"
                + EDITOR_PRINCIPAL_ID + "' AND source = 'role'"));
    }

    @Test
    void reRunningTheMigrationLeavesTheSameRows() throws IOException, SQLException {
        // The backfill is re-runnable in the sense that a second execution changes nothing. The
        // first execution after later migrations is expected to heal the atoms those migrations
        // added (before: 5 grants for the two bound roles; after: one row per current role atom).
        try (Statement statement = connection.createStatement()) {
            statement.execute(migrationSql());
        }
        String settled = roleBindingAndGrantCounts();
        try (Statement statement = connection.createStatement()) {
            statement.execute(migrationSql());
        }
        assertEquals(settled, roleBindingAndGrantCounts(),
                "V108 must be re-runnable: NOT EXISTS guards bindings, uq_grants_role_atom guards atoms");
    }

    private static String migrationSql() throws IOException {
        try (InputStream stream = Thread.currentThread().getContextClassLoader()
                .getResourceAsStream(MIGRATION)) {
            assertTrue(stream != null, "migration resource not on the classpath: " + MIGRATION);
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static int roleAtomCount(String roleName) throws SQLException {
        return scalarInt("SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id "
                + "WHERE r.name = '" + roleName + "'");
    }

    @Test
    void roleBindingIsWhatDecidesReachability() throws SQLException {
        // The read path's question, verbatim: which principals hold a workspace role binding here?
        List<String> reachable = queryStrings("SELECT DISTINCT subject_id::text FROM role_bindings "
                + "WHERE subject_type = 'agent_principal' AND scope_type = 'workspace' "
                + "AND scope_id = '" + WORKSPACE_ID + "'");
        assertTrue(reachable.contains(EDITOR_PRINCIPAL_ID.toString()),
                "role binding ⇒ visible and usable in this workspace: " + reachable);
        assertTrue(!reachable.contains(UNBOUND_PRINCIPAL_ID.toString()),
                "no role binding ⇒ not visible and not usable: " + reachable);
        // And the atoms it authorized are on the evaluation path (`source='role'`).
        List<String> evaluationSources = queryStrings("SELECT DISTINCT source FROM grants "
                + "WHERE subject_type = 'agent_principal' AND subject_id = '"
                + EDITOR_PRINCIPAL_ID + "'");
        assertEquals(List.of("role"), evaluationSources);
    }

    private static String roleBindingAndGrantCounts() throws SQLException {
        return scalarInt("SELECT count(*) FROM role_bindings WHERE subject_type = 'agent_principal'")
                + "/" + scalarInt("SELECT count(*) FROM grants WHERE subject_type = "
                + "'agent_principal' AND source = 'role'");
    }

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private static int scalarInt(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             var resultSet = statement.executeQuery(sql)) {
            resultSet.next();
            return resultSet.getInt(1);
        }
    }

    private static String scalarString(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             var resultSet = statement.executeQuery(sql)) {
            resultSet.next();
            return resultSet.getString(1);
        }
    }

    private static List<String> queryStrings(String sql) throws SQLException {
        List<String> values = new java.util.ArrayList<>();
        try (Statement statement = connection.createStatement();
             var resultSet = statement.executeQuery(sql)) {
            while (resultSet.next()) {
                values.add(resultSet.getString(1));
            }
        }
        return values;
    }
}
