package com.cc01cc.p.xihe.cp.operation;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

@Testcontainers
class OperationLedgerFreshMigrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_fresh")
            .withUsername("test")
            .withPassword("test");

    private static Connection connection;

    @BeforeAll
    static void applyMigrationsOnFreshDatabase() throws SQLException {
        Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .load()
                .migrate();
        connection = DriverManager.getConnection(
                postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
    }

    private static int scalarInt(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            rs.next();
            return rs.getInt(1);
        }
    }

    private static String scalarString(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            rs.next();
            return rs.getString(1);
        }
    }

    private static void executeUpdate(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.executeUpdate(sql);
        }
    }

    private static void insertOperation(UUID id, UUID userId, UUID sessionId, String idempotencyKey)
            throws SQLException {
        String sql = """
                INSERT INTO session_operations (id, session_id, workspace_id, user_id, run_id, request_id,
                    kind, source, actor_type, actor_id, status, idempotency_key)
                VALUES (?::uuid, ?::uuid, NULL, ?::uuid, NULL, NULL, 'chat', 'ui', 'user', ?, 'accepted', ?)
                """;
        try (PreparedStatement ps = connection.prepareStatement(sql)) {
            ps.setString(1, id.toString());
            ps.setString(2, sessionId == null ? null : sessionId.toString());
            ps.setString(3, userId == null ? null : userId.toString());
            ps.setString(4, userId == null ? null : userId.toString());
            ps.setString(5, idempotencyKey);
            ps.executeUpdate();
        }
    }

    private static UUID insertItem(UUID operationId, int sequence) throws SQLException {
        UUID itemId = UUID.randomUUID();
        String sql = """
                INSERT INTO operation_items (id, operation_id, sequence, kind, source, status)
                VALUES (?::uuid, ?::uuid, ?, 'tool_call', 'agent', 'pending')
                """;
        try (PreparedStatement ps = connection.prepareStatement(sql)) {
            ps.setString(1, itemId.toString());
            ps.setString(2, operationId.toString());
            ps.setInt(3, sequence);
            ps.executeUpdate();
        }
        return itemId;
    }

    private static UUID insertAttempt(UUID itemId, String stage, int retryNo) throws SQLException {
        UUID attemptId = UUID.randomUUID();
        String sql = """
                INSERT INTO operation_attempts (id, item_id, stage, retry_no, module, status, started_at)
                VALUES (?::uuid, ?::uuid, ?, ?, 'runtime', 'started', NOW())
                """;
        try (PreparedStatement ps = connection.prepareStatement(sql)) {
            ps.setString(1, attemptId.toString());
            ps.setString(2, itemId.toString());
            ps.setString(3, stage);
            ps.setInt(4, retryNo);
            ps.executeUpdate();
        }
        return attemptId;
    }

    private static void insertEvent(UUID operationId, UUID itemId, long sequence) throws SQLException {
        String sql = """
                INSERT INTO operation_events (id, operation_id, item_id, sequence, event_type, state, actor)
                VALUES (?::uuid, ?::uuid, ?::uuid, ?, 'item.created', 'pending', 'system')
                """;
        try (PreparedStatement ps = connection.prepareStatement(sql)) {
            ps.setString(1, UUID.randomUUID().toString());
            ps.setString(2, operationId.toString());
            ps.setString(3, itemId.toString());
            ps.setLong(4, sequence);
            ps.executeUpdate();
        }
    }

    private static void insertExtension(UUID itemId, UUID attemptId, String kind, int version)
            throws SQLException {
        String sql = """
                INSERT INTO operation_extensions (id, item_id, attempt_id, extension_kind, schema_version, payload)
                VALUES (?::uuid, ?::uuid, ?::uuid, ?, ?, '{"totalTokens": 10}'::jsonb)
                """;
        try (PreparedStatement ps = connection.prepareStatement(sql)) {
            ps.setString(1, UUID.randomUUID().toString());
            ps.setString(2, itemId == null ? null : itemId.toString());
            ps.setString(3, attemptId == null ? null : attemptId.toString());
            ps.setString(4, kind);
            ps.setInt(5, version);
            ps.executeUpdate();
        }
    }

    @Test
    void freshDatabaseAppliesAllKnownMigrationsWithoutError() throws SQLException {
        Set<String> versions = new HashSet<>();
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery("SELECT version FROM flyway_schema_history")) {
            while (rs.next()) {
                versions.add(rs.getString(1));
            }
        }
        assertTrue(versions.containsAll(Set.of("1", "2", "3", "4", "5", "6", "7", "8")),
                "fresh database must apply the current V1-V8 migration chain: " + versions);
        assertEquals(versions.size(),
                scalarInt("SELECT count(*) FROM flyway_schema_history WHERE success = true"));
    }

    @Test
    void v8SchemaGateFixesApplied() throws SQLException {
        for (String fk : new String[]{
                "fk_workspaces_owner", "fk_sessions_user", "fk_chat_runs_user",
                "fk_files_user", "fk_context_events_user", "fk_context_projections_user",
                "fk_approval_requests_user"}) {
            String deleteRule = scalarString(
                    "SELECT confdeltype FROM pg_constraint WHERE conname = '" + fk + "'");
            // 'a' = NO ACTION (explicit per PLAN-280 Decision 18 gate).
            assertEquals("a", deleteRule, "FK must declare explicit ON DELETE: " + fk);
        }
        assertEquals(0, scalarInt(
                "SELECT count(*) FROM pg_indexes WHERE indexname IN ("
                        + "'idx_workspace_execution_specs_workspace_generation',"
                        + "'idx_context_events_session_sequence','idx_config_lookup')"),
                "redundant indexes must be dropped by V8");
        assertNotNull(scalarString(
                "SELECT column_name FROM information_schema.columns "
                        + "WHERE table_schema = 'public' AND table_name = 'config' "
                        + "AND column_name = 'created_at'"),
                "config.created_at must exist");
    }

    @Test
    void freshDatabaseHasRequiredLedgerTables() throws SQLException {
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM information_schema.tables "
                        + "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' "
                        + "AND table_name = 'flyway_schema_history'"),
                "flyway_schema_history must record the applied chain");
        for (String table : new String[]{
                "session_operations", "operation_items", "operation_attempts",
                "operation_events", "operation_extensions", "diagnostic_artifacts",
                "users", "workspaces", "sessions", "chat_runs", "messages",
                "approval_requests", "workspace_execution_specs", "context_events"}) {
            assertNotNull(scalarString("SELECT to_regclass('public." + table + "')"),
                    "missing table: " + table);
        }
        assertNotNull(scalarString(
                "SELECT column_name FROM information_schema.columns "
                        + "WHERE table_schema = 'public' AND table_name = 'approval_requests' "
                        + "AND column_name = 'grant_consumed_at'"),
                "approval grant consumption column must exist");
    }

    @Test
    void v2ConstraintsAndIndexesExist() throws SQLException {
        String idempotencyDef = scalarString(
                "SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_session_operations_idempotency'");
        assertTrue(idempotencyDef.contains("idempotency_key IS NOT NULL"),
                "idempotency index must be partial: " + idempotencyDef);
        assertTrue(idempotencyDef.contains("user_id") && idempotencyDef.contains("session_id")
                && idempotencyDef.contains("idempotency_key"), idempotencyDef);

        String runDef = scalarString(
                "SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_session_operations_run'");
        assertTrue(runDef.contains("run_id IS NOT NULL"), "run index must be partial: " + runDef);

        String attemptDef = scalarString(
                "SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_operation_attempts_item_stage_retry'");
        assertTrue(attemptDef.contains("item_id") && attemptDef.contains("stage")
                && attemptDef.contains("retry_no") && attemptDef.contains("UNIQUE"), attemptDef);

        String extItemDef = scalarString(
                "SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_operation_extensions_item_kind_version'");
        assertTrue(extItemDef.contains("item_id IS NOT NULL") && extItemDef.contains("attempt_id IS NULL"),
                "item extension index must be complementary partial: " + extItemDef);

        String extAttemptDef = scalarString(
                "SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_operation_extensions_attempt_kind_version'");
        assertTrue(extAttemptDef.contains("attempt_id IS NOT NULL") && extAttemptDef.contains("item_id IS NULL"),
                "attempt extension index must be complementary partial: " + extAttemptDef);
    }

    @Test
    void approvalRequestForeignKeyTargetsRequestId() throws SQLException {
        String sql = """
                SELECT conf.conrelid::regclass::text AS src_table,
                       src_att.attname AS src_col,
                       conf.confrelid::regclass::text AS ref_table,
                       ref_att.attname AS ref_col
                FROM pg_constraint conf
                JOIN pg_attribute src_att
                     ON src_att.attrelid = conf.conrelid AND src_att.attnum = ANY (conf.conkey)
                JOIN pg_attribute ref_att
                     ON ref_att.attrelid = conf.confrelid AND ref_att.attnum = ANY (conf.confkey)
                WHERE conf.conname = 'fk_operation_items_approval_request'
                  AND conf.contype = 'f'
                """;
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            assertTrue(rs.next(), "fk_operation_items_approval_request must exist");
            assertEquals("operation_items", rs.getString("src_table"));
            assertEquals("approval_request_id", rs.getString("src_col"));
            assertEquals("approval_requests", rs.getString("ref_table"));
            assertEquals("request_id", rs.getString("ref_col"));
            assertTrue(!rs.next(), "fk must map exactly one column pair");
        }
    }

    @Test
    void fullOperationChainInsertSucceeds() throws SQLException {
        UUID operationId = UUID.randomUUID();
        insertOperation(operationId, null, null, null);
        UUID itemId = insertItem(operationId, 1);
        UUID attemptId = insertAttempt(itemId, "runtime_exec", 0);
        insertEvent(operationId, itemId, 1);
        insertExtension(itemId, null, "llm_usage", 1);

        assertEquals(1, scalarInt(
                "SELECT count(*) FROM session_operations WHERE id = '" + operationId + "'::uuid"));
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM operation_items WHERE operation_id = '" + operationId + "'::uuid"));
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM operation_attempts WHERE item_id = '" + itemId + "'::uuid"));
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM operation_events WHERE operation_id = '" + operationId + "'::uuid"));
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM operation_extensions WHERE item_id = '" + itemId + "'::uuid"));

        SQLException attemptConflict = assertThrows(SQLException.class,
                () -> insertAttempt(itemId, "runtime_exec", 0));
        assertTrue(attemptConflict.getMessage().contains("uq_operation_attempts_item_stage_retry"),
                attemptConflict.getMessage());
        insertAttempt(itemId, "cp_forward", 0);
        UUID parent = insertAttempt(itemId, "runtime_exec", 1);
        assertNotNull(parent);

        SQLException extensionConflict = assertThrows(SQLException.class,
                () -> insertExtension(itemId, null, "llm_usage", 1));
        assertTrue(extensionConflict.getMessage().contains("uq_operation_extensions_item_kind_version"),
                extensionConflict.getMessage());

        UUID attemptScopedAttempt = insertAttempt(itemId, "agent_dispatch", 0);
        insertExtension(null, attemptScopedAttempt, "llm_usage", 1);
        SQLException attemptExtConflict = assertThrows(SQLException.class,
                () -> insertExtension(null, attemptScopedAttempt, "llm_usage", 1));
        assertTrue(attemptExtConflict.getMessage().contains("uq_operation_extensions_attempt_kind_version"),
                attemptExtConflict.getMessage());

        SQLException sequenceConflict = assertThrows(SQLException.class,
                () -> insertItem(operationId, 1));
        assertTrue(sequenceConflict.getMessage().contains("uq_operation_items_operation_sequence"),
                sequenceConflict.getMessage());
        insertItem(operationId, 2);
    }

    private static UUID insertUserWithSession(UUID userId) throws SQLException {
        UUID workspaceId = UUID.randomUUID();
        UUID sessionId = UUID.randomUUID();
        executeUpdate("INSERT INTO users (id, email, password_hash) VALUES ('" + userId
                + "'::uuid, 'fresh-" + userId + "@test.local', 'hash')");
        executeUpdate("INSERT INTO workspaces (id, name, owner_id) VALUES ('" + workspaceId
                + "'::uuid, 'fresh-ws', '" + userId + "'::uuid)");
        executeUpdate("INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('" + sessionId
                + "'::uuid, '" + workspaceId + "'::uuid, '" + userId + "'::uuid, 'fresh-session')");
        return sessionId;
    }

    @Test
    void duplicateIdempotencyKeyRejectedAndNullKeysAllowed() throws SQLException {
        UUID userId = UUID.randomUUID();
        UUID sessionId = insertUserWithSession(userId);
        UUID first = UUID.randomUUID();
        UUID second = UUID.randomUUID();
        insertOperation(first, userId, sessionId, "idem-key-1");
        SQLException conflict = assertThrows(SQLException.class,
                () -> insertOperation(second, userId, sessionId, "idem-key-1"));
        assertTrue(conflict.getMessage().contains("uq_session_operations_idempotency"),
                conflict.getMessage());
        insertOperation(UUID.randomUUID(), userId, sessionId, "idem-key-2");
        insertOperation(UUID.randomUUID(), null, null, null);
        insertOperation(UUID.randomUUID(), null, null, null);
    }
}
