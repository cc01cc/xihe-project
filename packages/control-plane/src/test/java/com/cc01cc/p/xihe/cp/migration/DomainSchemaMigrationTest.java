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
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

@Testcontainers
class DomainSchemaMigrationTest {

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
        return scalarInt(connection, sql);
    }

    private static int scalarInt(Connection c, String sql) throws SQLException {
        try (Statement statement = c.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            rs.next();
            return rs.getInt(1);
        }
    }

    private static String scalarString(String sql) throws SQLException {
        return scalarString(connection, sql);
    }

    private static String scalarString(Connection c, String sql) throws SQLException {
        try (Statement statement = c.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            rs.next();
            return rs.getString(1);
        }
    }

    private static void executeUpdate(String sql) throws SQLException {
        executeUpdate(connection, sql);
    }

    private static void executeUpdate(Connection c, String sql) throws SQLException {
        try (Statement statement = c.createStatement()) {
            statement.executeUpdate(sql);
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
        assertTrue(versions.containsAll(Set.of("1", "2", "3", "4", "5", "6", "7", "8", "9", "27", "28", "33", "36", "37", "38", "39", "40", "41", "42", "49", "50", "51", "52", "53", "54", "55")),
                "fresh database must apply the current migration chain: " + versions);
        assertEquals(versions.size(),
                scalarInt("SELECT count(*) FROM flyway_schema_history WHERE success = true"));
    }

    @Test
    void v42AgentPrincipalSchemaAndNullableLegacySnapshotsApplied() throws SQLException {
        assertEquals("jsonb", scalarString(
                "SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'agent_principals' AND column_name = 'template_snapshot'"));
        assertEquals("YES", scalarString(
                "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'agent_principals' AND column_name = 'template_snapshot'"),
                "legacy principals without a verifiable template source must allow a null snapshot");
        assertEquals("YES", scalarString(
                "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'sessions' AND column_name = 'agent_principal_id'"));
        assertEquals("jsonb", scalarString(
                "SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'sessions' AND column_name = 'agent_permissions_snapshot'"));
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM pg_constraint WHERE conname = 'fk_sessions_agent_principal' "
                        + "AND contype = 'f' AND confdeltype = 'r'"),
                "Session principal deletion must be restricted");
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM pg_constraint WHERE conname = 'pk_workspace_agents' AND contype = 'p'"),
                "workspace agent binding must use its composite primary key");
        assertEquals(2, scalarInt(
                "SELECT count(*) FROM pg_constraint WHERE conname IN "
                        + "('fk_workspace_agents_principal', 'fk_workspace_agents_workspace') AND contype = 'f'"),
                "workspace agent binding must retain both foreign keys");
        assertEquals("jsonb", scalarString(
                "SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'workspace_agents' AND column_name = 'permissions_snapshot'"));
        assertEquals("NO", scalarString(
                "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'workspace_agents' AND column_name = 'permissions_snapshot'"),
                "every Workspace binding must have its own permission ceiling");
    }

    @Test
    void v37SessionProvenanceColumnsAndIndexesApplied() throws SQLException {
        for (String column : new String[]{"spawned_from_session_id", "spawned_from_run_id", "spawned_at"}) {
            assertNotNull(scalarString(
                    "SELECT column_name FROM information_schema.columns "
                            + "WHERE table_schema = 'public' AND table_name = 'sessions' "
                            + "AND column_name = '" + column + "'"),
                    "sessions." + column + " must exist after V37");
            assertEquals("YES", scalarString(
                    "SELECT is_nullable FROM information_schema.columns "
                            + "WHERE table_schema = 'public' AND table_name = 'sessions' "
                            + "AND column_name = '" + column + "'"),
                    "sessions." + column + " must remain nullable for existing sessions");
        }
        assertEquals(2, scalarInt(
                "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' "
                        + "AND indexname IN ('idx_sessions_spawned_from_session', 'idx_sessions_spawned_from_run')"),
                "both provenance lookup indexes must be applied");
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '37' AND success = true"),
                "V37 must be recorded as applied");
    }

    @Test
    void v38GrantsDefaultUniquenessIsScopedToSubjectAndSource() throws SQLException {
        assertEquals(2, scalarInt(
                "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' "
                        + "AND indexname IN ('idx_grants_subject', 'uq_grants_default_subject')"),
                "grant subject lookup and partial uniqueness indexes must be applied");
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '38' AND success = true"),
                "V38 must be recorded as applied");

        UUID subjectId = UUID.randomUUID();
        insertGrant("default", subjectId);
        assertThrows(SQLException.class, () -> insertGrant("default", subjectId),
                "a subject can have only one default permission set");

        insertGrant("direct", subjectId);
        insertGrant("direct", subjectId);
        assertEquals(2, scalarInt("SELECT count(*) FROM grants WHERE source = 'direct' AND subject_id = '"
                + subjectId + "'"), "non-default grants for one subject may coexist");
    }

    @Test
    void v39ChatRunOriginAndSpawnEventUniquenessApplied() throws SQLException {
        assertEquals("NO", scalarString(
                "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'chat_runs' AND column_name = 'origin'"),
                "chat_runs.origin must be required after existing rows are backfilled");
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM pg_constraint WHERE conname = 'ck_chat_runs_origin'"),
                "only user_submission and spawn are valid origins");
        String indexDefinition = scalarString(
                "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' "
                        + "AND indexname = 'uq_chat_runs_spawn_event_idempotency'");
        assertTrue(indexDefinition.contains("user_id, idempotency_key"));
        assertTrue(indexDefinition.contains("spawn"), "spawn event uniqueness must be partial by origin");
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '39' AND success = true"),
                "V39 must be recorded as applied");
    }

    private static void insertGrant(String source, UUID subjectId) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "INSERT INTO grants (id, subject_type, subject_id, permissions, source) "
                        + "VALUES (?, 'user', ?, CAST(? AS JSONB), ?)")) {
            statement.setObject(1, UUID.randomUUID());
            statement.setObject(2, subjectId);
            statement.setString(3, "[]");
            statement.setString(4, source);
            statement.executeUpdate();
        }
    }

    @Test
    void v28LegacySnapshotRetirementApplied() throws SQLException {
        // PLAN-0357: the V4/V5 legacy snapshot objects are retired on a fresh chain.
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '28' AND success = true"),
                "V28 must be recorded as applied");
        assertNull(scalarString("SELECT to_regclass('public.workspace_snapshots')"),
                "workspace_snapshots must be dropped by V28");
        assertNull(scalarString("SELECT to_regclass('public.workspace_snapshot_files')"),
                "workspace_snapshot_files must be dropped by V28");
        for (String column : new String[]{"snapshot_id", "policy_class"}) {
            assertEquals(0, scalarInt(
                    "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' "
                            + "AND table_name = 'approval_requests' AND column_name = '" + column + "'"),
                    "legacy approval column must be removed: " + column);
        }
        assertEquals(0, scalarInt(
                "SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_approval_requests_snapshot'"),
                "legacy approval snapshot index must be removed");
    }

    @Test
    void v9ApprovalArgumentsHashColumnApplied() throws SQLException {
        assertNotNull(scalarString(
                "SELECT column_name FROM information_schema.columns "
                        + "WHERE table_schema = 'public' AND table_name = 'approval_requests' "
                        + "AND column_name = 'arguments_hash'"),
                "PLAN-292 M1: approval_requests.arguments_hash must exist for grant hash matching");
    }

    @Test
    void mcpInvocationPolicySummaryColumnApplied() throws SQLException {
        // Safe policy snapshots are MCP invocation-owned.
        assertNotNull(scalarString(
                "SELECT column_name FROM information_schema.columns "
                        + "WHERE table_schema = 'public' AND table_name = 'mcp_invocations' "
                        + "AND column_name = 'policy_summary'"),
                "mcp_invocations.policy_summary must exist for the durable verdict snapshot");
        assertEquals("text", scalarString(
                "SELECT data_type FROM information_schema.columns "
                        + "WHERE table_schema = 'public' AND table_name = 'mcp_invocations' "
                        + "AND column_name = 'policy_summary'"));
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '49' AND success = true"),
                "V49 must be recorded as applied");
    }

    @Test
    void v27WorkspaceSliceProjectionApplied() throws SQLException {
        // PLAN-0339 T0.4: the projection is rebuilt with slice fields and no
        // interval-model compatibility columns.
        assertNotNull(scalarString("SELECT to_regclass('public.run_checkpoints')"),
                "run_checkpoints must exist after V27");
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '27' AND success = true"),
                "V27 must be recorded as applied");
        assertEquals("uuid", scalarString(
                "SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'run_checkpoints' AND column_name = 'workspace_id'"));
        for (String column : new String[]{"slice_ref", "captured_at", "source_run_id", "source_session_id",
                "predecessor_ref", "changed_files", "opaque_nested_repos", "state", "unrollable_reason",
                "revert_state", "revert_ref", "revert_summary", "reverted_at", "revert_attempt_count"}) {
            assertNotNull(scalarString(
                    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' "
                            + "AND table_name = 'run_checkpoints' AND column_name = '" + column + "'"),
                    "missing run_checkpoints column: " + column);
        }
        for (String column : new String[]{"run_id", "base_ref", "end_ref", "sealed_at",
                "sealed_with_live_jobs", "sealed_after_abnormal"}) {
            assertEquals(0, scalarInt(
                    "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' "
                            + "AND table_name = 'run_checkpoints' AND column_name = '" + column + "'"),
                    "legacy checkpoint column must be removed: " + column);
        }
        assertNotNull(scalarString(
                "SELECT conname FROM pg_constraint WHERE conname = 'uq_run_checkpoints_workspace_slice'"),
                "unique (workspace_id, slice_ref) must exist");
        assertNotNull(scalarString(
                "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_run_checkpoints_workspace_state_captured'"),
                "(workspace_id, state) index must exist");
        String stateDef = scalarString(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                        + "WHERE conname = 'ck_run_checkpoints_state'");
        for (String state : new String[]{"captured", "abnormal-captured", "degraded", "expired"}) {
            assertTrue(stateDef.contains(state), "state allowlist must include " + state + ": " + stateDef);
        }
    }

    @Test
    void v27WorkspaceSliceConstraintsApply() throws SQLException {
        UUID userId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        executeUpdate("INSERT INTO users (id, email, password_hash) VALUES ('" + userId
                + "'::uuid, 'cp-" + userId + "@test.local', 'hash')");
        executeUpdate("INSERT INTO workspaces (id, name, owner_id) VALUES ('" + workspaceId
                + "'::uuid, 'cp-ws', '" + userId + "'::uuid)");

        UUID runId = UUID.randomUUID();
        UUID sessionId = UUID.randomUUID();
        executeUpdate("INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('" + sessionId
                + "'::uuid, '" + workspaceId + "'::uuid, '" + userId + "'::uuid, 'cp-session')");
        UUID checkpointId = UUID.randomUUID();
        executeUpdate("INSERT INTO run_checkpoints (id, workspace_id, slice_ref, captured_at, source_run_id, "
                + "source_session_id, predecessor_ref, changed_files, opaque_nested_repos, state) VALUES ('"
                + checkpointId + "'::uuid, '" + workspaceId + "'::uuid, 'refs/xihe/slices/1-ab12', NOW(), '"
                + runId + "'::uuid, '" + sessionId + "'::uuid, 'refs/xihe/slices/0-cdef', '[]', '[]', 'captured')");
        assertEquals(1, scalarInt("SELECT count(*) FROM run_checkpoints WHERE source_run_id = '"
                + runId + "'::uuid"));

        SQLException duplicate = assertThrows(SQLException.class,
                () -> executeUpdate("INSERT INTO run_checkpoints (id, workspace_id, slice_ref, state) "
                        + "VALUES ('" + UUID.randomUUID() + "'::uuid, '" + workspaceId + "'::uuid, "
                        + "'refs/xihe/slices/1-ab12', 'captured')"));
        assertTrue(duplicate.getMessage().contains("uq_run_checkpoints_workspace_slice"),
                duplicate.getMessage());

        SQLException duplicateSourceRun = assertThrows(SQLException.class,
                () -> executeUpdate("INSERT INTO run_checkpoints (id, workspace_id, slice_ref, source_run_id, state) "
                        + "VALUES ('" + UUID.randomUUID() + "'::uuid, '" + workspaceId + "'::uuid, "
                        + "'refs/xihe/slices/1-different', '" + runId + "'::uuid, 'captured')"));
        assertTrue(duplicateSourceRun.getMessage().contains("uq_run_checkpoints_workspace_source_run"),
                duplicateSourceRun.getMessage());

        SQLException badState = assertThrows(SQLException.class,
                () -> executeUpdate("INSERT INTO run_checkpoints (id, workspace_id, slice_ref, state) "
                        + "VALUES ('" + UUID.randomUUID() + "'::uuid, '" + workspaceId
                        + "'::uuid, 'refs/xihe/slices/bad', 'bogus')"));
        assertTrue(badState.getMessage().contains("ck_run_checkpoints_state"), badState.getMessage());

        // degraded rows carry the frozen capture-failure reason.
        executeUpdate("INSERT INTO run_checkpoints (id, workspace_id, state, unrollable_reason) "
                + "VALUES ('" + UUID.randomUUID() + "'::uuid, '"
                + workspaceId + "'::uuid, 'degraded', 'UNAVAILABLE')");
        assertEquals(1, scalarInt("SELECT count(*) FROM run_checkpoints WHERE workspace_id = '"
                + workspaceId + "'::uuid AND state = 'degraded' AND unrollable_reason = 'UNAVAILABLE'"));

        // Slice state vocabulary accepts abnormal captures and no old interval state.
        executeUpdate("INSERT INTO run_checkpoints (id, workspace_id, state) "
                + "VALUES ('" + UUID.randomUUID() + "'::uuid, '" + workspaceId + "'::uuid, 'abnormal-captured')");
        assertEquals(1, scalarInt("SELECT count(*) FROM run_checkpoints WHERE workspace_id = '"
                + workspaceId + "'::uuid AND state = 'abnormal-captured'"));

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
    void freshDatabaseDropsLedgerAndKeepsDomainTables() throws SQLException {
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM information_schema.tables "
                        + "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' "
                        + "AND table_name = 'flyway_schema_history'"),
                "flyway_schema_history must record the applied chain");
        for (String table : new String[]{"users", "workspaces", "sessions", "chat_runs", "messages",
                "approval_requests", "approval_history", "mcp_invocations", "mcp_attempts",
                "mcp_dispatch_history", "workspace_jobs", "workspace_job_history",
                "run_checkpoints", "workspace_execution_specs", "context_events"}) {
            assertNotNull(scalarString("SELECT to_regclass('public." + table + "')"),
                    "missing table: " + table);
        }
        for (String table : new String[]{"ledger_operations", "operation_items", "operation_attempts",
                "operation_events", "operation_extensions", "diagnostic_artifacts"}) {
            assertNull(scalarString("SELECT to_regclass('public." + table + "')"),
                    "retired Ledger table still exists: " + table);
        }
        assertEquals(0, scalarInt("SELECT count(*) FROM information_schema.columns "
                + "WHERE table_schema='public' AND table_name='workspace_jobs' "
                + "AND column_name='operation_item_id'"), "WorkspaceJob must not retain the Ledger anchor");
        assertNotNull(scalarString(
                "SELECT column_name FROM information_schema.columns "
                        + "WHERE table_schema = 'public' AND table_name = 'approval_requests' "
                        + "AND column_name = 'grant_consumed_at'"),
                "approval grant consumption column must exist");
    }






    @Test
    void mcpInvocationApprovalReferenceRemainsNullableSetNullForeignKey() throws SQLException {
        assertEquals("YES", scalarString(
                "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' "
                        + "AND table_name='mcp_invocations' AND column_name='approval_request_id'"));
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
                WHERE conf.conname = 'fk_mcp_invocations_approval_request'
                  AND conf.contype = 'f'
                """;
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            assertTrue(rs.next(), "fk_mcp_invocations_approval_request must exist");
            assertEquals("mcp_invocations", rs.getString("src_table"));
            assertEquals("approval_request_id", rs.getString("src_col"));
            assertEquals("approval_requests", rs.getString("ref_table"));
            assertEquals("request_id", rs.getString("ref_col"));
            assertTrue(!rs.next(), "fk must map exactly one column pair");
        }
        assertEquals("n", scalarString("SELECT confdeltype FROM pg_constraint "
                + "WHERE conname='fk_mcp_invocations_approval_request'"),
                "V51 must keep ON DELETE SET NULL");
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
    void v41UpgradeFromV33BackfillsOriginsDefaultsAndSessionKind() throws SQLException {
        // Seed pre-origin ChatRun data at V33; V39/V40/V41 backfill current run,
        // Session-kind, and default-grant state while preserving operation extensions.
        String upgradeDb = "xihe_cp_upgrade_v41";
        String adminUrl = postgres.getJdbcUrl();
        try (Connection admin = DriverManager.getConnection(
                adminUrl, postgres.getUsername(), postgres.getPassword());
             Statement statement = admin.createStatement()) {
            statement.executeUpdate("DROP DATABASE IF EXISTS " + upgradeDb);
            statement.executeUpdate("CREATE DATABASE " + upgradeDb);
        }
        String upgradeUrl = adminUrl.replace("/" + postgres.getDatabaseName(), "/" + upgradeDb);

        Flyway.configure()
                .dataSource(upgradeUrl, postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("33"))
                .load()
                .migrate();

        UUID userId = UUID.randomUUID();
        UUID adminId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        UUID sessionId = UUID.randomUUID();
        UUID chatRunId = UUID.randomUUID();
        UUID operationId = UUID.randomUUID();
        UUID itemId = UUID.randomUUID();
        try (Connection c = DriverManager.getConnection(
                upgradeUrl, postgres.getUsername(), postgres.getPassword())) {
            executeUpdate(c, "INSERT INTO users (id, email, password_hash) VALUES ('" + userId
                    + "'::uuid, 'upgrade-" + userId + "@test.local', 'hash')");
            executeUpdate(c, "INSERT INTO users (id, email, password_hash, role) VALUES ('" + adminId
                    + "'::uuid, 'upgrade-admin-" + adminId + "@test.local', 'hash', 'ADMIN')");
            executeUpdate(c, "INSERT INTO workspaces (id, name, owner_id) VALUES ('" + workspaceId
                    + "'::uuid, 'upgrade-workspace', '" + userId + "'::uuid)");
            executeUpdate(c, "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ('" + workspaceId
                    + "'::uuid, '" + userId + "'::uuid, 'OWNER')");
            executeUpdate(c, "INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('" + sessionId
                    + "'::uuid, '" + workspaceId + "'::uuid, '" + userId + "'::uuid, 'upgrade-session')");
            executeUpdate(c, "INSERT INTO chat_runs (id, session_id, user_id, workspace_id, idempotency_key, "
                    + "request_hash, status) VALUES ('" + chatRunId + "'::uuid, '" + sessionId + "'::uuid, '"
                    + userId + "'::uuid, '" + workspaceId + "'::uuid, 'old-submit', 'old-hash', 'accepted')");
            executeUpdate(c, "INSERT INTO ledger_operations (id, user_id, kind, source, actor_type, status) "
                    + "VALUES ('" + operationId + "'::uuid, '" + userId
                    + "'::uuid, 'system', 'system', 'system', 'accepted')");
            executeUpdate(c, "INSERT INTO operation_items (id, operation_id, sequence, kind, source, status) "
                    + "VALUES ('" + itemId + "'::uuid, '" + operationId
                    + "'::uuid, 1, 'llm_usage', 'agent', 'completed')");
            executeUpdate(c, "INSERT INTO operation_extensions (id, item_id, extension_kind, schema_version, payload) "
                    + "VALUES ('" + UUID.randomUUID() + "'::uuid, '" + itemId
                    + "'::uuid, 'llm_usage', 1, '{\"totalTokens\": 10}'::jsonb)");
            assertEquals("n", scalarString(c,
                    "SELECT confdeltype FROM pg_constraint WHERE conname = 'fk_operation_extensions_item'"),
                    "V33 state must still declare ON DELETE SET NULL");
        }

        Flyway.configure()
                .dataSource(upgradeUrl, postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("54"))
                .load()
                .migrate();

        try (Connection c = DriverManager.getConnection(
                upgradeUrl, postgres.getUsername(), postgres.getPassword())) {
            assertEquals(1, scalarInt(c, "SELECT count(*) FROM flyway_schema_history "
                    + "WHERE version = '41' AND success = true"), "V41 must be applied on upgrade");
            assertEquals(1, scalarInt(c, "SELECT count(*) FROM flyway_schema_history "
                    + "WHERE version = '42' AND success = true"), "V42 must backfill on upgrade");
            assertEquals("user_submission", scalarString(c,
                    "SELECT origin FROM chat_runs WHERE id = '" + chatRunId + "'::uuid"),
                    "legacy ChatRuns must be backfilled as user submissions");
            assertNull(scalarString(c, "SELECT kind FROM sessions WHERE id = '" + sessionId + "'::uuid"),
                    "legacy root sessions remain un-derived");
            String principalId = scalarString(c,
                    "SELECT agent_principal_id::text FROM sessions WHERE id = '" + sessionId + "'::uuid");
            assertTrue(principalId != null && !principalId.isBlank(),
                    "a ChatRun root Session must be backfilled to a stable principal");
            assertEquals("upgrade-session", scalarString(c,
                    "SELECT name FROM agent_principals WHERE id = '" + principalId + "'::uuid"));
            assertEquals(1, scalarInt(c, "SELECT count(*) FROM workspace_agents WHERE principal_id = '"
                    + principalId + "'::uuid AND workspace_id = '" + workspaceId + "'::uuid"));
            assertEquals(scalarString(c, "SELECT permissions::text FROM grants WHERE subject_type = 'agent_principal' "
                    + "AND subject_id = '" + principalId + "'::uuid AND source = 'default'"),
                    scalarString(c, "SELECT agent_permissions_snapshot::text FROM sessions WHERE id = '"
                            + sessionId + "'::uuid"));
            UUID forkSessionId = UUID.randomUUID();
            executeUpdate(c, "INSERT INTO sessions (id, workspace_id, user_id, title, spawned_from_session_id, "
                    + "spawned_from_run_id, spawned_at, kind) VALUES ('" + forkSessionId + "'::uuid, '"
                    + workspaceId + "'::uuid, '" + userId + "'::uuid, 'fork-session', '" + sessionId
                    + "'::uuid, '" + chatRunId + "'::uuid, NOW(), 'fork')");
            assertEquals("fork", scalarString(c,
                    "SELECT kind FROM sessions WHERE id = '" + forkSessionId + "'::uuid"));
            assertEquals(1, scalarInt(c, "SELECT count(*) FROM grants WHERE source = 'default' "
                    + "AND subject_type = 'user' AND subject_id = '" + userId + "'::uuid"),
                    "V41 must bootstrap one default user grant");
            assertEquals(1, scalarInt(c, "SELECT count(*) FROM grants WHERE source = 'default' "
                    + "AND subject_type = 'agent_principal' AND subject_id = '" + principalId + "'::uuid"),
                    "V42 must move the root Agent default grant to its stable principal");
            assertEquals(0, scalarInt(c, "SELECT count(*) FROM grants WHERE subject_type = 'agent'"),
                    "V42 must leave no Session UUID Agent grant subjects");
            assertEquals(1, scalarInt(c, "SELECT count(*) FROM grants WHERE source = 'default' "
                    + "AND subject_type = 'user' AND subject_id = '" + adminId + "'::uuid "
                    + "AND permissions @> '[{\"actionClass\":\"credential\"}]'::jsonb"),
                    "the ADMIN default matrix includes credential permission");
            assertEquals(0, scalarInt(c, "SELECT count(*) FROM grants WHERE source = 'default' "
                    + "AND subject_type IN ('user', 'agent_principal') "
                    + "AND subject_id IN ('" + userId + "'::uuid, '" + principalId + "'::uuid) "
                    + "AND permissions @> '[{\"actionClass\":\"credential\"}]'::jsonb"),
                    "USER and Agent defaults must omit credential permission");
            assertEquals(3, scalarInt(c, "SELECT count(*) FROM audit_logs "
                    + "WHERE action = 'authorization_default_grant_backfilled'"),
                    "V41 backfilled default grants must be audited");
            assertEquals(1, scalarInt(c, "SELECT count(*) FROM audit_logs "
                    + "WHERE action = 'agent_principal_backfilled' AND user_id IS NULL "
                    + "AND workspace_id = '" + workspaceId + "'::uuid"),
                    "V42 principal backfill must be durably audited as a system migration");
            assertThrows(SQLException.class, () -> executeUpdate(c,
                    "INSERT INTO sessions (id, workspace_id, user_id, title, spawned_from_session_id) "
                            + "VALUES ('" + UUID.randomUUID() + "'::uuid, '" + workspaceId + "'::uuid, '"
                            + userId + "'::uuid, 'partial-provenance', '" + sessionId + "'::uuid)"),
                    "provenance fields must be all-null or all-present");
            assertEquals(1, scalarInt(c, "SELECT count(*) FROM operation_extensions WHERE item_id = '"
                    + itemId + "'::uuid"), "existing extension rows must survive the upgrade");
            assertEquals("c", scalarString(c,
                    "SELECT confdeltype FROM pg_constraint WHERE conname = 'fk_operation_extensions_item'"),
                    "delete rule must be CASCADE after the upgrade");
            executeUpdate(c, "DELETE FROM operation_items WHERE id = '" + itemId + "'::uuid");
            assertEquals(0, scalarInt(c, "SELECT count(*) FROM operation_extensions WHERE item_id = '"
                    + itemId + "'::uuid"), "post-upgrade item delete must cascade the extension");

            UUID childSessionA = UUID.randomUUID();
            UUID childSessionB = UUID.randomUUID();
            UUID spawnEventId = UUID.randomUUID();
            executeUpdate(c, "INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('" + childSessionA
                    + "'::uuid, '" + workspaceId + "'::uuid, '" + userId + "'::uuid, 'spawn-a')");
            executeUpdate(c, "INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('" + childSessionB
                    + "'::uuid, '" + workspaceId + "'::uuid, '" + userId + "'::uuid, 'spawn-b')");
            // PLAN-0410 V43: chat_runs.branch_id is NOT NULL. Raw SQL bypasses
            // the JPA root-branch bootstrap (production Session writes run
            // through Session @PostPersist), so the fixture adds the root rows.
            UUID branchA = UUID.randomUUID();
            UUID branchB = UUID.randomUUID();
            executeUpdate(c, "INSERT INTO session_branches (id, session_id, created_at) VALUES ('"
                    + branchA + "'::uuid, '" + childSessionA + "'::uuid, NOW())");
            executeUpdate(c, "INSERT INTO session_branches (id, session_id, created_at) VALUES ('"
                    + branchB + "'::uuid, '" + childSessionB + "'::uuid, NOW())");
            executeUpdate(c, "INSERT INTO chat_runs (id, session_id, user_id, workspace_id, idempotency_key, "
                    + "request_hash, status, origin, branch_id) VALUES ('" + UUID.randomUUID() + "'::uuid, '" + childSessionA
                    + "'::uuid, '" + userId + "'::uuid, '" + workspaceId + "'::uuid, '" + spawnEventId
                    + "', 'spawn-hash', 'accepted', 'spawn', '" + branchA + "'::uuid)");
            assertThrows(SQLException.class, () -> executeUpdate(c,
                    "INSERT INTO chat_runs (id, session_id, user_id, workspace_id, idempotency_key, "
                            + "request_hash, status, origin, branch_id) VALUES ('" + UUID.randomUUID() + "'::uuid, '"
                            + childSessionB + "'::uuid, '" + userId + "'::uuid, '" + workspaceId
                            + "'::uuid, '" + spawnEventId
                            + "', 'spawn-hash', 'accepted', 'spawn', '" + branchB + "'::uuid)"),
                    "the partial unique index must deduplicate one parent event across child sessions");
        }
    }

    /**
     * PLAN-0407 V44 delta-only self-check: the three V42 structures delivered
     * by PLAN-0374 must remain byte-for-byte intact after V44 (stable UUID
     * principal key, restricted Session principal FK, dedicated Workspace
     * binding table with its composite key and both foreign keys).
     */
    private static void assertV42PrincipalStructuresIntact(Connection c) throws SQLException {
        assertEquals("uuid", scalarString(c,
                "SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'agent_principals' AND column_name = 'id'"),
                "V44 must not rebuild agent_principals.id");
        assertEquals(1, scalarInt(c,
                "SELECT count(*) FROM pg_constraint WHERE conname = 'agent_principals_pkey' AND contype = 'p'"),
                "V44 must not rebuild the agent_principals primary key");
        assertEquals("YES", scalarString(c,
                "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'sessions' AND column_name = 'agent_principal_id'"),
                "V44 must not touch sessions.agent_principal_id");
        assertEquals(1, scalarInt(c,
                "SELECT count(*) FROM pg_constraint WHERE conname = 'fk_sessions_agent_principal' "
                        + "AND contype = 'f' AND confdeltype = 'r'"),
                "V44 must keep the restricted sessions->agent_principals FK");
        assertEquals(1, scalarInt(c,
                "SELECT count(*) FROM pg_constraint WHERE conname = 'pk_workspace_agents' AND contype = 'p'"),
                "V44 must not rebuild the workspace_agents composite key");
        assertEquals(2, scalarInt(c,
                "SELECT count(*) FROM pg_constraint WHERE conname IN "
                        + "('fk_workspace_agents_principal', 'fk_workspace_agents_workspace') AND contype = 'f'"),
                "V44 must keep both workspace_agents foreign keys");
    }

    private static void assertV44DeltaColumns(Connection c) throws SQLException {
        assertEquals("uuid", scalarString(c,
                "SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'operation_items' AND column_name = 'waiting_on_run_id'"),
                "operation_items.waiting_on_run_id must be a UUID column");
        assertEquals("YES", scalarString(c,
                "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'operation_items' AND column_name = 'waiting_on_run_id'"),
                "the waiting link must be the single nullable durable field");
        assertEquals("timestamp with time zone", scalarString(c,
                "SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'chat_runs' AND column_name = 'terminal_at'"),
                "chat_runs.terminal_at must be a TIMESTAMPTZ column");
        assertEquals("YES", scalarString(c,
                "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'chat_runs' AND column_name = 'terminal_at'"),
                "pre-V44 runs must keep terminal_at NULL until a terminal transaction writes it");
    }

    private static UUID insertV44Fixture(Connection c, UUID userId, String label) throws SQLException {
        UUID workspaceId = UUID.randomUUID();
        UUID sessionId = UUID.randomUUID();
        UUID branchId = UUID.randomUUID();
        UUID runId = UUID.randomUUID();
        executeUpdate(c, "INSERT INTO workspaces (id, name, owner_id) VALUES ('" + workspaceId
                + "'::uuid, '" + label + "-ws', '" + userId + "'::uuid)");
        executeUpdate(c, "INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('" + sessionId
                + "'::uuid, '" + workspaceId + "'::uuid, '" + userId + "'::uuid, '" + label + "-session')");
        executeUpdate(c, "INSERT INTO session_branches (id, session_id, created_at) VALUES ('" + branchId
                + "'::uuid, '" + sessionId + "'::uuid, NOW())");
        executeUpdate(c, "INSERT INTO chat_runs (id, session_id, user_id, workspace_id, idempotency_key, "
                + "request_hash, status, origin, branch_id) VALUES ('" + runId + "'::uuid, '" + sessionId
                + "'::uuid, '" + userId + "'::uuid, '" + workspaceId + "'::uuid, '" + label + "-run', '"
                + label + "-hash', 'accepted', 'user_submission', '" + branchId + "'::uuid)");
        return runId;
    }

    @Test
    void freshChainKeepsTerminalAndChatRunWaitingFields() throws SQLException {
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '55' AND success = true"),
                "V55 must be recorded as applied on the fresh chain");
        String indexDef = scalarString(
                "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' "
                        + "AND indexname = 'idx_chat_runs_waiting_on_run'");
        assertTrue(indexDef.contains("waiting_on_run_id IS NOT NULL"),
                "the waiting link lookup index must be partial: " + indexDef);
        assertV42PrincipalStructuresIntact(connection);

        UUID userId = UUID.randomUUID();
        executeUpdate("INSERT INTO users (id, email, password_hash) VALUES ('" + userId
                + "'::uuid, 'v44-fresh-" + userId + "@test.local', 'hash')");
        UUID runId = insertV44Fixture(connection, userId, "v44-fresh");
        assertEquals(0, scalarInt("SELECT count(*) FROM chat_runs WHERE id = '" + runId
                        + "'::uuid AND terminal_at IS NOT NULL"),
                "terminal_at must default to NULL on the fresh chain");

        assertEquals(0, scalarInt("SELECT count(*) FROM chat_runs WHERE id = '" + runId
                        + "'::uuid AND waiting_on_run_id IS NOT NULL"),
                "ChatRun waiting link must default to NULL on the fresh chain");

        executeUpdate("UPDATE chat_runs SET terminal_at = '2026-09-25T10:20:30+00:00'::timestamptz "
                + "WHERE id = '" + runId + "'::uuid");
        assertEquals(1, scalarInt("SELECT count(*) FROM chat_runs WHERE id = '" + runId
                        + "'::uuid AND terminal_at = '2026-09-25T10:20:30+00:00'::timestamptz"),
                "terminal_at must round-trip a TIMESTAMPTZ value");
        UUID parentRunId = UUID.randomUUID();
        executeUpdate("UPDATE chat_runs SET waiting_on_run_id = '" + parentRunId
                + "'::uuid WHERE id = '" + runId + "'::uuid");
        assertEquals(1, scalarInt("SELECT count(*) FROM chat_runs WHERE id = '" + runId
                        + "'::uuid AND waiting_on_run_id = '" + parentRunId + "'::uuid"),
                "ChatRun waiting link must round-trip its parent run id");
    }

    @Test
    void v43ToV44UpgradeAddsDeltaColumnsWithoutRebuildingV42() throws SQLException {
        String upgradeDb = "xihe_cp_upgrade_v44";
        String adminUrl = postgres.getJdbcUrl();
        try (Connection admin = DriverManager.getConnection(
                adminUrl, postgres.getUsername(), postgres.getPassword());
             Statement statement = admin.createStatement()) {
            statement.executeUpdate("DROP DATABASE IF EXISTS " + upgradeDb);
            statement.executeUpdate("CREATE DATABASE " + upgradeDb);
        }
        String upgradeUrl = adminUrl.replace("/" + postgres.getDatabaseName(), "/" + upgradeDb);

        Flyway.configure()
                .dataSource(upgradeUrl, postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("43"))
                .load()
                .migrate();

        UUID userId = UUID.randomUUID();
        UUID runId;
        UUID operationId = UUID.randomUUID();
        UUID itemId = UUID.randomUUID();
        try (Connection c = DriverManager.getConnection(
                upgradeUrl, postgres.getUsername(), postgres.getPassword())) {
            assertEquals(0, scalarInt(c, "SELECT count(*) FROM information_schema.columns "
                            + "WHERE table_schema = 'public' AND table_name = 'operation_items' "
                            + "AND column_name = 'waiting_on_run_id'"),
                    "V43 must not contain the waiting link column yet");
            assertEquals(0, scalarInt(c, "SELECT count(*) FROM information_schema.columns "
                            + "WHERE table_schema = 'public' AND table_name = 'chat_runs' "
                            + "AND column_name = 'terminal_at'"),
                    "V43 must not contain the terminal timestamp column yet");
            assertV42PrincipalStructuresIntact(c);

            executeUpdate(c, "INSERT INTO users (id, email, password_hash) VALUES ('" + userId
                    + "'::uuid, 'v44-upgrade-" + userId + "@test.local', 'hash')");
            runId = insertV44Fixture(c, userId, "v44-upgrade");
            executeUpdate(c, "INSERT INTO ledger_operations (id, user_id, kind, source, actor_type, status) "
                    + "VALUES ('" + operationId + "'::uuid, '" + userId
                    + "'::uuid, 'system', 'system', 'system', 'accepted')");
            executeUpdate(c, "INSERT INTO operation_items (id, operation_id, sequence, kind, source, status) "
                    + "VALUES ('" + itemId + "'::uuid, '" + operationId
                    + "'::uuid, 1, 'llm_usage', 'agent', 'completed')");
        }

        Flyway.configure()
                .dataSource(upgradeUrl, postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("44"))
                .load()
                .migrate();

        try (Connection c = DriverManager.getConnection(
                upgradeUrl, postgres.getUsername(), postgres.getPassword())) {
            assertEquals(1, scalarInt(c, "SELECT count(*) FROM flyway_schema_history "
                            + "WHERE version = '44' AND success = true"),
                    "V44 must be recorded as applied on the upgrade chain");
            assertV44DeltaColumns(c);
            assertEquals(1, scalarInt(c, "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' "
                            + "AND indexname = 'idx_operation_items_waiting_on_run'"),
                    "the partial waiting link index must exist after the upgrade");
            assertV42PrincipalStructuresIntact(c);

            assertEquals(1, scalarInt(c, "SELECT count(*) FROM chat_runs WHERE id = '" + runId
                            + "'::uuid AND terminal_at IS NULL"),
                    "pre-V44 runs must keep terminal_at NULL after the upgrade");
            assertEquals(1, scalarInt(c, "SELECT count(*) FROM operation_items WHERE id = '" + itemId
                            + "'::uuid AND waiting_on_run_id IS NULL"),
                    "pre-V44 items must keep waiting_on_run_id NULL after the upgrade");

            executeUpdate(c, "UPDATE chat_runs SET terminal_at = '2026-09-25T11:22:33+00:00'::timestamptz "
                    + "WHERE id = '" + runId + "'::uuid");
            assertEquals(1, scalarInt(c, "SELECT count(*) FROM chat_runs WHERE id = '" + runId
                            + "'::uuid AND terminal_at = '2026-09-25T11:22:33+00:00'::timestamptz"),
                    "terminal_at must round-trip on the upgraded database");
            executeUpdate(c, "UPDATE operation_items SET waiting_on_run_id = '" + runId
                    + "'::uuid WHERE id = '" + itemId + "'::uuid");
            assertEquals(1, scalarInt(c, "SELECT count(*) FROM operation_items WHERE id = '" + itemId
                            + "'::uuid AND waiting_on_run_id = '" + runId + "'::uuid"),
                    "waiting_on_run_id must round-trip on the upgraded database");
        }
    }
}
