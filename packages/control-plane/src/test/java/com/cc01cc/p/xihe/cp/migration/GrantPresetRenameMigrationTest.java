package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.support.TestContainerLabels;
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
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * task-832: V182 renames the authorization tables and converts {@code grants.source} in place.
 *
 * <p>The risky half of the rename is the value conversion: the materializer reads a closed source
 * set, so a missed {@code source='role'} row becomes silently inert (deny) instead of failing.
 * This test therefore measures the rows before and after the migration and executes the rollback
 * script on the same real PostgreSQL instance.</p>
 */
@Testcontainers
class GrantPresetRenameMigrationTest {

    private static final String DOWN_SCRIPT =
            "db/rollback/R182__task832_grant_preset_rename.down.sql";

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_v182")
            .withUsername("test")
            .withPassword("test")
            .withLabels(TestContainerLabels.runId());

    private static Connection connection;

    @BeforeAll
    static void migrateToJustBeforeV182AndSeedFixtures() throws SQLException {
        String url = postgres.getJdbcUrl();
        Flyway.configure()
                .dataSource(url, postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("181"))
                .load()
                .migrate();
        connection = DriverManager.getConnection(url, postgres.getUsername(), postgres.getPassword());
        for (String source : new String[] {"role", "spawn", "template"}) {
            execute("INSERT INTO grants (id, subject_type, subject_id, permissions, source,"
                    + " scope_type, read_state) VALUES (gen_random_uuid(), 'user', gen_random_uuid(),"
                    + " '[]'::jsonb, '" + source + "', 'instance', 'read')");
        }
        assertEquals(3, count("SELECT count(*) FROM grants WHERE source IN"
                + " ('role','spawn','template')"), "fixture: one row per source");
    }

    private void assertUp() throws SQLException {
        Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .load()
                .migrate();

        assertEquals(4, count("SELECT count(*) FROM information_schema.tables WHERE table_schema ="
                + " 'public' AND table_name IN ('grant_presets', 'grant_preset_atoms',"
                + " 'grant_preset_bindings', 'org_unit_preset_bindings')"),
                "all four renamed tables exist");
        for (String old : new String[] {"roles", "role_permissions", "role_bindings",
                "org_unit_role_bindings"}) {
            assertEquals(0, count("SELECT count(*) FROM information_schema.tables WHERE table_schema ="
                    + " 'public' AND table_name = '" + old + "'"), "old table is gone: " + old);
        }

        assertEquals(1, count("SELECT count(*) FROM grants WHERE source = 'preset'"),
                "the role row was converted");
        assertEquals(0, count("SELECT count(*) FROM grants WHERE source = 'role'"),
                "no role row survives");
        assertEquals(1, count("SELECT count(*) FROM grants WHERE source = 'spawn'"));
        assertEquals(1, count("SELECT count(*) FROM grants WHERE source = 'template'"));

        SQLException rejected = assertThrows(SQLException.class, () -> execute(
                "INSERT INTO grants (id, subject_type, subject_id, permissions, source,"
                        + " scope_type, read_state) VALUES (gen_random_uuid(), 'user',"
                        + " gen_random_uuid(), '[]'::jsonb, 'role', 'instance', 'read')"));
        assertEquals("23514", rejected.getSQLState(), "the new CHECK rejects the retired value");
    }

    @Test
    void upAndDownRoundTrip() throws SQLException, IOException {
        assertUp();
        runRollback();

        assertNotNull(table("roles"));
        assertNull(table("grant_presets"));
        assertEquals(1, count("SELECT count(*) FROM grants WHERE source = 'role'"),
                "the rollback converts the preset row back");
        assertEquals(0, count("SELECT count(*) FROM grants WHERE source = 'preset'"));
    }

    private static void runRollback() throws SQLException, IOException {
        String sql;
        try (InputStream stream = GrantPresetRenameMigrationTest.class
                .getClassLoader().getResourceAsStream(DOWN_SCRIPT)) {
            assertNotNull(stream, "rollback script on the classpath");
            sql = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
        StringBuilder statement = new StringBuilder();
        for (String line : sql.split("\n")) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("--")) {
                continue;
            }
            statement.append(line).append('\n');
            if (trimmed.endsWith(";")) {
                execute(statement.toString());
                statement.setLength(0);
            }
        }
    }

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private static int count(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            rs.next();
            return rs.getInt(1);
        }
    }

    private static String table(String name) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(
                     "SELECT to_regclass('public." + name + "')::text")) {
            rs.next();
            return rs.getString(1);
        }
    }
}
