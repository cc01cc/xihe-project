package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.FlywayException;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-173 (user ruling 40C / D-1532 ⑤; Lead ruling D-1540): V170 adds
 * {@code agent_principals.ownership} and refuses to guess for legacy rows.
 *
 * <p>Three readings, each on its own disposable PostgreSQL database (the migration itself is the
 * subject, so no Spring context is involved):</p>
 * <ol>
 *   <li><b>refuse</b> — a database that still holds an undeterminable (origin=USER) principal must
 *       fail the upgrade with the row count and the cleanup command, and must leave nothing behind
 *       (PostgreSQL runs DDL transactionally, so a failed V170 is not half-applied);</li>
 *   <li><b>empty database</b> — the whole chain applies, V170 recorded, the column is NOT NULL;</li>
 *   <li><b>determinable legacy row</b> — a builtin preset principal (origin=SYSTEM_PRESET) is
 *       instance-owned by definition, so V170 backfills it to INSTANCE, and the cross-axis CHECK then
 *       makes the contradictory state impossible to insert afterwards.</li>
 * </ol>
 *
 * <p>What this class cannot show: that the <b>write side</b> stamps the right value. A migration only
 * proves the schema can be built; the instance-door create is proven over real HTTP by
 * {@code AgentPrincipalOwnershipIntegrationTest} (D-1540 ③).</p>
 */
class AgentPrincipalOwnershipMigrationTest {

    static TestDatabaseProvider.DatabaseRef postgres =
            TestDatabaseProvider.emptyDatabase("agent_own_migr");

    @Test
    void aDatabaseWithAnUndeterminableLegacyPrincipalRefusesToMigrateAndNamesTheCleanup()
            throws SQLException {
        String jdbcUrl = createDatabase("xihe_cp_own_refuse_db");
        migrateToVersion(jdbcUrl, "169");
        UUID userId = UUID.randomUUID();
        UUID userOriginPrincipal = UUID.randomUUID();
        UUID presetPrincipal = UUID.randomUUID();
        try (Connection connection = connect(jdbcUrl)) {
            execute(connection, "INSERT INTO users (id, email, password_hash, username) VALUES ('"
                    + userId + "'::uuid, 'legacy-own-" + userId + "@test.local', 'hash', 'legacyown"
                    + userId.toString().replace("-", "").substring(0, 8) + "')");
            execute(connection, principalInsert(userOriginPrincipal, "LegacyUserOrigin", userId,
                    "USER", null));
            execute(connection, principalInsert(presetPrincipal, "LegacyPreset", userId,
                    "SYSTEM_PRESET", "fixture-preset"));
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history"
                    + " WHERE version = '170'"), "V170 must not be applied before the upgrade");
            assertEquals(2, scalarInt(connection, "SELECT count(*) FROM agent_principals"));
        }

        FlywayException failure = assertThrows(FlywayException.class, () -> migrateToLatest(jdbcUrl));
        String message = failure.getMessage() + " " + deepestMessage(failure);
        assertTrue(message.contains("V170 cannot determine ownership for 1 legacy AI principal row(s)"),
                "the refusal must name the exact undeterminable count, got: " + message);
        assertTrue(message.contains("mise run dev:reset --apply"),
                "the refusal must carry a runnable cleanup command, got: " + message);
        assertTrue(message.contains("origin='USER'"),
                "the message must say WHY the rows are ambiguous, got: " + message);

        try (Connection connection = connect(jdbcUrl)) {
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history"
                    + " WHERE version = '170'"), "a refused migration is not recorded");
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM information_schema.columns"
                    + " WHERE table_name = 'agent_principals' AND column_name = 'ownership'"),
                    "PostgreSQL DDL is transactional: the failed V170 must leave no half-added column");
            assertEquals(2, scalarInt(connection, "SELECT count(*) FROM agent_principals"),
                    "the refusal must not delete the operator data it refuses to classify");
        }
    }

    @Test
    void anEmptyDatabaseAppliesTheWholeChainIncludingV170() throws SQLException {
        String jdbcUrl = createDatabase("xihe_cp_own_empty_db");
        migrateToLatest(jdbcUrl);
        try (Connection connection = connect(jdbcUrl)) {
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history"
                    + " WHERE version = '170' AND success"), "V170 must be recorded as applied");
            assertEquals("NO", scalarString(connection, "SELECT is_nullable"
                    + " FROM information_schema.columns WHERE table_name = 'agent_principals'"
                    + " AND column_name = 'ownership'"), "the column must be NOT NULL");
            assertEquals("character varying", scalarString(connection, "SELECT data_type"
                    + " FROM information_schema.columns WHERE table_name = 'agent_principals'"
                    + " AND column_name = 'ownership'"));
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM agent_principals"),
                    "V170 must not invent principals");
        }
    }

    @Test
    void aDeterminablePresetRowBecomesInstanceOwnedAndTheCrossAxisCheckHolds() throws SQLException {
        String jdbcUrl = createDatabase("xihe_cp_own_preset_db");
        migrateToVersion(jdbcUrl, "169");
        UUID userId = UUID.randomUUID();
        UUID presetPrincipal = UUID.randomUUID();
        try (Connection connection = connect(jdbcUrl)) {
            execute(connection, "INSERT INTO users (id, email, password_hash, username) VALUES ('"
                    + userId + "'::uuid, 'legacy-preset-" + userId + "@test.local', 'hash', 'legacypre"
                    + userId.toString().replace("-", "").substring(0, 8) + "')");
            execute(connection, principalInsert(presetPrincipal, "LegacyPreset", userId,
                    "SYSTEM_PRESET", "fixture-preset"));
        }

        migrateToLatest(jdbcUrl);

        try (Connection connection = connect(jdbcUrl)) {
            assertEquals("INSTANCE", scalarString(connection, "SELECT ownership FROM agent_principals"
                    + " WHERE id = '" + presetPrincipal + "'::uuid"),
                    "a builtin preset principal is an instance asset by definition");
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM agent_principals"
                    + " WHERE ownership IS NULL"), "no row may stay unclassified after V170");
            // The cross-axis CHECK: a USER-owned preset is a contradiction, not a preference.
            SQLException contradiction = assertThrows(SQLException.class, () -> execute(connection,
                    "UPDATE agent_principals SET ownership = 'USER' WHERE id = '"
                            + presetPrincipal + "'::uuid"));
            assertTrue(String.valueOf(contradiction.getMessage()).contains("ck_agent_principals_ownership_preset"),
                    "the CHECK must be the thing that refuses, got: " + contradiction.getMessage());
        }
    }

    // --- helpers ---------------------------------------------------------------------------

    private static String principalInsert(UUID id, String name, UUID createdBy, String origin,
                                          String presetId) {
        return "INSERT INTO agent_principals (id, name, created_by_user_id, origin, preset_id)"
                + " VALUES ('" + id + "'::uuid, '" + name + "', '" + createdBy + "'::uuid, '"
                + origin + "', " + (presetId == null ? "NULL" : "'" + presetId + "'") + ")";
    }

    private static String deepestMessage(Throwable throwable) {
        Throwable current = throwable;
        while (current.getCause() != null) {
            current = current.getCause();
        }
        return String.valueOf(current.getMessage());
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

    private static Connection connect(String jdbcUrl) throws SQLException {
        return DriverManager.getConnection(jdbcUrl, postgres.username(), postgres.password());
    }

    private static void execute(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.executeUpdate(sql);
        }
    }

    private static int scalarInt(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            rs.next();
            return rs.getInt(1);
        }
    }

    private static String scalarString(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            rs.next();
            return rs.getString(1);
        }
    }
}
