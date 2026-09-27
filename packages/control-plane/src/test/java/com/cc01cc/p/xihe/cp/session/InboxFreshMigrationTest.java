package com.cc01cc.p.xihe.cp.session;

import org.flywaydb.core.Flyway;
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
 * PLAN-0408 T1.1: V45 Inbox migration on a fresh real PostgreSQL database.
 *
 * <p>Frozen shape from PLAN-0408 tasks T1.1: seven columns
 * {@code id,to_session_id,type,ref,payload_pointer,created_at,injected_run_id},
 * fixed {@code type='child_terminal'}, unique key
 * {@code (to_session_id,type,ref)}, payload whitelist limited to
 * {@code sessionId/runId/state}, no child Session/Run cascade. Migration
 * ownership asserted here: V42=0374, V43=0410, V44=0407, V45=0408.
 *
 * <p>Paired with {@link InboxV44UpgradeMigrationTest}: fresh and upgrade are
 * separate classes, commands and evidence files; neither stands in for the
 * other (PLAN-0408 tasks T1.1 "V45 migration evidence separation").
 */
@Testcontainers
class InboxFreshMigrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_inbox_fresh")
            .withUsername("test")
            .withPassword("test");

    @Test
    void freshChainAppliesV45AndCreatesTheFrozenInboxShape() throws SQLException {
        String jdbcUrl = createDatabase("xihe_cp_inbox_fresh_db");
        migrateToCurrent(jdbcUrl);
        migrateToCurrent(jdbcUrl);

        try (Connection connection = connect(jdbcUrl)) {
            for (String version : new String[]{"42", "43", "44", "45"}) {
                assertEquals(1, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history "
                        + "WHERE version = '" + version + "' AND success"),
                        "V" + version + " must be recorded as applied on the fresh chain");
            }
            assertNotNull(scalarString(connection, "SELECT to_regclass('public.inbox')"),
                    "inbox must exist after V45");

            // frozen seven-column shape (tasks T1.1 / spec §2)
            assertEquals(7, scalarInt(connection, "SELECT count(*) FROM information_schema.columns "
                    + "WHERE table_schema = 'public' AND table_name = 'inbox'"),
                    "the Inbox table must stay at the frozen seven columns");
            String[][] columns = {
                    {"id", "uuid", "NO"},
                    {"to_session_id", "uuid", "NO"},
                    {"type", "character varying", "NO"},
                    {"ref", "uuid", "NO"},
                    {"payload_pointer", "jsonb", "NO"},
                    {"created_at", "timestamp with time zone", "NO"},
                    {"injected_run_id", "uuid", "YES"},
            };
            for (String[] column : columns) {
                assertEquals(column[1], scalarString(connection, "SELECT data_type FROM information_schema.columns "
                                + "WHERE table_schema = 'public' AND table_name = 'inbox' "
                                + "AND column_name = '" + column[0] + "'"),
                        "inbox." + column[0] + " type");
                assertEquals(column[2], scalarString(connection, "SELECT is_nullable FROM information_schema.columns "
                                + "WHERE table_schema = 'public' AND table_name = 'inbox' "
                                + "AND column_name = '" + column[0] + "'"),
                        "inbox." + column[0] + " nullability");
            }

            // unique key (to_session_id, type, ref)
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM pg_constraint "
                    + "WHERE conname = 'uq_inbox_session_type_ref' AND contype = 'u'"),
                    "the frozen unique key must exist");
            assertEquals("to_session_id,type,ref", scalarString(connection,
                    "SELECT string_agg(a.attname, ',' ORDER BY a.attnum) FROM pg_constraint c "
                            + "JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) "
                            + "WHERE c.conname = 'uq_inbox_session_type_ref'"),
                    "the unique key columns must be exactly (to_session_id, type, ref)");

            // parent FK only: ON DELETE CASCADE to sessions, no child cascade
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM pg_constraint "
                    + "WHERE conrelid = 'inbox'::regclass AND contype = 'f'"),
                    "inbox must declare exactly one foreign key (parent Session only)");
            assertEquals("c", scalarString(connection,
                    "SELECT confdeltype FROM pg_constraint WHERE conname = 'fk_inbox_session'"),
                    "parent Session delete must cascade its Inbox rows");
            assertEquals("sessions", scalarString(connection,
                    "SELECT confrelid::regclass::text FROM pg_constraint WHERE conname = 'fk_inbox_session'"),
                    "the cascade target must be sessions");

            // frozen CHECK constraints
            assertEquals(2, scalarInt(connection, "SELECT count(*) FROM pg_constraint "
                            + "WHERE conname IN ('ck_inbox_type', 'ck_inbox_payload_pointer') AND contype = 'c'"),
                    "both frozen CHECK constraints must exist");
        }
    }

    @Test
    void freshInboxEnforcesTypeUniqueKeyPayloadWhitelistAndParentDelete() throws SQLException {
        String jdbcUrl = createDatabase("xihe_cp_inbox_fresh_behavior");
        migrateToCurrent(jdbcUrl);

        UUID userId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        UUID parentSessionId = UUID.randomUUID();
        UUID childSessionId = UUID.randomUUID();
        UUID childRunId = UUID.randomUUID();
        UUID inboxId = UUID.randomUUID();
        try (Connection connection = connect(jdbcUrl)) {
            execute(connection, "INSERT INTO users (id, email, password_hash) VALUES ('" + userId
                    + "'::uuid, 'inbox-fresh-" + userId + "@test.local', 'hash')");
            execute(connection, "INSERT INTO workspaces (id, name, owner_id) VALUES ('" + workspaceId
                    + "'::uuid, 'inbox-fresh-ws', '" + userId + "'::uuid)");
            execute(connection, "INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('"
                    + parentSessionId + "'::uuid, '" + workspaceId + "'::uuid, '" + userId
                    + "'::uuid, 'inbox-parent')");
            execute(connection, "INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('"
                    + childSessionId + "'::uuid, '" + workspaceId + "'::uuid, '" + userId
                    + "'::uuid, 'inbox-child')");
            execute(connection, "INSERT INTO session_branches (id, session_id, created_at) VALUES ('"
                    + UUID.randomUUID() + "'::uuid, '" + childSessionId + "'::uuid, NOW())");
            UUID branchId = scalarBranchId(connection, childSessionId);
            execute(connection, "INSERT INTO chat_runs (id, session_id, user_id, workspace_id, "
                    + "idempotency_key, request_hash, status, origin, branch_id) VALUES ('" + childRunId
                    + "'::uuid, '" + childSessionId + "'::uuid, '" + userId + "'::uuid, '" + workspaceId
                    + "'::uuid, 'inbox-child-run', '" + "a".repeat(64) + "', 'accepted', 'spawn', '"
                    + branchId + "'::uuid)");

            // valid frozen row: three whitelisted payload keys
            execute(connection, "INSERT INTO inbox (id, to_session_id, type, ref, payload_pointer) VALUES ('"
                    + inboxId + "'::uuid, '" + parentSessionId + "'::uuid, 'child_terminal', '"
                    + childRunId + "'::uuid, '{\"sessionId\":\"" + childSessionId
                    + "\",\"runId\":\"" + childRunId + "\",\"state\":\"success\"}'::jsonb)");
            assertNull(scalarString(connection, "SELECT injected_run_id::text FROM inbox WHERE id = '"
                    + inboxId + "'::uuid"), "injected_run_id must start NULL until a parent Run claims it");

            // unique key: same (to_session_id, type, ref) is rejected
            SQLException duplicate = assertThrows(SQLException.class,
                    () -> execute(connection, "INSERT INTO inbox (id, to_session_id, type, ref, "
                            + "payload_pointer) VALUES ('" + UUID.randomUUID() + "'::uuid, '"
                            + parentSessionId + "'::uuid, 'child_terminal', '" + childRunId
                            + "'::uuid, '{}'::jsonb)"));
            assertTrue(duplicate.getMessage().contains("uq_inbox_session_type_ref"), duplicate.getMessage());

            // frozen type: only child_terminal
            SQLException wrongType = assertThrows(SQLException.class,
                    () -> execute(connection, "INSERT INTO inbox (id, to_session_id, type, ref, "
                            + "payload_pointer) VALUES ('" + UUID.randomUUID() + "'::uuid, '"
                            + parentSessionId + "'::uuid, 'general_message', '" + UUID.randomUUID()
                            + "'::uuid, '{}'::jsonb)"));
            assertTrue(wrongType.getMessage().contains("ck_inbox_type"), wrongType.getMessage());

            // payload whitelist: no key outside sessionId/runId/state
            SQLException extraKey = assertThrows(SQLException.class,
                    () -> execute(connection, "INSERT INTO inbox (id, to_session_id, type, ref, "
                            + "payload_pointer) VALUES ('" + UUID.randomUUID() + "'::uuid, '"
                            + parentSessionId + "'::uuid, 'child_terminal', '" + UUID.randomUUID()
                            + "'::uuid, '{\"sessionId\":\"" + childSessionId + "\",\"content\":\"leak\"}'::jsonb)"));
            assertTrue(extraKey.getMessage().contains("ck_inbox_payload_pointer"), extraKey.getMessage());

            // payload whitelist allows a subset of the three keys
            execute(connection, "INSERT INTO inbox (id, to_session_id, type, ref, payload_pointer) VALUES ('"
                    + UUID.randomUUID() + "'::uuid, '" + parentSessionId + "'::uuid, 'child_terminal', '"
                    + UUID.randomUUID() + "'::uuid, '{\"state\":\"error\"}'::jsonb)");
            assertEquals(2, scalarInt(connection, "SELECT count(*) FROM inbox WHERE to_session_id = '"
                    + parentSessionId + "'::uuid"), "two distinct child runs may each hold one row");

            // parent delete clears Inbox without touching child Session/ChatRun
            execute(connection, "DELETE FROM sessions WHERE id = '" + parentSessionId + "'::uuid");
            assertEquals(0, scalarInt(connection, "SELECT count(*) FROM inbox"),
                    "parent delete must clear its Inbox rows");
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM sessions WHERE id = '"
                    + childSessionId + "'::uuid"), "child Session must survive a parent delete");
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM chat_runs WHERE id = '"
                    + childRunId + "'::uuid"), "child ChatRun must survive a parent delete");
        }
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private static UUID scalarBranchId(Connection connection, UUID sessionId) throws SQLException {
        try (java.sql.Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery("SELECT id FROM session_branches WHERE session_id = '"
                     + sessionId + "'::uuid")) {
            result.next();
            return result.getObject(1, UUID.class);
        }
    }

    private static String createDatabase(String databaseName) throws SQLException {
        String uniqueName = databaseName + "_" + UUID.randomUUID().toString().replace("-", "");
        try (Connection admin = connect(postgres.getJdbcUrl());
             Statement statement = admin.createStatement()) {
            statement.executeUpdate("CREATE DATABASE " + uniqueName);
        }
        return postgres.getJdbcUrl().replace("/" + postgres.getDatabaseName(), "/" + uniqueName);
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
