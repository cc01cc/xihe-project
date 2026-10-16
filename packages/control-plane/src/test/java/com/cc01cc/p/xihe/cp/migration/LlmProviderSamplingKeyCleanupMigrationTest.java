package com.cc01cc.p.xihe.cp.migration;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * PLAN-0523 T3.6: V69 cleans the retired layer-global sampling keys
 * (maxTokens/temperature/timeout) on a real PostgreSQL upgrade path.
 *
 * <p>Migrates to V68 (pre-cleanup chain), seeds sampling rows on all three
 * layers plus kept keys and an unrelated domain, then migrates to the current
 * chain and asserts: V69 recorded; every sampling row removed; {@code profile},
 * {@code imageProfile}, {@code imageProvider} and {@code modelParams} untouched;
 * unrelated domains untouched; re-applying the cleanup statement is a no-op
 * (idempotency, 0 rows affected).
 */
@Testcontainers
class LlmProviderSamplingKeyCleanupMigrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_llm_sampling_cleanup")
            .withUsername("test")
            .withPassword("test");

    private static final String[] SAMPLING_KEYS = {"maxTokens", "temperature", "timeout"};

    @Test
    void v69RemovesSamplingKeysAndKeepsProfileImageAndModelParams() throws SQLException {
        String jdbcUrl = createDatabase("xihe_cp_llm_sampling_cleanup_db");
        migrateToVersion(jdbcUrl, "68");

        UUID userId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        String profileValue =
                "{\"providerId\":\"deepseek\",\"connectionKey\":\"default\",\"model\":\"deepseek-chat\"}";
        try (Connection connection = connect(jdbcUrl)) {
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history "
                    + "WHERE version = '69'"), "V69 must not be applied before the upgrade");
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history "
                    + "WHERE version = '68' AND success"), "V68 must already be applied");

            execute(connection, "INSERT INTO users (id, email, password_hash) VALUES ('" + userId
                    + "'::uuid, 'llm-sampling-" + userId + "@test.local', 'hash')");
            execute(connection, "INSERT INTO workspaces (id, name, owner_id) VALUES ('" + workspaceId
                    + "'::uuid, 'llm-sampling-ws', '" + userId + "'::uuid)");

            for (String key : SAMPLING_KEYS) {
                execute(connection, configInsert("llm-provider", "instance", key,
                        "legacy-" + key, "NULL", "NULL"));
            }
            execute(connection, configInsert("llm-provider", "user", "maxTokens",
                    "8192", "'" + userId + "'::uuid", "NULL"));
            execute(connection, configInsert("llm-provider", "workspace", "temperature",
                    "0.2", "NULL", "'" + workspaceId + "'::uuid"));

            execute(connection, configInsert("llm-provider", "instance", "profile",
                    profileValue, "NULL", "NULL"));
            execute(connection, configInsert("llm-provider", "instance", "imageProfile",
                    profileValue, "NULL", "NULL"));
            execute(connection, configInsert("llm-provider", "instance", "imageProvider",
                    "xiaomi", "NULL", "NULL"));
            execute(connection, configInsert("llm-provider", "user", "modelParams",
                    "{\"m-1\":{\"maxTokens\":2048}}", "'" + userId + "'::uuid", "NULL"));
            execute(connection, configInsert("context-policy", "instance", "defaults",
                    "{\"summaryProvider\":\"llm\"}", "NULL", "NULL"));
        }

        migrateToLatest(jdbcUrl);
        migrateToLatest(jdbcUrl);

        try (Connection connection = connect(jdbcUrl)) {
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history "
                    + "WHERE version = '69' AND success"), "V69 must be recorded as applied");
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM config WHERE domain = "
                    + "'llm-provider' AND config_key IN ('maxTokens', 'temperature', 'timeout')"),
                    "all sampling keys must be removed on every layer");
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM config WHERE config_key IN "
                    + "('maxTokens', 'temperature', 'timeout')"),
                    "no sampling key may survive under any domain");

            assertEquals(profileValue, scalarString(connection, "SELECT config_value FROM config "
                    + "WHERE layer = 'instance' AND domain = 'llm-provider' AND config_key = 'profile'"),
                    "the profile unit must survive the cleanup untouched");
            assertEquals(3, scalarInt(connection, "SELECT count(*) FROM config WHERE domain = "
                    + "'llm-provider' AND config_key IN "
                    + "('imageProfile', 'imageProvider', 'modelParams')"),
                    "kept llm-provider keys must survive the cleanup");
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM config WHERE domain = "
                    + "'context-policy' AND config_key = 'defaults'"),
                    "other domains must not be touched");

            // idempotency: re-applying the same cleanup statement affects 0 rows.
            try (Statement statement = connection.createStatement()) {
                assertEquals(0, statement.executeUpdate("DELETE FROM config WHERE domain = "
                        + "'llm-provider' AND config_key IN ('maxTokens', 'temperature', 'timeout')"),
                        "a repeated cleanup must be a no-op");
            }
        }
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private static String configInsert(String domain, String layer, String key, String value,
                                       String userId, String workspaceId) {
        return "INSERT INTO config (id, layer, domain, config_key, config_value, updated_by, "
                + "user_id, workspace_id) VALUES ('" + UUID.randomUUID() + "'::uuid, '" + layer
                + "', '" + domain + "', '" + key + "', '" + value + "', 'migration-test', "
                + userId + ", " + workspaceId + ")";
    }

    private static String createDatabase(String databaseName) throws SQLException {
        String uniqueName = databaseName + "_" + UUID.randomUUID().toString().replace("-", "");
        try (Connection admin = connect(postgres.getJdbcUrl());
             Statement statement = admin.createStatement()) {
            statement.executeUpdate("CREATE DATABASE " + uniqueName);
        }
        return postgres.getJdbcUrl().replace("/" + postgres.getDatabaseName(), "/" + uniqueName);
    }

    private static void migrateToVersion(String jdbcUrl, String version) {
        Flyway.configure()
                .dataSource(jdbcUrl, postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion(version))
                .load()
                .migrate();
    }

    private static void migrateToLatest(String jdbcUrl) {
        Flyway.configure()
                .dataSource(jdbcUrl, postgres.getUsername(), postgres.getPassword())
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
        return DriverManager.getConnection(jdbcUrl, postgres.getUsername(), postgres.getPassword());
    }

    private static String scalarString(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery(sql)) {
            result.next();
            return result.getString(1);
        }
    }

    private static int scalarInt(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery(sql)) {
            result.next();
            return result.getInt(1);
        }
    }
}
