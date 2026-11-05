package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0660 M5-B / T5.8 (V128): {@code user_questions} — the question the agent waits on.
 *
 * <p>Frozen shape: PLAN-0648 design.md §6, rebuilt for cross-checking in
 * {@code spec/session/user-channel.md} §6. These assertions run on <b>real PostgreSQL</b> (the
 * project's migration-test base: a JVM-level pgvector/pg17 container, one empty database per class,
 * Flyway to head) — never H2, whose {@code ddl-auto=create-drop} lane would happily invent the table
 * from the entity and prove nothing about the migration.</p>
 *
 * <p>Every frozen item is asserted positively <b>and</b> by absence where it matters: an exact column
 * list (a dropped or an extra column fails), the exact index set with the partial predicates, the
 * exact FK set with its delete actions, the state CHECK by negative case, and the three behavioural
 * consequences (one pending per run, cascade on run/session deletion, unknown references rejected).
 * "The table exists" alone would not catch any of the regressions this migration is exposed to.</p>
 */
class UserQuestionsMigrationTest {

    /** PLAN-eff/task-13 M1 (A1): the empty database comes from the JVM singleton container. */
    static TestDatabaseProvider.DatabaseRef postgres = TestDatabaseProvider.emptyDatabase("user_questions");

    private static final UUID USER_ID = UUID.randomUUID();
    private static final UUID WORKSPACE_ID = UUID.randomUUID();

    private static Connection connection;

    @BeforeAll
    static void migrateThenSeedReferencedRows() throws SQLException {
        Flyway.configure()
                .dataSource(postgres.jdbcUrl(), postgres.username(), postgres.password())
                .locations("classpath:db/migration")
                .load()
                .migrate();
        connection = DriverManager.getConnection(
                postgres.jdbcUrl(), postgres.username(), postgres.password());
        execute("INSERT INTO users (id, email, password_hash, username) VALUES (?, ?, 'x', ?)",
                USER_ID, "plan0660-uq@test.local", "plan0660uq");
        execute("INSERT INTO workspaces (id, name) VALUES (?, 'uq ws')", WORKSPACE_ID);
    }

    // ---------------------------------------------------------------------------------------
    // shape: columns
    // ---------------------------------------------------------------------------------------

    @Test
    void tableCarriesExactlyTheFrozenColumns() throws SQLException {
        List<String> actual = new ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT column_name, data_type, is_nullable FROM information_schema.columns"
                        + " WHERE table_schema = 'public' AND table_name = 'user_questions'"
                        + " ORDER BY column_name");
             ResultSet result = statement.executeQuery()) {
            while (result.next()) {
                actual.add(result.getString(1) + "|" + result.getString(2) + "|" + result.getString(3));
            }
        }
        assertEquals(List.of(
                "addressee_user_id|uuid|NO",
                "answer|text|YES",
                "asked_by_participant_id|uuid|YES",
                "created_at|timestamp with time zone|NO",
                "expires_at|timestamp with time zone|YES",
                "first_delivered_at|timestamp with time zone|YES",
                "id|uuid|NO",
                "prompt|text|NO",
                "run_id|uuid|NO",
                "session_id|uuid|NO",
                "settled_at|timestamp with time zone|YES",
                "state|text|NO"), actual,
                "the V128 column list is the frozen PLAN-0648 §6 list, no more and no less");
        assertTrue(scalarString("SELECT column_default FROM information_schema.columns"
                        + " WHERE table_schema = 'public' AND table_name = 'user_questions'"
                        + " AND column_name = 'created_at'").contains("now()"),
                "created_at keeps the project-wide DEFAULT NOW()");
    }

    // ---------------------------------------------------------------------------------------
    // constraints: CHECK vocabulary, FKs (both declared and behaviourally), uniqueness
    // ---------------------------------------------------------------------------------------

    @Test
    void stateVocabularyIsClosedAtTheCheck() throws SQLException {
        for (String state : List.of("pending", "answered", "expired", "cancelled")) {
            UUID id = insert(insertRun(), state, null, "legal " + state);
            assertEquals(state, scalarString("SELECT state FROM user_questions WHERE id = '"
                    + id + "'"));
        }
        assertThrows(SQLException.class,
                () -> insert(insertRun(), "dispatching", null, "not a question state"),
                "approval-only states must not leak into the question vocabulary");
        assertThrows(SQLException.class,
                () -> insert(insertRun(), "PENDING", null, "uppercase is a different state"),
                "the vocabulary is exact lowercase");
    }

    @Test
    void declaredForeignKeysCarryTheFrozenDeleteActions() throws SQLException {
        Map<String, String> actual = new LinkedHashMap<>();
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery(
                     "SELECT conname, confdeltype FROM pg_constraint"
                             + " WHERE conrelid = 'user_questions'::regclass AND contype = 'f'"
                             + " ORDER BY conname")) {
            while (result.next()) {
                actual.put(result.getString(1), result.getString(2));
            }
        }
        // c = CASCADE, n = SET NULL, a = NO ACTION (the users FK keeps a hard delete from silently
        // dropping a question somebody was still owed).
        Map<String, String> expected = new LinkedHashMap<>();
        expected.put("fk_user_questions_addressee", "a");
        expected.put("fk_user_questions_asked_by_participant", "n");
        expected.put("fk_user_questions_run", "c");
        expected.put("fk_user_questions_session", "c");
        assertEquals(expected, actual, "all four FKs and their delete actions are frozen");
    }

    @Test
    void stateCheckIsRegisteredAsOneConstraint() throws SQLException {
        Map<String, String> checks = new LinkedHashMap<>();
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery(
                     "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint"
                             + " WHERE conrelid = 'user_questions'::regclass AND contype = 'c'"
                             + " ORDER BY conname")) {
            while (result.next()) {
                checks.put(result.getString(1), result.getString(2));
            }
        }
        assertEquals(1, checks.size(), "V128 declares exactly one CHECK: " + checks.keySet());
        String definition = checks.get("ck_user_questions_state");
        assertNotNull(definition, "the state CHECK must exist on the table");
        for (String state : List.of("'pending'", "'answered'", "'expired'", "'cancelled'")) {
            assertTrue(definition.contains(state), "state CHECK is missing " + state + ": " + definition);
        }
    }

    @Test
    void unknownReferencesAreRejected() throws SQLException {
        UUID runId = insertRun();
        SQLException sessionFailure = assertThrows(SQLException.class,
                () -> insertRaw(UUID.randomUUID(), runId, USER_ID, "pending"),
                "a question without a real session must fail closed");
        assertTrue(sessionFailure.getMessage().contains("fk_user_questions_session"),
                "expected the session FK, got: " + sessionFailure.getMessage());
        SQLException runFailure = assertThrows(SQLException.class,
                () -> insertRaw(insertSession(), UUID.randomUUID(), USER_ID, "pending"),
                "a question without a real run must fail closed");
        assertTrue(runFailure.getMessage().contains("fk_user_questions_run"),
                "expected the run FK, got: " + runFailure.getMessage());
        assertThrows(SQLException.class,
                () -> insertRaw(insertSession(), insertRun(), UUID.randomUUID(), "pending"),
                "a question addressed to a non-existent user must fail closed");
    }

    // ---------------------------------------------------------------------------------------
    // indexes
    // ---------------------------------------------------------------------------------------

    @Test
    void pendingProjectionIndexesExistWithTheirPredicates() throws SQLException {
        Map<String, String> indexes = new LinkedHashMap<>();
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery(
                     "SELECT indexname, indexdef FROM pg_indexes"
                             + " WHERE schemaname = 'public' AND tablename = 'user_questions'"
                             + " ORDER BY indexname")) {
            while (result.next()) {
                indexes.put(result.getString(1), result.getString(2));
            }
        }
        assertEquals(Set.of("idx_user_questions_addressee_pending",
                        "idx_user_questions_session_created",
                        "uq_user_questions_run_pending",
                        "user_questions_pkey"), new TreeSet<>(indexes.keySet()),
                "exactly the frozen index set (plus the PK) exists");

        String addresseePending = indexes.get("idx_user_questions_addressee_pending");
        assertTrue(addresseePending.contains("(addressee_user_id, created_at DESC)"),
                "projection index keeps its descending order: " + addresseePending);
        assertTrue(addresseePending.contains("WHERE (state = 'pending'::text)"),
                "projection index is partial on pending: " + addresseePending);

        String sessionCreated = indexes.get("idx_user_questions_session_created");
        assertTrue(sessionCreated.contains("(session_id, created_at)"),
                "session read face index: " + sessionCreated);
        assertTrue(!sessionCreated.contains("WHERE"),
                "the session index is NOT partial: " + sessionCreated);

        String runPending = indexes.get("uq_user_questions_run_pending");
        assertTrue(runPending.contains("CREATE UNIQUE INDEX"),
                "one pending question per run needs a unique index: " + runPending);
        assertTrue(runPending.contains("(run_id)"), "unique key is run_id: " + runPending);
        assertTrue(runPending.contains("WHERE (state = 'pending'::text)"),
                "uniqueness must not block settled rows: " + runPending);
    }

    @Test
    void atMostOnePendingQuestionPerRunIsEnforced() throws SQLException {
        UUID runId = insertRun();
        UUID first = insert(runId, "pending", null, "first question");
        SQLException duplicate = assertThrows(SQLException.class,
                () -> insert(runId, "pending", null, "second pending question"),
                "a run may wait on at most one question at a time");
        assertTrue(duplicate.getMessage().contains("uq_user_questions_run_pending"),
                "expected the partial unique index, got: " + duplicate.getMessage());

        execute("UPDATE user_questions SET state = 'answered', answer = 'ok', settled_at = NOW()"
                + " WHERE id = ?", first);
        UUID second = insert(runId, "pending", null, "asked again after the first settled");
        assertNotNull(second, "a settled row must not block the next question of the same run");
        assertEquals(2, scalarInt("SELECT count(*) FROM user_questions WHERE run_id = '" + runId + "'"),
                "both rows are durable; only the pending one is unique per run");
    }

    // ---------------------------------------------------------------------------------------
    // rows: the legal shape, and the cascade the FKs promise
    // ---------------------------------------------------------------------------------------

    @Test
    void legalRowsWithEveryFrozenColumnPassAllConstraints() throws SQLException {
        UUID sessionId = insertSession();
        UUID runId = insertRun(sessionId);
        UUID participantId = insertParticipant(sessionId);
        UUID pendingId = UUID.randomUUID();
        Instant expiresAt = Instant.now().plusSeconds(600);

        try (PreparedStatement statement = connection.prepareStatement(
                "INSERT INTO user_questions (id, session_id, run_id, asked_by_participant_id,"
                        + " addressee_user_id, prompt, state, expires_at, created_at,"
                        + " first_delivered_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)")) {
            statement.setObject(1, pendingId);
            statement.setObject(2, sessionId);
            statement.setObject(3, runId);
            statement.setObject(4, participantId);
            statement.setObject(5, USER_ID);
            statement.setString(6, "which branch should I rebase onto?");
            statement.setTimestamp(7, Timestamp.from(expiresAt));
            statement.setTimestamp(8, Timestamp.from(Instant.now()));
            statement.setTimestamp(9, Timestamp.from(Instant.now()));
            statement.executeUpdate();
        }

        assertEquals("which branch should I rebase onto?",
                scalarString("SELECT prompt FROM user_questions WHERE id = '" + pendingId + "'"));
        assertEquals("pending", scalarString("SELECT state FROM user_questions WHERE id = '"
                + pendingId + "'"));
        assertNotNull(scalarString("SELECT first_delivered_at FROM user_questions WHERE id = '"
                + pendingId + "'"), "delivered stamp survived the round trip");
        assertNull(scalarString("SELECT answer FROM user_questions WHERE id = '" + pendingId + "'"),
                "a pending question has no answer yet");

        UUID answeredId = UUID.randomUUID();
        try (PreparedStatement statement = connection.prepareStatement(
                "INSERT INTO user_questions (id, session_id, run_id, addressee_user_id, prompt,"
                        + " state, answer, settled_at) VALUES (?, ?, ?, ?, ?, 'answered', ?, NOW())")) {
            statement.setObject(1, answeredId);
            statement.setObject(2, sessionId);
            statement.setObject(3, insertRun(sessionId));
            statement.setObject(4, USER_ID);
            statement.setString(5, "proceed?");
            statement.setString(6, "yes, go ahead");
            statement.executeUpdate();
        }
        assertEquals("yes, go ahead",
                scalarString("SELECT answer FROM user_questions WHERE id = '" + answeredId + "'"));
        assertNotNull(scalarString("SELECT settled_at FROM user_questions WHERE id = '"
                + answeredId + "'"), "a terminal row carries its settle stamp");
        assertNull(scalarString("SELECT asked_by_participant_id FROM user_questions WHERE id = '"
                + answeredId + "'"), "the asking participant is optional");
    }

    @Test
    void deletingTheSessionRemovesItsQuestions() throws SQLException {
        UUID sessionId = insertSession();
        UUID runId = insertRun(sessionId);
        UUID questionId = insert(runId, "pending", null, "orphan check");
        assertEquals(1, scalarInt("SELECT count(*) FROM user_questions WHERE id = '"
                + questionId + "'"));

        execute("DELETE FROM sessions WHERE id = ?", sessionId);

        assertEquals(0, scalarInt("SELECT count(*) FROM user_questions WHERE id = '"
                        + questionId + "'"),
                "fk_user_questions_session ON DELETE CASCADE removes the child rows");
        assertEquals(0, scalarInt("SELECT count(*) FROM chat_runs WHERE id = '" + runId + "'"),
                "the run went with the session, which is what makes the question unreachable");
    }

    @Test
    void deletingTheRunRemovesItsQuestions() throws SQLException {
        UUID sessionId = insertSession();
        UUID runId = insertRun(sessionId);
        UUID questionId = insert(runId, "answered", "done", "run cascade check");

        execute("DELETE FROM chat_runs WHERE id = ?", runId);

        assertEquals(0, scalarInt("SELECT count(*) FROM user_questions WHERE id = '"
                        + questionId + "'"),
                "fk_user_questions_run ON DELETE CASCADE removes the child rows");
    }

    // ---------------------------------------------------------------------------------------
    // fixtures / helpers
    // ---------------------------------------------------------------------------------------

    /** A session plus its root branch (V43 made chat_runs.branch_id NOT NULL). */
    private static UUID insertSession() throws SQLException {
        UUID sessionId = UUID.randomUUID();
        execute("INSERT INTO sessions (id, workspace_id, user_id, title) VALUES (?, ?, ?, 'uq')",
                sessionId, WORKSPACE_ID, USER_ID);
        execute("INSERT INTO session_branches (id, session_id) VALUES (?, ?)",
                UUID.randomUUID(), sessionId);
        return sessionId;
    }

    /** A fresh run on its own session, so "one pending per run" cases never share fixtures. */
    private static UUID insertRun() throws SQLException {
        return insertRun(insertSession());
    }

    private static UUID insertRun(UUID sessionId) throws SQLException {
        UUID runId = UUID.randomUUID();
        UUID branchId = UUID.fromString(scalarString(
                "SELECT id FROM session_branches WHERE session_id = '" + sessionId + "'"
                        + " AND parent_branch_id IS NULL"));
        execute("INSERT INTO chat_runs (id, session_id, user_id, workspace_id, idempotency_key,"
                        + " request_hash, status, origin, branch_id) VALUES (?, ?, ?, ?, ?, 'hash',"
                        + " 'streaming', 'user_submission', ?)",
                runId, sessionId, USER_ID, WORKSPACE_ID, "uq-" + runId, branchId);
        return runId;
    }

    private static UUID insertParticipant(UUID sessionId) throws SQLException {
        UUID participantId = UUID.randomUUID();
        execute("INSERT INTO session_participants (id, session_id, principal_kind, principal_id,"
                        + " role, order_index) VALUES (?, ?, 'AGENT', ?, 'PRIMARY', 10)",
                participantId, sessionId, UUID.randomUUID());
        return participantId;
    }

    private static UUID insert(UUID runId, String state, String answer, String prompt)
            throws SQLException {
        UUID id = UUID.randomUUID();
        insertRaw(scalarSessionOf(runId), runId, USER_ID, prompt, id, state, answer);
        return id;
    }

    private static void insertRaw(UUID sessionId, UUID runId, UUID addresseeUserId, String prompt)
            throws SQLException {
        insertRaw(sessionId, runId, addresseeUserId, prompt, UUID.randomUUID(), "pending", null);
    }

    private static void insertRaw(UUID sessionId, UUID runId, UUID addresseeUserId, String prompt,
                                  UUID id, String state, String answer) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "INSERT INTO user_questions (id, session_id, run_id, addressee_user_id, prompt,"
                        + " state, answer) VALUES (?, ?, ?, ?, ?, ?, ?)")) {
            statement.setObject(1, id);
            statement.setObject(2, sessionId);
            statement.setObject(3, runId);
            statement.setObject(4, addresseeUserId);
            statement.setString(5, prompt);
            statement.setString(6, state);
            statement.setString(7, answer);
            statement.executeUpdate();
        }
    }

    private static UUID scalarSessionOf(UUID runId) throws SQLException {
        return UUID.fromString(scalarString("SELECT session_id FROM chat_runs WHERE id = '"
                + runId + "'"));
    }

    private static void execute(String sql, Object... arguments) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            for (int index = 0; index < arguments.length; index++) {
                statement.setObject(index + 1, arguments[index]);
            }
            statement.execute();
        }
    }

    private static int scalarInt(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery(sql)) {
            result.next();
            return result.getInt(1);
        }
    }

    private static String scalarString(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery(sql)) {
            result.next();
            return result.getString(1);
        }
    }
}
