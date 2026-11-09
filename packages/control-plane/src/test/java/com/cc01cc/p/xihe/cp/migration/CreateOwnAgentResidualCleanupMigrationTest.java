package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * PLAN-0720 / BL-312 (option A): V146 removes only the inert
 * {@code source='agent_default'} grants carrying CREATE_OWN_AGENT.
 *
 * <p>Pre-state is built on a real upgrade path: migrate to V145, seed the residue plus control
 * rows, then apply V146. Covers: (1) 2-row residue is deleted and {@code source='role'} /
 * other-atom rows survive at the V146 boundary; (2) no-row databases are a no-op (fresh installs
 * and the 0-row branch of the guard); (3) a re-run of the cleanup statement deletes zero rows.
 * BL-312 (option B): V147 (2026-11-09) then removes the {@code source='role'} atom row in the
 * same upgrade chain, so the V146-scope assertion is taken at the V146 boundary and the head
 * state is asserted separately — the control row's deletion is V147's job, not V146's.</p>
 */
class CreateOwnAgentResidualCleanupMigrationTest {
    static TestDatabaseProvider.DatabaseRef postgres =
            TestDatabaseProvider.emptyDatabase("plan0720_cleanup");

    private static final String OWN_AGENT_ATOM = "[{\"actionClass\": \"CREATE_OWN_AGENT\"}]";

    @Test
    void v146RemovesOnlyAgentDefaultCreateOwnAgentRows() throws SQLException {
        String jdbcUrl = createDatabase("plan0720_residue");
        migrateToVersion(jdbcUrl, "145");
        try (Connection connection = connect(jdbcUrl)) {
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history "
                    + "WHERE version = '146'"), "V146 must not be applied before the upgrade");
            seedGrant(connection, "agent_default", OWN_AGENT_ATOM);
            seedGrant(connection, "agent_default", OWN_AGENT_ATOM);
            // Controls: same atom from a different source, and same source with another atom.
            seedGrant(connection, "role", OWN_AGENT_ATOM);
            seedGrant(connection, "agent_default", "[{\"actionClass\": \"MEMORY_WRITE\"}]");
        }

        migrateToVersion(jdbcUrl, "146");
        try (Connection connection = connect(jdbcUrl)) {
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history "
                    + "WHERE version = '146' AND success"), "V146 must be recorded as applied");
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM grants WHERE source = "
                    + "'agent_default' AND permissions @> '" + OWN_AGENT_ATOM + "'::jsonb"),
                    "all agent_default CREATE_OWN_AGENT rows must be deleted");
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM grants WHERE source = 'role' "
                    + "AND permissions @> '" + OWN_AGENT_ATOM + "'::jsonb"),
                    "source='role' rows must not be touched by V146 (asserted at the V146 boundary)");
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM grants WHERE source = "
                    + "'agent_default' AND permissions @> '[{\"actionClass\": \"MEMORY_WRITE\"}]'::jsonb"),
                    "agent_default rows for other atoms must not be touched");
        }

        // Head continues with V147 (BL-312 option B), which owns the source='role' removal.
        migrateToLatest(jdbcUrl);
        try (Connection connection = connect(jdbcUrl)) {
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM grants WHERE source = 'role' "
                    + "AND permissions @> '" + OWN_AGENT_ATOM + "'::jsonb"),
                    "V147 (BL-312 B) removes the source='role' row after the V146 boundary");
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM grants WHERE source = "
                    + "'agent_default' AND permissions @> '[{\"actionClass\": \"MEMORY_WRITE\"}]'::jsonb"),
                    "agent_default rows for other atoms stay untouched throughout the chain");
        }
    }

    @Test
    void v146IsANoOpWhenThereIsNoResidue() throws SQLException {
        String jdbcUrl = createDatabase("plan0720_clean");
        migrateToVersion(jdbcUrl, "145");
        migrateToLatest(jdbcUrl);

        try (Connection connection = connect(jdbcUrl)) {
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history "
                    + "WHERE version = '146' AND success"), "the 0-row branch must apply cleanly");
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM grants WHERE source = "
                    + "'agent_default' AND permissions @> '" + OWN_AGENT_ATOM + "'::jsonb"));
        }
    }

    @Test
    void cleanupStatementIsIdempotent() throws SQLException {
        String jdbcUrl = createDatabase("plan0720_idempotent");
        migrateToVersion(jdbcUrl, "145");
        try (Connection connection = connect(jdbcUrl)) {
            seedGrant(connection, "agent_default", OWN_AGENT_ATOM);
            seedGrant(connection, "agent_default", OWN_AGENT_ATOM);
        }
        migrateToLatest(jdbcUrl);

        try (Connection connection = connect(jdbcUrl)) {
            execute(connection, "DELETE FROM grants WHERE source = 'agent_default' "
                    + "AND permissions @> '" + OWN_AGENT_ATOM + "'::jsonb");
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM grants WHERE source = "
                    + "'agent_default' AND permissions @> '" + OWN_AGENT_ATOM + "'::jsonb"),
                    "a second cleanup must be a no-op (0 rows left)");
        }
    }

    private static void seedGrant(Connection connection, String source, String permissionsJson)
            throws SQLException {
        execute(connection, "INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, "
                + "permissions, source, scope_type, scope_id, read_state) VALUES "
                + "(gen_random_uuid(), 'user', gen_random_uuid(), 'user', gen_random_uuid(), '"
                + permissionsJson + "'::jsonb, '" + source + "', 'instance', NULL, 'read')");
    }

    private static String createDatabase(String databaseName) throws SQLException {
        String uniqueName = databaseName + "_" + UUID.randomUUID().toString().replace("-", "");
        try (Connection admin = connect(postgres.jdbcUrl());
             Statement statement = admin.createStatement()) {
            statement.executeUpdate("CREATE DATABASE " + uniqueName);
        }
        return postgres.jdbcUrl().replace("/" + postgres.databaseName(), "/" + uniqueName);
    }

    private static void migrateToVersion(String jdbcUrl, String version) {
        Flyway.configure()
                .dataSource(jdbcUrl, postgres.username(), postgres.password())
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion(version))
                .load()
                .migrate();
    }

    private static void migrateToLatest(String jdbcUrl) {
        Flyway.configure()
                .dataSource(jdbcUrl, postgres.username(), postgres.password())
                .locations("classpath:db/migration")
                .load()
                .migrate();
    }

    private static void execute(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.executeUpdate(sql);
        }
    }

    private static Connection connect(String jdbcUrl) throws SQLException {
        return DriverManager.getConnection(jdbcUrl, postgres.username(), postgres.password());
    }

    private static int scalarInt(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery(sql)) {
            result.next();
            return result.getInt(1);
        }
    }
}
