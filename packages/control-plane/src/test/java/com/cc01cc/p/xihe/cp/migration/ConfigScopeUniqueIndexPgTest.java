package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.support.TestContainerLabels;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
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
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-363: the "(layer, domain, config_key) is unique" rule lives in PostgreSQL, not in Java.
 * <p>
 * The H2 lane cannot express it (Flyway is off there, and {@code ConfigEntity} carries no unique
 * constraint), so a fixture can insert two rows with the same triple and the next whole-key DELETE
 * dies in {@code findExisting} with "Query did not return a unique result". This class pins the
 * production side of that invariant: the four partial unique indexes from V12/V153 exist and really
 * do reject the second row, so the duplicate state is unreachable through the write paths.
 */
@Testcontainers
class ConfigScopeUniqueIndexPgTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_task363")
            .withUsername("test")
            .withPassword("test")
            .withLabels(TestContainerLabels.runId());

    private static Connection connection;
    private static UUID userId;
    private static UUID workspaceId;

    @BeforeAll
    static void migrateAndSeedOwners() throws SQLException {
        String url = postgres.getJdbcUrl();
        Flyway.configure()
                .dataSource(url, postgres.getUsername(), postgres.getPassword())
                .load()
                .migrate();
        connection = DriverManager.getConnection(url, postgres.getUsername(), postgres.getPassword());
        userId = UUID.randomUUID();
        workspaceId = UUID.randomUUID();
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + userId
                + "', 'task363@test.local', 'x', 'task363')");
        execute("INSERT INTO workspaces (id, name) VALUES ('" + workspaceId + "', 'task363-ws')");
    }

    @AfterAll
    static void close() throws SQLException {
        if (connection != null) {
            connection.close();
        }
    }

    @Test
    void allFourLayersCarryAPartialUniqueIndex() throws SQLException {
        assertEquals(1, count("SELECT count(*) FROM pg_indexes WHERE indexname = 'uq_config_instance_scope'"),
                "instance layer index");
        assertEquals(1, count("SELECT count(*) FROM pg_indexes WHERE indexname = 'uq_config_workspace_scope'"),
                "workspace layer index");
        assertEquals(1, count("SELECT count(*) FROM pg_indexes WHERE indexname = 'uq_config_user_scope'"),
                "user layer index");
        assertEquals(1, count(
                "SELECT count(*) FROM pg_indexes WHERE indexname = 'uq_config_workspace_default_scope'"),
                "workspace-default layer index");
    }

    @Test
    void theInstanceLayerRejectsASecondRowForTheSameTriple() throws SQLException {
        insertConfig("instance", null, null, "task363-probe", "k1");
        SQLException rejection = assertThrows(SQLException.class,
                () -> insertConfig("instance", null, null, "task363-probe", "k1"),
                "a second instance row for the same (domain, config_key) must be rejected");
        assertEquals("23505", rejection.getSQLState(), rejection.getMessage());
    }

    @Test
    void theWorkspaceDefaultLayerRejectsASecondRowForTheSameTriple() throws SQLException {
        insertConfig("workspace-default", null, null, "task363-probe", "k2");
        SQLException rejection = assertThrows(SQLException.class,
                () -> insertConfig("workspace-default", null, null, "task363-probe", "k2"));
        assertEquals("23505", rejection.getSQLState(), rejection.getMessage());
    }

    @Test
    void theOwnerLayersAreUniquePerOwnerToo() throws SQLException {
        insertConfig("user", userId, null, "task363-probe", "k3");
        assertEquals("23505", assertThrows(SQLException.class,
                () -> insertConfig("user", userId, null, "task363-probe", "k3")).getSQLState());
        insertConfig("workspace", null, workspaceId, "task363-probe", "k4");
        assertEquals("23505", assertThrows(SQLException.class,
                () -> insertConfig("workspace", null, workspaceId, "task363-probe", "k4")).getSQLState());
    }

    /** V12:110 / V153:26 — the scope binding check, the other half of "one row per triple". */
    @Test
    void aRowWhoseScopeColumnsContradictItsLayerIsRejected() {
        SQLException rejection = assertThrows(SQLException.class,
                () -> insertConfig("instance", userId, null, "task363-probe", "k5"));
        assertEquals("23514", rejection.getSQLState(), rejection.getMessage());
    }

    private static void insertConfig(String layer, UUID ownerUserId, UUID ownerWorkspaceId,
                                     String domain, String key) throws SQLException {
        execute("INSERT INTO config (id, layer, user_id, workspace_id, domain, config_key, config_value,"
                + " updated_by, created_at, updated_at) VALUES (gen_random_uuid(), '" + layer + "', "
                + literal(ownerUserId) + ", " + literal(ownerWorkspaceId) + ", '" + domain + "', '"
                + key + "', '{}', 'test', now(), now())");
    }

    private static String literal(UUID value) {
        return value == null ? "NULL" : "'" + value + "'";
    }

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private static int count(String sql) throws SQLException {
        try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery(sql)) {
            assertTrue(rows.next());
            return rows.getInt(1);
        }
    }
}
