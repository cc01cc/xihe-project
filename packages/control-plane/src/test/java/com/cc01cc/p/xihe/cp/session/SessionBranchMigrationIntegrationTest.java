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
 * PLAN-0410 T1.1: V43 Session branch migration on real PostgreSQL.
 *
 * <p>Covers the two mandated paths (fresh V1→V43 chain and V42→V43 upgrade),
 * the backfill accounting (one root per Session, historical rows on root,
 * selective payload-runId double verification, global events untouched), the
 * unique-key migration (old UNIQUE (session_id) dropped, new
 * (session_id, projection_type, branch_id) key allows multiple projections per
 * Session), the negative FK/unique cases, and transaction rollback on failure.
 *
 * <p>Follows {@code AgentPrincipalMigrationTest}: programmatic Flyway against
 * throwaway databases, no hand-written parallel DDL for the schema under test.
 */
@Testcontainers
class SessionBranchMigrationIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_branch")
            .withUsername("test")
            .withPassword("test");

    // ------------------------------------------------------------------
    // fresh path
    // ------------------------------------------------------------------

    @Test
    void freshV43CreatesBranchSchemaAndStoresMultipleProjectionsPerSession() throws SQLException {
        String jdbcUrl = createDatabase("xihe_cp_branch_fresh");
        migrateToCurrent(jdbcUrl);
        migrateToCurrent(jdbcUrl);

        try (Connection connection = connect(jdbcUrl)) {
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history "
                    + "WHERE version = '43' AND success"),
                    "V43 must be recorded as applied on the fresh chain");
            assertNotNull(scalarString(connection, "SELECT to_regclass('public.session_branches')"),
                    "session_branches must exist after V43");
            assertEquals(0, scalarInt(connection,
                    "SELECT count(*) FROM session_branches"),
                    "a fresh migration runs before any Session exists");

            // unique-key migration (spec §6 step 4 / field-matrix §2 #7)
            assertEquals(0, scalarInt(connection,
                    "SELECT count(*) FROM pg_constraint WHERE conname = 'uq_context_projections_session'"),
                    "the V1 UNIQUE (session_id) must be dropped");
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM pg_constraint "
                            + "WHERE conname = 'uq_context_projections_session_type_branch' AND contype = 'u'"),
                    "the (session_id, projection_type, branch_id) unique must exist");

            // required columns (Hibernate validate reads these)
            for (String[] column : new String[][]{
                    {"messages", "branch_id"}, {"chat_runs", "branch_id"},
                    {"context_projections", "branch_id"}}) {
                assertEquals("NO", scalarString(connection,
                        "SELECT is_nullable FROM information_schema.columns "
                                + "WHERE table_schema = 'public' AND table_name = '" + column[0]
                                + "' AND column_name = '" + column[1] + "'"),
                        column[0] + "." + column[1] + " must exist and be NOT NULL");
            }
            assertEquals("YES", scalarString(connection,
                    "SELECT is_nullable FROM information_schema.columns "
                            + "WHERE table_schema = 'public' AND table_name = 'context_events' "
                            + "AND column_name = 'branch_id'"),
                    "context_events.branch_id must stay nullable for global facts");

            // matrix uniques/indexes and delete rules
            String rootIndex = scalarString(connection,
                    "SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_session_branches_root'");
            assertTrue(rootIndex.contains("parent_branch_id IS NULL"), rootIndex);
            String idempotencyIndex = scalarString(connection,
                    "SELECT indexdef FROM pg_indexes "
                            + "WHERE indexname = 'uq_session_branches_request_idempotency'");
            assertTrue(idempotencyIndex.contains("idempotency_key IS NOT NULL"), idempotencyIndex);
            assertEquals(3, scalarInt(connection,
                    "SELECT count(*) FROM pg_indexes WHERE indexname IN "
                            + "('idx_messages_session_branch_run', "
                            + "'idx_context_events_session_branch_sequence', "
                            + "'idx_context_events_session_correlation')"),
                    "all matrix indexes must exist");
            for (String fk : new String[]{
                    "fk_session_branches_session", "fk_session_branches_parent",
                    "fk_messages_session_branch", "fk_chat_runs_session_branch",
                    "fk_context_events_session_branch", "fk_context_projections_session_branch"}) {
                assertEquals("c", scalarString(connection,
                        "SELECT confdeltype FROM pg_constraint WHERE conname = '" + fk + "'"),
                        fk + " must be ON DELETE CASCADE");
            }
            for (String fk : new String[]{
                    "fk_session_branches_anchor_message", "fk_session_branches_anchor_run"}) {
                assertEquals("r", scalarString(connection,
                        "SELECT confdeltype FROM pg_constraint WHERE conname = '" + fk + "'"),
                        fk + " must keep the parent anchor (ON DELETE RESTRICT)");
            }

            // behavior: root + child branches allow several projections for one Session
            UUID userId = UUID.randomUUID();
            UUID workspaceId = UUID.randomUUID();
            UUID sessionId = UUID.randomUUID();
            execute(connection, "INSERT INTO users (id, email, password_hash) VALUES ('" + userId
                    + "'::uuid, 'branch-fresh-" + userId + "@test.local', 'hash')");
            execute(connection, "INSERT INTO workspaces (id, name, owner_id) VALUES ('" + workspaceId
                    + "'::uuid, 'branch-fresh-ws', '" + userId + "'::uuid)");
            execute(connection, "INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('"
                    + sessionId + "'::uuid, '" + workspaceId + "'::uuid, '" + userId
                    + "'::uuid, 'fresh-session')");

            UUID rootId = UUID.randomUUID();
            execute(connection, "INSERT INTO session_branches (id, session_id, created_at) VALUES ('"
                    + rootId + "'::uuid, '" + sessionId + "'::uuid, NOW())");
            UUID runId = UUID.randomUUID();
            execute(connection, "INSERT INTO chat_runs (id, session_id, user_id, workspace_id, "
                    + "idempotency_key, request_hash, status, origin, branch_id) VALUES ('" + runId
                    + "'::uuid, '" + sessionId + "'::uuid, '" + userId + "'::uuid, '" + workspaceId
                    + "'::uuid, 'fresh-run', '" + "a".repeat(64) + "', 'accepted', 'user_submission', '"
                    + rootId + "'::uuid)");
            UUID messageId = UUID.randomUUID();
            execute(connection, "INSERT INTO messages (id, session_id, run_id, role, content, branch_id) "
                    + "VALUES ('" + messageId + "'::uuid, '" + sessionId + "'::uuid, '" + runId
                    + "'::uuid, 'USER', 'hello', '" + rootId + "'::uuid)");

            UUID childId = UUID.randomUUID();
            execute(connection, "INSERT INTO session_branches (id, session_id, parent_branch_id, "
                    + "fork_point_message_id, fork_point_run_id, fork_point_sequence, idempotency_key, "
                    + "request_hash, created_at) VALUES ('" + childId + "'::uuid, '" + sessionId
                    + "'::uuid, '" + rootId + "'::uuid, '" + messageId + "'::uuid, '" + runId
                    + "'::uuid, 1, 'branch-idem-1', '" + "b".repeat(64) + "', NOW())");

            insertProjection(connection, UUID.randomUUID(), sessionId, workspaceId, userId, rootId);
            insertProjection(connection, UUID.randomUUID(), sessionId, workspaceId, userId, childId);
            assertEquals(2, scalarInt(connection,
                    "SELECT count(*) FROM context_projections WHERE session_id = '" + sessionId + "'::uuid"),
                    "one Session must store a projection per branch after the old unique is dropped");

            SQLException duplicateProjection = assertThrows(SQLException.class,
                    () -> insertProjection(connection, UUID.randomUUID(), sessionId, workspaceId,
                            userId, childId));
            assertTrue(duplicateProjection.getMessage()
                    .contains("uq_context_projections_session_type_branch"), duplicateProjection.getMessage());

            SQLException duplicateRoot = assertThrows(SQLException.class,
                    () -> execute(connection, "INSERT INTO session_branches (id, session_id, created_at) "
                            + "VALUES ('" + UUID.randomUUID() + "'::uuid, '" + sessionId + "'::uuid, NOW())"));
            assertTrue(duplicateRoot.getMessage().contains("uq_session_branches_root"),
                    duplicateRoot.getMessage());

            SQLException duplicateIdempotency = assertThrows(SQLException.class,
                    () -> execute(connection, "INSERT INTO session_branches (id, session_id, "
                            + "parent_branch_id, fork_point_message_id, fork_point_run_id, "
                            + "fork_point_sequence, idempotency_key, request_hash, created_at) VALUES ('"
                            + UUID.randomUUID() + "'::uuid, '" + sessionId + "'::uuid, '" + rootId
                            + "'::uuid, '" + messageId + "'::uuid, '" + runId + "'::uuid, 2, "
                            + "'branch-idem-1', '" + "c".repeat(64) + "', NOW())"));
            assertTrue(duplicateIdempotency.getMessage()
                    .contains("uq_session_branches_request_idempotency"), duplicateIdempotency.getMessage());

            // runless anchors are not anchorable (anchor FK requires the run binding)
            UUID runlessMessageId = UUID.randomUUID();
            execute(connection, "INSERT INTO messages (id, session_id, role, content, branch_id) "
                    + "VALUES ('" + runlessMessageId + "'::uuid, '" + sessionId
                    + "'::uuid, 'ASSISTANT', 'legacy', '" + rootId + "'::uuid)");
            SQLException runlessAnchor = assertThrows(SQLException.class,
                    () -> execute(connection, "INSERT INTO session_branches (id, session_id, "
                            + "parent_branch_id, fork_point_message_id, fork_point_run_id, "
                            + "fork_point_sequence, idempotency_key, request_hash, created_at) VALUES ('"
                            + UUID.randomUUID() + "'::uuid, '" + sessionId + "'::uuid, '" + rootId
                            + "'::uuid, '" + runlessMessageId + "'::uuid, '" + runId + "'::uuid, 3, "
                            + "'branch-idem-2', '" + "d".repeat(64) + "', NOW())"));
            assertTrue(runlessAnchor.getMessage().contains("fk_session_branches_anchor_message"),
                    runlessAnchor.getMessage());
        }
    }

    // ------------------------------------------------------------------
    // upgrade path: V42 -> V43
    // ------------------------------------------------------------------

    @Test
    void upgradeV42ToV43BackfillsRootsHistoryAndSelectiveCorrelation() throws SQLException {
        String jdbcUrl = createDatabase("xihe_cp_branch_upgrade");
        migrateToVersion(jdbcUrl, "40");

        UUID userId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        UUID sessionA = UUID.randomUUID();
        UUID sessionB = UUID.randomUUID();
        UUID runId = UUID.randomUUID();
        UUID linkedMessageId = UUID.randomUUID();
        try (Connection connection = connect(jdbcUrl)) {
            execute(connection, "INSERT INTO users (id, email, password_hash) VALUES ('" + userId
                    + "'::uuid, 'branch-upgrade-" + userId + "@test.local', 'hash')");
            execute(connection, "INSERT INTO workspaces (id, name, owner_id) VALUES ('" + workspaceId
                    + "'::uuid, 'branch-upgrade-ws', '" + userId + "'::uuid)");
            execute(connection, "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ('"
                    + workspaceId + "'::uuid, '" + userId + "'::uuid, 'OWNER')");
            execute(connection, "INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('"
                    + sessionA + "'::uuid, '" + workspaceId + "'::uuid, '" + userId
                    + "'::uuid, 'session-a')");
            execute(connection, "INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('"
                    + sessionB + "'::uuid, '" + workspaceId + "'::uuid, '" + userId
                    + "'::uuid, 'session-b')");
            execute(connection, "INSERT INTO chat_runs (id, session_id, user_id, workspace_id, "
                    + "idempotency_key, request_hash, status, origin) VALUES ('" + runId
                    + "'::uuid, '" + sessionA + "'::uuid, '" + userId + "'::uuid, '" + workspaceId
                    + "'::uuid, 'upgrade-run', '" + "a".repeat(64) + "', 'succeeded', 'user_submission')");
            execute(connection, "INSERT INTO messages (id, session_id, run_id, role, content) VALUES ('"
                    + linkedMessageId + "'::uuid, '" + sessionA + "'::uuid, '" + runId
                    + "'::uuid, 'USER', 'linked')");
            UUID runlessMessageId = UUID.randomUUID();
            execute(connection, "INSERT INTO messages (id, session_id, role, content) VALUES ('"
                    + runlessMessageId + "'::uuid, '" + sessionA + "'::uuid, 'ASSISTANT', 'runless')");

            // legacy events: unverifiable run-scoped, double-verified payload
            // runId, global, and a payload runId that does not resolve
            insertEvent(connection, sessionA, workspaceId, userId, 1, "prompt.admitted",
                    "{\"message\":{\"role\":\"human\",\"content\":\"hi\"}}");
            insertEvent(connection, sessionA, workspaceId, userId, 2, "assistant.responded",
                    "{\"runId\":\"" + runId + "\",\"message\":{\"role\":\"ai\",\"content\":\"ok\"}}");
            insertEvent(connection, sessionA, workspaceId, userId, 3, "context.source_changed",
                    "{\"status\":\"updated\",\"source_hash\":\"h\"}");
            insertEvent(connection, sessionA, workspaceId, userId, 4, "context.prune",
                    "{\"runId\":\"" + UUID.randomUUID() + "\",\"pruned_count\":1}");
            // payload runId of a Run that lives in another Session (double
            // verification must fail: same-Session predicate)
            insertEvent(connection, sessionB, workspaceId, userId, 1, "prompt.admitted",
                    "{\"runId\":\"" + runId + "\",\"message\":{\"role\":\"human\",\"content\":\"x\"}}");

            insertProjection(connection, UUID.randomUUID(), sessionA, workspaceId, userId, null);
        }

        migrateToVersion(jdbcUrl, "41");
        migrateToVersion(jdbcUrl, "42");

        try (Connection connection = connect(jdbcUrl)) {
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM pg_constraint WHERE conname = 'uq_context_projections_session'"),
                    "the V1 UNIQUE (session_id) must still be active before V43");
            assertEquals(0, scalarInt(connection,
                    "SELECT count(*) FROM information_schema.columns "
                            + "WHERE table_name = 'messages' AND column_name = 'branch_id'"),
                    "messages.branch_id must not exist before V43");
        }

        migrateToCurrent(jdbcUrl);
        migrateToCurrent(jdbcUrl);

        try (Connection connection = connect(jdbcUrl)) {
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM flyway_schema_history WHERE version = '43' AND success"));

            // one root per Session, complete root field group
            assertEquals(2, scalarInt(connection,
                    "SELECT count(*) FROM session_branches WHERE parent_branch_id IS NULL"),
                    "every legacy Session gets exactly one root branch");
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM session_branches WHERE session_id = '" + sessionA
                            + "'::uuid AND parent_branch_id IS NULL AND fork_point_message_id IS NULL "
                            + "AND fork_point_run_id IS NULL AND fork_point_sequence IS NULL "
                            + "AND idempotency_key IS NULL AND request_hash IS NULL"),
                    "the root row carries no anchor and no idempotency key");

            String rootA = scalarString(connection, "SELECT id::text FROM session_branches "
                    + "WHERE session_id = '" + sessionA + "'::uuid AND parent_branch_id IS NULL");
            String rootB = scalarString(connection, "SELECT id::text FROM session_branches "
                    + "WHERE session_id = '" + sessionB + "'::uuid AND parent_branch_id IS NULL");

            // historical rows backfilled to their Session root
            assertEquals(rootA, scalarString(connection, "SELECT branch_id::text FROM messages "
                    + "WHERE id = '" + linkedMessageId + "'::uuid"), "linked message → root");
            assertEquals(2, scalarInt(connection, "SELECT count(*) FROM messages WHERE session_id = '"
                    + sessionA + "'::uuid AND branch_id = '" + rootA + "'::uuid"),
                    "runless legacy messages are backfilled to the root baseline too");
            assertEquals(rootA, scalarString(connection, "SELECT branch_id::text FROM chat_runs "
                    + "WHERE id = '" + runId + "'::uuid"), "run → root");
            assertEquals(rootA, scalarString(connection, "SELECT branch_id::text FROM context_projections "
                    + "WHERE session_id = '" + sessionA + "'::uuid"), "projection → root");

            // selective correlation backfill (double verification)
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM context_events WHERE session_id = '" + sessionA
                            + "'::uuid AND sequence = 1 AND correlation_id IS NULL "
                            + "AND branch_id = '" + rootA + "'::uuid"),
                    "unverifiable run-scoped event stays on the root baseline without correlation");
            assertEquals(runId.toString(), scalarString(connection,
                    "SELECT correlation_id FROM context_events WHERE session_id = '" + sessionA
                            + "'::uuid AND sequence = 2"),
                    "payload runId verified against a same-Session Run is backfilled as correlation");
            assertEquals(rootA, scalarString(connection,
                    "SELECT branch_id::text FROM context_events WHERE session_id = '" + sessionA
                            + "'::uuid AND sequence = 2"), "verified event → root");
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM context_events WHERE session_id = '" + sessionA
                            + "'::uuid AND sequence = 3 AND correlation_id IS NULL "
                            + "AND branch_id IS NULL"),
                    "global events keep both association slots NULL");
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM context_events WHERE session_id = '" + sessionA
                            + "'::uuid AND sequence = 4 AND correlation_id IS NULL "
                            + "AND branch_id = '" + rootA + "'::uuid"),
                    "payload runId without a matching Run must not become a correlation");
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM context_events WHERE session_id = '" + sessionB
                            + "'::uuid AND sequence = 1 AND correlation_id IS NULL "
                            + "AND branch_id = '" + rootB + "'::uuid"),
                    "cross-Session payload runId fails the same-Session double verification");

            // unique-key migration + indexes
            assertEquals(0, scalarInt(connection,
                    "SELECT count(*) FROM pg_constraint WHERE conname = 'uq_context_projections_session'"),
                    "the old UNIQUE (session_id) must be dropped by V43");
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM pg_constraint "
                            + "WHERE conname = 'uq_context_projections_session_type_branch' AND contype = 'u'"));
            assertEquals(2, scalarInt(connection,
                    "SELECT count(*) FROM pg_indexes WHERE indexname IN "
                            + "('idx_context_events_session_branch_sequence', "
                            + "'idx_context_events_session_correlation')"),
                    "both context_events matrix indexes must exist");

            // negative: a second root for one Session is rejected
            SQLException duplicateRoot = assertThrows(SQLException.class,
                    () -> execute(connection, "INSERT INTO session_branches (id, session_id, created_at) "
                            + "VALUES ('" + UUID.randomUUID() + "'::uuid, '" + sessionA + "'::uuid, NOW())"));
            assertTrue(duplicateRoot.getMessage().contains("uq_session_branches_root"),
                    duplicateRoot.getMessage());

            // negative: composite branch FK rejects a branch of another Session
            SQLException crossSessionBranch = assertThrows(SQLException.class,
                    () -> execute(connection, "INSERT INTO messages (id, session_id, role, content, branch_id) "
                            + "VALUES ('" + UUID.randomUUID() + "'::uuid, '" + sessionA
                            + "'::uuid, 'USER', 'forged', '" + rootB + "'::uuid)"));
            assertTrue(crossSessionBranch.getMessage().contains("fk_messages_session_branch"),
                    crossSessionBranch.getMessage());
        }
    }

    // ------------------------------------------------------------------
    // failure rollback
    // ------------------------------------------------------------------

    @Test
    void v43FailureRollsBackDdlAndBackfill() throws SQLException {
        String jdbcUrl = createDatabase("xihe_cp_branch_rollback");
        migrateToVersion(jdbcUrl, "41");

        UUID userId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        UUID sessionId = UUID.randomUUID();
        try (Connection connection = connect(jdbcUrl)) {
            execute(connection, "INSERT INTO users (id, email, password_hash) VALUES ('" + userId
                    + "'::uuid, 'branch-rollback-" + userId + "@test.local', 'hash')");
            execute(connection, "INSERT INTO workspaces (id, name, owner_id) VALUES ('" + workspaceId
                    + "'::uuid, 'branch-rollback-ws', '" + userId + "'::uuid)");
            execute(connection, "INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('"
                    + sessionId + "'::uuid, '" + workspaceId + "'::uuid, '" + userId
                    + "'::uuid, 'rollback-session')");
            execute(connection, "INSERT INTO messages (id, session_id, role, content) VALUES ('"
                    + UUID.randomUUID() + "'::uuid, '" + sessionId + "'::uuid, 'USER', 'keep me')");
            // Injected failure inside V43's own backfill: the trigger fires on
            // the first branch_id UPDATE of the migration (session_branches does
            // not exist yet at this migration state).
            execute(connection, "CREATE FUNCTION fail_v43_backfill() RETURNS trigger "
                    + "LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected V43 backfill failure'; END $$");
            execute(connection, "CREATE TRIGGER fail_v43_backfill BEFORE UPDATE ON messages "
                    + "FOR EACH ROW EXECUTE FUNCTION fail_v43_backfill()");
        }

        assertThrows(FlywayException.class, () -> migrateToCurrent(jdbcUrl));

        try (Connection connection = connect(jdbcUrl)) {
            assertNull(scalarString(connection, "SELECT to_regclass('public.session_branches')::text"),
                    "failed V43 transaction must roll back its DDL");
            assertEquals(0, scalarInt(connection,
                    "SELECT count(*) FROM information_schema.columns "
                            + "WHERE table_name = 'messages' AND column_name = 'branch_id'"),
                    "failed V43 must not leave messages.branch_id behind");
            assertEquals(0, scalarInt(connection,
                    "SELECT count(*) FROM flyway_schema_history WHERE version = '43' AND success"));
            assertEquals(1, scalarInt(connection,
                    "SELECT count(*) FROM messages WHERE session_id = '" + sessionId + "'::uuid"),
                    "pre-existing rows must survive a failed migration");
        }
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private static void insertEvent(Connection connection, UUID sessionId, UUID workspaceId,
                                    UUID userId, long sequence, String eventType, String payload)
            throws SQLException {
        execute(connection, "INSERT INTO context_events (id, session_id, workspace_id, user_id, "
                + "event_type, sequence, payload) VALUES ('" + UUID.randomUUID() + "'::uuid, '"
                + sessionId + "'::uuid, '" + workspaceId + "'::uuid, '" + userId + "'::uuid, '"
                + eventType + "', " + sequence + ", '" + payload + "'::jsonb)");
    }

    private static void insertProjection(Connection connection, UUID id, UUID sessionId,
                                         UUID workspaceId, UUID userId, UUID branchId)
            throws SQLException {
        String branchColumn = branchId == null ? "" : ", branch_id";
        String branchValue = branchId == null ? "" : ", '" + branchId + "'::uuid";
        execute(connection, "INSERT INTO context_projections (id, session_id, workspace_id, user_id, "
                + "projection_type, latest_sequence, payload" + branchColumn + ") VALUES ('" + id
                + "'::uuid, '" + sessionId + "'::uuid, '" + workspaceId + "'::uuid, '" + userId
                + "'::uuid, 'agent_context', 0, '{}'::jsonb" + branchValue + ")");
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
        try (Statement statement = connection.createStatement(); ResultSet result = statement.executeQuery(sql)) {
            result.next();
            return result.getString(1);
        }
    }

    private static int scalarInt(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement(); ResultSet result = statement.executeQuery(sql)) {
            result.next();
            return result.getInt(1);
        }
    }
}
