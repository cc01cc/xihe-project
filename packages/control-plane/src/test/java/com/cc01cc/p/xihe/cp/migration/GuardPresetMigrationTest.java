package com.cc01cc.p.xihe.cp.migration;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * PLAN-0625 E (V95): the guard preset principal.
 *
 * <ol>
 *   <li>{@code agent_principals} gains {@code origin} (every pre-V95 principal is a
 *       user-created principal — the NOT NULL DEFAULT backfills) + {@code preset_id};</li>
 *   <li>the builtin guard template + role land in the {@code agent-templates} config domain
 *       at the instance layer (D25-01: config-domain home, not a code constant).</li>
 * </ol>
 */
@Testcontainers
class GuardPresetMigrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_v95")
            .withUsername("test")
            .withPassword("test");

    private static final UUID USER_ID = UUID.randomUUID();
    private static final UUID LEGACY_PRINCIPAL_ID = UUID.randomUUID();

    private static Connection connection;

    @BeforeAll
    static void seedLegacyPrincipalThenMigrate() throws SQLException {
        String url = postgres.getJdbcUrl();
        migrate(url, "94");
        connection = DriverManager.getConnection(url, postgres.getUsername(), postgres.getPassword());
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + USER_ID
                + "', 'plan0625-guard@test.local', 'x', 'plan0625guard')");
        execute("INSERT INTO agent_principals (id, name, created_by_user_id) VALUES ('"
                + LEGACY_PRINCIPAL_ID + "', 'legacy principal', '" + USER_ID + "')");
        migrate(url, null);
    }

    @Test
    void legacyPrincipalsBackfillToOriginUser() throws SQLException {
        List<String[]> rows = query("SELECT origin, preset_id FROM agent_principals WHERE id = '"
                + LEGACY_PRINCIPAL_ID + "'");
        assertEquals(1, rows.size());
        assertEquals("USER", rows.getFirst()[0], "every pre-V95 principal is a user-created principal");
        assertEquals(null, rows.getFirst()[1]);
        assertEquals(1, query("SELECT id FROM agent_principals WHERE origin = 'USER'").size(),
                "the seeded legacy principal is exactly the backfilled row count");
    }

    @Test
    void presetOriginRequiresPresetIdAndValidVocabulary() throws SQLException {
        execute("INSERT INTO agent_principals (id, name, created_by_user_id, origin, preset_id)"
                + " VALUES ('" + UUID.randomUUID() + "', 'guard preset', '" + USER_ID
                + "', 'SYSTEM_PRESET', '00000000-0000-4000-8000-0000000000a2')");
        assertThrows(SQLException.class, () -> execute("INSERT INTO agent_principals (id, name,"
                + " created_by_user_id, origin) VALUES ('" + UUID.randomUUID() + "', 'broken', '"
                + USER_ID + "', 'SYSTEM_PRESET')"), "SYSTEM_PRESET without preset_id violates the contract");
        assertThrows(SQLException.class, () -> execute("INSERT INTO agent_principals (id, name,"
                + " created_by_user_id, origin) VALUES ('" + UUID.randomUUID() + "', 'rogue', '"
                + USER_ID + "', 'IMPORTED')"), "origin vocabulary is USER|SYSTEM_PRESET");
    }

    @Test
    void builtinGuardTemplateIsSeededInTheConfigDomain() throws SQLException {
        List<String[]> rows = query("SELECT config_value FROM config WHERE layer = 'instance'"
                + " AND layer = 'instance' AND domain = 'agent-templates'"
                + " AND config_key = 'agent-templates'");
        assertEquals(1, rows.size(), "exactly one builtin agent-templates row at the instance layer");
        com.fasterxml.jackson.databind.JsonNode root = parseJson(rows.getFirst()[0]);
        com.fasterxml.jackson.databind.JsonNode template = root.path("templates").get(0);
        assertEquals("00000000-0000-4000-8000-0000000000a2", template.path("id").asText());
        assertEquals("none", template.path("toolMode").asText(),
                "the guard holds no workspace tools of its own — verdicts reach approvals via the policy summary");
        com.fasterxml.jackson.databind.JsonNode role = root.path("roles").get(0);
        assertEquals(template.path("roleId").asText(), role.path("id").asText());
        assertEquals(1, role.path("permissions").size());
        assertEquals("read", role.path("permissions").get(0).path("actionClass").asText(),
                "the builtin guard cap is read-only (D25-02: fixed at the input side)");
    }

    @Test
    void hooksColumnExistsWithNullDefault() throws SQLException {
        List<String[]> rows = query("SELECT data_type, is_nullable, column_default"
                + " FROM information_schema.columns WHERE table_schema = 'public'"
                + " AND table_name = 'agent_principals' AND column_name = 'hooks'");
        assertEquals(1, rows.size(), "V96 adds the hook subscription surface");
        assertEquals("jsonb", rows.getFirst()[0]);
        assertEquals("YES", rows.getFirst()[1], "NULL means no subscriptions — no backfill");
        execute("UPDATE agent_principals SET hooks = '{\"advisors\":[{\"kind\":\"guard-v1\"}]}'::jsonb"
                + " WHERE id = '" + LEGACY_PRINCIPAL_ID + "'");
        List<String[]> updated = query("SELECT hooks -> 'advisors' -> 0 ->> 'kind'"
                + " FROM agent_principals WHERE id = '" + LEGACY_PRINCIPAL_ID + "'");
        assertEquals("guard-v1", updated.getFirst()[0], "kind is an open string — no registry (D25-10)");
    }

    @Test
    void presetIndexExistsForPresetLookups() throws SQLException {
        List<String[]> rows = query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'"
                + " AND tablename = 'agent_principals' AND indexname = 'idx_agent_principals_preset'");
        assertEquals(1, rows.size());
    }

    private static com.fasterxml.jackson.databind.JsonNode parseJson(String value) {
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper().readTree(value);
        } catch (Exception unparseable) {
            throw new IllegalStateException("seeded config row is not valid JSON", unparseable);
        }
    }

    private static void migrate(String url, String target) {
        var configuration = Flyway.configure()
                .dataSource(url, postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration");
        if (target != null) {
            configuration.target(MigrationVersion.fromVersion(target));
        }
        configuration.load().migrate();
    }

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private static List<String[]> query(String sql) throws SQLException {
        List<String[]> rows = new ArrayList<>();
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery(sql)) {
            int columns = result.getMetaData().getColumnCount();
            while (result.next()) {
                String[] row = new String[columns];
                for (int index = 1; index <= columns; index++) {
                    row[index - 1] = result.getString(index);
                }
                rows.add(row);
            }
        }
        return rows;
    }
}
