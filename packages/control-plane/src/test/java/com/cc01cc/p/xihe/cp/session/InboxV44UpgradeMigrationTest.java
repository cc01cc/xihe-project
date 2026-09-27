package com.cc01cc.p.xihe.cp.session;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.FlywayException;
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
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0408 T1.1: supported V44 → V45 Inbox upgrade on real PostgreSQL.
 *
 * <p>The upgrade fixture migrates to V44 (PLAN-0407), seeds pre-V45 rows
 * (Sessions, a spawn ChatRun, a V44 waiting link), then migrates to the
 * current chain and asserts: V45 recorded, {@code inbox} created with the
 * frozen shape, every pre-V45 row untouched, V44 delta columns and V42
 * principal structures intact, plus the unique/type/payload rules and the
 * parent-delete cascade on the upgraded database.
 *
 * <p>Paired with {@link InboxFreshMigrationTest}: fresh and upgrade are
 * separate classes, commands and evidence files; neither stands in for the
 * other (PLAN-0408 tasks T1.1 "V45 migration evidence separation").
 */
@Testcontainers
class InboxV44UpgradeMigrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_inbox_v44_upgrade")
            .withUsername("test")
            .withPassword("test");

    @Test
    void v44ToV45UpgradeCreatesInboxWithoutTouchingPreV45Data() throws SQLException {
        String jdbcUrl = createDatabase("xihe_cp_inbox_v44_upgrade_db");
        migrateToVersion(jdbcUrl, "44");

        UUID userId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        UUID parentSessionId = UUID.randomUUID();
        UUID childSessionId = UUID.randomUUID();
        UUID childRunId = UUID.randomUUID();
        UUID operationId = UUID.randomUUID();
        UUID itemId = UUID.randomUUID();
        try (Connection connection = connect(jdbcUrl)) {
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history "
                    + "WHERE version = '45'"), "V45 must not be applied before the upgrade");
            for (String version : new String[]{"42", "43", "44"}) {
                assertEquals(1, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history "
                        + "WHERE version = '" + version + "' AND success"),
                        "V" + version + " must already be applied on the supported V44 schema");
            }
            assertNull(scalarString(connection, "SELECT to_regclass('public.inbox')::text"),
                    "inbox must not exist on the V44 schema");

            execute(connection, "INSERT INTO users (id, email, password_hash) VALUES ('" + userId
                    + "'::uuid, 'inbox-upgrade-" + userId + "@test.local', 'hash')");
            execute(connection, "INSERT INTO workspaces (id, name, owner_id) VALUES ('" + workspaceId
                    + "'::uuid, 'inbox-upgrade-ws', '" + userId + "'::uuid)");
            execute(connection, "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ('"
                    + workspaceId + "'::uuid, '" + userId + "'::uuid, 'OWNER')");
            execute(connection, "INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('"
                    + parentSessionId + "'::uuid, '" + workspaceId + "'::uuid, '" + userId
                    + "'::uuid, 'upgrade-parent')");
            execute(connection, "INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('"
                    + childSessionId + "'::uuid, '" + workspaceId + "'::uuid, '" + userId
                    + "'::uuid, 'upgrade-child')");
            UUID branchId = UUID.randomUUID();
            execute(connection, "INSERT INTO session_branches (id, session_id, created_at) VALUES ('"
                    + branchId + "'::uuid, '" + childSessionId + "'::uuid, NOW())");
            execute(connection, "INSERT INTO chat_runs (id, session_id, user_id, workspace_id, "
                    + "idempotency_key, request_hash, status, origin, branch_id) VALUES ('" + childRunId
                    + "'::uuid, '" + childSessionId + "'::uuid, '" + userId + "'::uuid, '" + workspaceId
                    + "'::uuid, 'upgrade-child-run', '" + "a".repeat(64) + "', 'accepted', 'spawn', '"
                    + branchId + "'::uuid)");
            execute(connection, "INSERT INTO ledger_operations (id, user_id, kind, source, actor_type, status) "
                    + "VALUES ('" + operationId + "'::uuid, '" + userId
                    + "'::uuid, 'system', 'system', 'system', 'accepted')");
            execute(connection, "INSERT INTO operation_items (id, operation_id, sequence, kind, source, "
                    + "status, waiting_on_run_id) VALUES ('" + itemId + "'::uuid, '" + operationId
                    + "'::uuid, 1, 'tool_call', 'agent', 'running', '" + childRunId + "'::uuid)");
        }

        migrateToCurrent(jdbcUrl);
        migrateToCurrent(jdbcUrl);

        try (Connection connection = connect(jdbcUrl)) {
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history "
                    + "WHERE version = '45' AND success"), "V45 must be recorded as applied on upgrade");
            assertNotNull(scalarString(connection, "SELECT to_regclass('public.inbox')"),
                    "inbox must exist after the upgrade");
            assertEquals(7, scalarInt(connection, "SELECT count(*) FROM information_schema.columns "
                    + "WHERE table_schema = 'public' AND table_name = 'inbox'"),
                    "the upgraded Inbox table must keep the frozen seven columns");
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM pg_constraint "
                            + "WHERE conname = 'uq_inbox_session_type_ref' AND contype = 'u'"),
                    "the frozen unique key must exist after the upgrade");
            assertEquals("c", scalarString(connection,
                    "SELECT confdeltype FROM pg_constraint WHERE conname = 'fk_inbox_session'"),
                    "the parent-delete cascade must exist after the upgrade");
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM pg_constraint "
                    + "WHERE conrelid = 'inbox'::regclass AND contype = 'f'"),
                    "inbox must keep exactly one foreign key (parent Session only)");

            // pre-V45 data untouched
            assertEquals(2, scalarInt(connection, "SELECT count(*) FROM sessions"),
                    "the upgrade must not add or remove Sessions");
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM chat_runs WHERE id = '"
                    + childRunId + "'::uuid AND terminal_at IS NULL"),
                    "pre-V45 runs must keep terminal_at NULL");
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM operation_items WHERE id = '"
                    + itemId + "'::uuid AND waiting_on_run_id = '" + childRunId + "'::uuid"),
                    "the V44 waiting link must survive the upgrade untouched");
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM inbox"),
                    "the upgrade must not backfill any Inbox row");

            // V44 delta columns and V42 principal structures stay intact
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM information_schema.columns "
                            + "WHERE table_name = 'chat_runs' AND column_name = 'terminal_at'"),
                    "V44 chat_runs.terminal_at must survive V45");
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM pg_constraint "
                            + "WHERE conname = 'fk_sessions_agent_principal' AND contype = 'f' "
                            + "AND confdeltype = 'r'"),
                    "the restricted sessions->agent_principals FK must survive V45");
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM pg_constraint "
                            + "WHERE conname = 'pk_workspace_agents' AND contype = 'p'"),
                    "the workspace_agents composite key must survive V45");

            // behavior on the upgraded database: unique key + parent delete cascade
            execute(connection, "INSERT INTO inbox (id, to_session_id, type, ref, payload_pointer) VALUES ('"
                    + UUID.randomUUID() + "'::uuid, '" + parentSessionId + "'::uuid, 'child_terminal', '"
                    + childRunId + "'::uuid, '{\"sessionId\":\"" + childSessionId + "\",\"runId\":\""
                    + childRunId + "\",\"state\":\"success\"}'::jsonb)");
            SQLException duplicate = assertThrows(SQLException.class,
                    () -> execute(connection, "INSERT INTO inbox (id, to_session_id, type, ref, "
                            + "payload_pointer) VALUES ('" + UUID.randomUUID() + "'::uuid, '"
                            + parentSessionId + "'::uuid, 'child_terminal', '" + childRunId
                            + "'::uuid, '{}'::jsonb)"));
            assertTrue(duplicate.getMessage().contains("uq_inbox_session_type_ref"), duplicate.getMessage());

            execute(connection, "DELETE FROM sessions WHERE id = '" + parentSessionId + "'::uuid");
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM inbox"),
                    "parent delete must clear its Inbox rows on the upgraded database");
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM chat_runs WHERE id = '"
                    + childRunId + "'::uuid"), "child ChatRun must survive a parent delete");
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM operation_items WHERE id = '"
                    + itemId + "'::uuid AND waiting_on_run_id = '" + childRunId + "'::uuid"),
                    "the V44 waiting link row must survive a parent delete");
        }
    }

    @Test
    void v45FailureIsNotRecordedAndLeavesTheV44SchemaInPlace() throws SQLException {
        String jdbcUrl = createDatabase("xihe_cp_inbox_v44_upgrade_rollback");
        migrateToVersion(jdbcUrl, "44");
        try (Connection connection = connect(jdbcUrl)) {
            // conflicting object: V45's CREATE TABLE must fail on the upgrade.
            execute(connection, "CREATE TABLE inbox (placeholder UUID)");
        }

        assertThrows(FlywayException.class, () -> migrateToCurrent(jdbcUrl));

        try (Connection connection = connect(jdbcUrl)) {
            assertEquals(0, scalarInt(connection,
                    "SELECT count(*) FROM flyway_schema_history WHERE version = '45'"),
                    "a failed V45 must not be recorded as applied");
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history "
                    + "WHERE version = '44' AND success"),
                    "the V44 schema must remain the applied state after a failed V45");
            assertEquals("placeholder", scalarString(connection, "SELECT column_name FROM "
                    + "information_schema.columns WHERE table_name = 'inbox' AND column_name = 'placeholder'"),
                    "the failed migration must not replace the pre-existing object");
        }
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

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

    private static void migrateToCurrent(String jdbcUrl) {
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
