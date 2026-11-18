package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * task-188 MVP⑤ S3 (V173): steer attribution columns on the EXISTING V49 FIFO.
 *
 * <p>A pure additive migration, and the assertions say so: both columns exist and are NULLABLE
 * (★ the plan's negative control — a test that merely says "no backfill" passes just as well when
 * the column is absent, so the column's existence AND its null-ability are both asserted), the
 * vocabulary CHECK is closed, and the second CHECK is an <b>implication</b>: {@code agent_steer}
 * REQUIRES {@code from_session_id}, while a human row carrying one stays legal (a future writer may
 * attribute a human follow-up to the Session that asked for it — a biconditional would need a new
 * migration to allow that).</p>
 *
 * <p>Also pinned: nothing in V49's own columns changed — the ALTER is additive, and the status CHECK
 * vocabulary is the unchanged one.</p>
 */
class FollowUpItemSourceMigrationTest {

    private static TestDatabaseProvider.DatabaseRef postgres;
    private static Connection connection;
    private String sessionId;

    @BeforeAll
    static void migrateToHeadOnAnEmptyDatabase() throws SQLException {
        postgres = TestDatabaseProvider.emptyDatabase("task188_follow_up_source");
        Flyway.configure()
                .dataSource(postgres.jdbcUrl(), postgres.username(), postgres.password())
                .locations("classpath:db/migration")
                .load()
                .migrate();
        connection = DriverManager.getConnection(
                postgres.jdbcUrl(), postgres.username(), postgres.password());
    }

    @AfterAll
    static void close() throws SQLException {
        if (connection != null) {
            connection.close();
        }
    }

    @BeforeEach
    void startFromAnEmptyQueue() throws SQLException {
        execute("DELETE FROM session_follow_up_items");
        // V49 carries a real FK to sessions (and sessions to workspaces/users), so the attribution
        // tests point at genuine rows. Walking the real chain rather than disabling constraints is
        // the point: a fixture that bypassed the FKs would say nothing about the shape V49 froze.
        sessionId = seedSession();
    }

    /** Creates user → workspace → session and returns the session id, all committed by plain SQL. */
    private String seedSession() throws SQLException {
        String userId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        String id = UUID.randomUUID().toString();
        // role was dropped in V89 (the atom/binding model replaced it) and username became
        // NOT NULL in V82 — the fixture follows the head schema, not the V1 one.
        String username = "u" + userId.replaceAll("-", "").substring(0, 12);
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + userId + "', '"
                + userId + "@example.test', 'x', '" + username + "')");
        // owner_id was dropped in V89 (ownership lives in the binding model now).
        execute("INSERT INTO workspaces (id, name) VALUES ('" + workspaceId + "', 'fixture ws')");
        // kind is NULL for an ordinary (non-derived) Session — V40's CHECK only allows spawn/fork,
        // so writing 'chat' here would be inventing a fourth value the schema rejects.
        execute("INSERT INTO sessions (id, user_id, workspace_id, title) VALUES ('" + id
                + "', '" + userId + "', '" + workspaceId + "', 'fixture session')");
        return id;
    }

    @Test
    void bothColumnsExistAndAreNullable() throws SQLException {
        assertEquals("character varying", text("SELECT data_type FROM information_schema.columns"
                + " WHERE table_name = 'session_follow_up_items' AND column_name = 'source_kind'"));
        assertEquals("uuid", text("SELECT data_type FROM information_schema.columns"
                + " WHERE table_name = 'session_follow_up_items'"
                + " AND column_name = 'from_session_id'"));
        // ★ null-ability is the property, not "we did not backfill": a NOT NULL column with a
        // default would also have "no backfill" while changing what every existing row means.
        assertEquals("YES", text("SELECT is_nullable FROM information_schema.columns"
                + " WHERE table_name = 'session_follow_up_items' AND column_name = 'source_kind'"));
        assertEquals("YES", text("SELECT is_nullable FROM information_schema.columns"
                + " WHERE table_name = 'session_follow_up_items' AND column_name = 'from_session_id'"));
        // expected_revision is the advisory echo column (D-1830). It exists as its OWN column, not
        // as a key inside tool_timeouts: that document is a tool-name-to-seconds map admission
        // actually reads, so parking it there would impersonate a tool named "expectedRevision".
        assertEquals("integer", text("SELECT data_type FROM information_schema.columns"
                + " WHERE table_name = 'session_follow_up_items'"
                + " AND column_name = 'expected_revision'"));
        assertEquals("YES", text("SELECT is_nullable FROM information_schema.columns"
                + " WHERE table_name = 'session_follow_up_items'"
                + " AND column_name = 'expected_revision'"));
    }

    @Test
    void noDefaultIsStampedOnTheNewColumn() throws SQLException {
        assertEquals(null, text("SELECT column_default FROM information_schema.columns"
                + " WHERE table_name = 'session_follow_up_items' AND column_name = 'source_kind'"),
                "NULL means 'no attribution', not 'human' — a default would rewrite history");
    }

    @Test
    void anAgentSteerWithoutASourceSessionIsRefused() throws SQLException {
        SQLException refused = assertThrows(SQLException.class,
                () -> insert("agent_steer", null));
        assertEquals("23514", refused.getSQLState(), "implication CHECK violation");
    }

    @Test
    void anAgentSteerWithASourceSessionAndAPlainNullHumanRowAreBothAccepted() throws SQLException {
        insert("agent_steer", UUID.randomUUID().toString());
        execute("DELETE FROM session_follow_up_items");
        insert(null, null);
        execute("DELETE FROM session_follow_up_items");
        insert("human", null);
    }

    @Test
    void aHumanRowMayCarryASourceSessionBecauseTheCheckIsAnImplication() throws SQLException {
        // A biconditional would refuse this. The implication deliberately allows it: a future writer
        // might attribute a human Follow-up to the Session that asked for it, and that must not
        // require a migration to unblock.
        insert("human", UUID.randomUUID().toString());
    }

    @Test
    void aNegativeExpectedRevisionIsRefusedButZeroIsAccepted() throws SQLException {
        insertWithExpectedRevision(0);
        execute("DELETE FROM session_follow_up_items");
        SQLException refused = assertThrows(SQLException.class,
                () -> insertWithExpectedRevision(-1));
        assertEquals("23514", refused.getSQLState());
    }

    @Test
    void anUnknownAttributionValueIsRefused() throws SQLException {
        SQLException refused = assertThrows(SQLException.class, () -> insert("steer", null));
        assertEquals("23514", refused.getSQLState(), "closed vocabulary");
    }

    @Test
    void theExistingFifoShapeAndVocabularyAreUnchanged() throws SQLException {
        // Additive means additive: V49's status vocabulary still refuses an unknown value and still
        // accepts all five, and the capacity-relevant columns are untouched.
        for (String status : new String[] {"queued", "paused", "admitted", "completed", "withdrawn"}) {
            insertWithStatus(status);
            execute("DELETE FROM session_follow_up_items");
        }
        SQLException refused = assertThrows(SQLException.class, () -> insertWithStatus("sideways"));
        assertEquals("23514", refused.getSQLState());
        assertNotNull(text("SELECT data_type FROM information_schema.columns"
                + " WHERE table_name = 'session_follow_up_items' AND column_name = 'queue_sequence'"),
                "V49's queue_sequence survived the ALTER");
    }

    private void insert(String sourceKind, String fromSession) throws SQLException {
        insertWithStatusAndAttribution("queued", sourceKind, fromSession, null);
    }

    private void insertWithExpectedRevision(Integer expectedRevision) throws SQLException {
        insertWithStatusAndAttribution("queued", "agent_steer", sessionId, expectedRevision);
    }

    private void insertWithStatus(String status) throws SQLException {
        insertWithStatusAndAttribution(status, null, null, null);
    }

    private void insertWithStatusAndAttribution(String status, String sourceKind,
                                                String fromSession, Integer expectedRevision)
            throws SQLException {
        execute("INSERT INTO session_follow_up_items (id, session_id, queue_sequence,"
                + " idempotency_key, request_hash, branch_id, status, source_kind, from_session_id,"
                + " expected_revision)"
                + " VALUES (gen_random_uuid(), '" + sessionId + "', 1, 'key-" + UUID.randomUUID()
                + "', 'hash', gen_random_uuid(), '" + status + "', "
                + (sourceKind == null ? "NULL" : "'" + sourceKind + "'") + ", "
                + (fromSession == null ? "NULL" : "'" + fromSession + "'") + ", "
                + (expectedRevision == null ? "NULL" : expectedRevision.toString()) + ")");
    }

    private void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private String text(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            return rows.next() ? rows.getString(1) : null;
        }
    }
}