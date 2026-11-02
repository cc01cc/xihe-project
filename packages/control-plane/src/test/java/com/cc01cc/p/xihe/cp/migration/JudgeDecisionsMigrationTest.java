package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.TestMethodOrder;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0624 M0: V93 — the frozen audit/contract ground of the wake and judge policies.
 *
 * <ol>
 *   <li>1. {@code session_participants.wake_policy} gains {@code SCHEDULE} with its
 *       per-participant schedule parameters in the new {@code wake_config} JSONB column
 *       (Q4: interval + jitter + concurrency are per-participant runtime policy, not a
 *       principal attribute and not a global default — D23-20 forbids reusing
 *       {@code agent_principals.context_policy});</li>
 *   <li>2. {@code chat_runs.trigger_source} answers "who triggered this run" (G-24) —
 *       every pre-V93 run backfills to {@code 'user'};</li>
 *   <li>3. {@code judge_decisions} is the G-15 audit table: it must record <b>failed and
 *       timed-out</b> judge decisions too (PLAN-0624 Q2 is fail-closed — silence must be
 *       visible in the audit, or the refusal cannot be diagnosed).</li>
 * </ol>
 *
 * <p>Seeded at the V92 shape, then migrated to head — same pattern as
 * {@code SessionParticipantsMigrationTest}.</p>
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class JudgeDecisionsMigrationTest {
    /** PLAN-eff/task-13 M1（A1）：空库由 JVM 单例容器下发；本类仍自行 Flyway 到目标版本。 */
    static TestDatabaseProvider.DatabaseRef postgres = TestDatabaseProvider.emptyDatabase("judge_decision");

    private static final UUID USER_ID = UUID.randomUUID();
    private static final UUID PRINCIPAL_ID = UUID.randomUUID();
    private static final UUID WORKSPACE_ID = UUID.randomUUID();
    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID BRANCH_ID = UUID.randomUUID();
    private static final UUID PARTICIPANT_ID = UUID.randomUUID();
    private static final UUID RUN_ID = UUID.randomUUID();
    private static final UUID DECISION_ID = UUID.randomUUID();

    private static Connection connection;

    @BeforeAll
    static void seedV92ShapeThenMigrateToHead() throws SQLException {
        String url = postgres.jdbcUrl();
        migrate(url, "92");
        connection = DriverManager.getConnection(url, postgres.username(), postgres.password());
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + USER_ID
                + "', 'plan0624-judge@test.local', 'x', 'plan0624judge')");
        execute("INSERT INTO workspaces (id, name) VALUES ('" + WORKSPACE_ID
                + "', 'judge workspace')");
        execute("INSERT INTO agent_principals (id, name, created_by_user_id) VALUES ('" + PRINCIPAL_ID
                + "', 'legacy agent principal', '" + USER_ID + "')");
        execute("INSERT INTO sessions (id, workspace_id, user_id, title, agent_principal_id) VALUES ('"
                + SESSION_ID + "', '" + WORKSPACE_ID + "', '" + USER_ID + "', 'judge session', '"
                + PRINCIPAL_ID + "')");
        execute("INSERT INTO session_participants (id, session_id, principal_kind, principal_id, role,"
                + " order_index, wake_policy, respond_policy) VALUES ('" + PARTICIPANT_ID + "', '"
                + SESSION_ID + "', 'AGENT', '" + PRINCIPAL_ID + "', 'PRIMARY', 10, 'ALL_MESSAGES',"
                + " 'ALWAYS')");
        execute("INSERT INTO session_branches (id, session_id) VALUES ('" + BRANCH_ID + "', '"
                + SESSION_ID + "')");
        // The legacy run: created before trigger_source exists — V93 must backfill it to 'user'.
        execute("INSERT INTO chat_runs (id, session_id, user_id, workspace_id, idempotency_key,"
                + " request_hash, status, origin, branch_id) VALUES ('" + RUN_ID + "', '" + SESSION_ID
                + "', '" + USER_ID + "', '" + WORKSPACE_ID + "', 'legacy-run-key', 'deadbeef',"
                + " 'succeeded', 'user_submission', '" + BRANCH_ID + "')");
        migrate(url, null);
        // Red-first: pre-V93 the table does not exist yet — the seeded decision lands only once
        // the migration is in place; without it every assertion below fails on the missing contract.
        if (!query("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public'"
                + " AND table_name = 'judge_decisions'").isEmpty()) {
            seedDecision();
        }
    }

    private static void seedDecision() throws SQLException {
        execute("INSERT INTO judge_decisions (id, session_id, run_id, participant_id, trigger_source,"
                + " input_window, verdict, model_provider, model_name, latency_ms, prompt_tokens,"
                + " completion_tokens) VALUES ('" + DECISION_ID + "', '" + SESSION_ID + "', '"
                + RUN_ID + "', '" + PARTICIPANT_ID + "', 'judge',"
                + " 'lastN=20 seq=100..119 summary=plan0624 duty-template=v1',"
                + " '{\"speak\":true,\"reason\":\"direct question\"}', 'bailian',"
                + " 'decision-model-preview', 412, 3180, 12)");
    }

    // ---------------------------------------------------------------- 1. wake vocabulary

    @Test
    void scheduleJoinsTheWakeVocabularyAndToolStaysOut() throws SQLException {
        UUID scheduled = insertParticipant("SCHEDULE", "{\"intervalSeconds\":300}", null);
        assertNotNull(scheduled, "SCHEDULE is part of the 0624 wake vocabulary");
        assertThrows(SQLException.class,
                () -> insertParticipant("TOOL", null, null),
                "TOOL stays out of the CHECK — 0624 does not implement tool-triggered wake");
    }

    @Test
    void scheduleRowsRequireWakeConfig() throws SQLException {
        assertThrows(SQLException.class,
                () -> insertParticipant("SCHEDULE", null, null),
                "SCHEDULE without wake_config violates the Q4 contract");
        assertNotNull(insertParticipant("MENTION", null, null),
                "non-SCHEDULE rows keep working without wake_config");
    }

    // ---------------------------------------------------------------- 2. trigger_source

    @Test
    @Order(1)
    void legacyRunsBackfillToUser() throws SQLException {
        // Independent fixture: another test deletes the seeded RUN_ID, so the backfill proof uses
        // its own freshly-inserted run (the column DEFAULT is the backfill — insert without the
        // column and it must land on 'user').
        UUID freshRun = UUID.randomUUID();
        execute("INSERT INTO chat_runs (id, session_id, user_id, workspace_id, idempotency_key,"
                + " request_hash, status, origin, branch_id) VALUES ('" + freshRun + "', '"
                + SESSION_ID + "', '" + USER_ID + "', '" + WORKSPACE_ID + "', 'fresh-run-key',"
                + " 'cafebabe', 'accepted', 'user_submission', '" + BRANCH_ID + "')");
        List<String[]> rows = query("SELECT trigger_source FROM chat_runs WHERE id = '" + freshRun + "'");
        assertEquals(1, rows.size());
        assertEquals("user", rows.getFirst()[0], "a run inserted without trigger_source lands on 'user'");
        List<String[]> legacy = query("SELECT trigger_source FROM chat_runs WHERE id = '" + RUN_ID + "'");
        assertEquals(1, legacy.size(), "the V92-seeded legacy run survives the migration");
        assertEquals("user", legacy.getFirst()[0], "the pre-V93 run backfilled to user — the exact row the DEFAULT produced");
    }

    @Test
    void triggerSourceRejectsUnknownValues() throws SQLException {
        // Reuse the seeded root branch — a second root branch violates the partial unique index.
        assertThrows(SQLException.class, () -> execute("INSERT INTO chat_runs (id, session_id, user_id,"
                + " workspace_id, idempotency_key, request_hash, status, origin, branch_id,"
                + " trigger_source) VALUES ('" + UUID.randomUUID() + "', '" + SESSION_ID + "', '"
                + USER_ID + "', '" + WORKSPACE_ID + "', 'bad-key', 'deadbeef', 'accepted',"
                + " 'user_submission', '" + BRANCH_ID + "', 'telepathy')"));
    }

    // ---------------------------------------------------------------- 3. judge_decisions

    @Test
    void judgeDecisionsCarriesTheFrozenShape() throws SQLException {
        assertColumn("judge_decisions", "id", "uuid", false);
        assertColumn("judge_decisions", "session_id", "uuid", false);
        assertColumn("judge_decisions", "run_id", "uuid", true);
        assertColumn("judge_decisions", "participant_id", "uuid", false);
        assertColumn("judge_decisions", "trigger_source", "text", false);
        assertColumn("judge_decisions", "input_window", "text", false);
        assertColumn("judge_decisions", "verdict", "jsonb", false);
        assertColumn("judge_decisions", "model_provider", "text", false);
        assertColumn("judge_decisions", "model_name", "text", false);
        assertColumn("judge_decisions", "latency_ms", "integer", false);
        assertColumn("judge_decisions", "prompt_tokens", "bigint", true);
        assertColumn("judge_decisions", "completion_tokens", "bigint", true);
        assertColumn("judge_decisions", "outcome", "text", false);
        assertColumn("judge_decisions", "error", "text", true);
        assertColumn("judge_decisions", "created_at", "timestamp with time zone", false);
        assertEquals("session_participants|r", foreignKey("judge_decisions", "participant_id"),
                "audit outlives the participant — deletion is RESTRICTed (D23-26 soft-disables instead)");
        assertEquals("sessions|c", foreignKey("judge_decisions", "session_id"),
                "the context_events precedent: a deleted session takes its audit with it");
        assertEquals("chat_runs|n", foreignKey("judge_decisions", "run_id"),
                "audit outlives the run — deletion only clears the reference (SET NULL)");
    }

    @Test
    void judgeDecisionsEnumChecks() throws SQLException {
        insertDecision(UUID.randomUUID(), "chain", "succeeded", null);
        insertDecision(UUID.randomUUID(), "guard", "timeout",
                "bailian decision-model-preview did not answer within 8s");
        assertThrows(SQLException.class, () -> insertDecision(UUID.randomUUID(), "telepathy",
                "succeeded", null), "trigger_source keeps the G-24 vocabulary");
        assertThrows(SQLException.class, () -> insertDecision(UUID.randomUUID(), "judge",
                "ignored", null), "outcome is succeeded|failed|timeout|throttled");
    }

    @Test
    @Order(9)
    void deletingTheRunKeepsTheAudit() throws SQLException {
        execute("DELETE FROM chat_runs WHERE id = '" + RUN_ID + "'");
        List<String[]> rows = query("SELECT run_id FROM judge_decisions WHERE id = '" + DECISION_ID + "'");
        assertEquals(1, rows.size());
        assertNull(rows.getFirst()[0] == null ? null : rows.getFirst()[0],
                "SET NULL: the audit row survives, only the reference is cleared");
    }

    @Test
    void deletingTheParticipantIsRefused() throws SQLException {
        assertThrows(SQLException.class,
                () -> execute("DELETE FROM session_participants WHERE id = '" + PARTICIPANT_ID + "'"),
                "audit is RESTRICTed against physical participant removal");
    }

    @Test
    void judgeDecisionsIsIndexedBySessionAndParticipant() throws SQLException {
        List<String> indexNames = new ArrayList<>();
        for (String[] row : query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'"
                + " AND tablename = 'judge_decisions'")) {
            indexNames.add(row[0]);
        }
        assertTrue(indexNames.contains("idx_judge_decisions_session_created"));
        assertTrue(indexNames.contains("idx_judge_decisions_participant"));
        assertFalse(indexNames.stream().anyMatch(name -> name.contains("run")),
                "no run index — audit reads are by session/participant, never by run");
    }

    // ---------------------------------------------------------------- helpers

    private static void migrate(String url, String target) {
        var configuration = Flyway.configure()
                .dataSource(url, postgres.username(), postgres.password())
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

    private static UUID insertParticipant(String wake, String wakeConfig, String unused) throws SQLException {
        UUID id = UUID.randomUUID();
        // HUMAN kind with a random principal id: the polymorphic reference carries no FK, so the
        // row inserts without a users row — and repeated inserts stay unique under
        // uq_session_participants_principal (V92), which a shared AGENT principal would violate.
        execute("INSERT INTO session_participants (id, session_id, principal_kind, principal_id, role,"
                + " order_index, wake_policy, respond_policy" + (wakeConfig == null ? "" : ", wake_config")
                + ") VALUES ('" + id + "', '" + SESSION_ID + "', 'HUMAN', '" + UUID.randomUUID() + "',"
                + " 'MEMBER', " + (20 + Math.abs(id.hashCode() % 100000)) + ", '" + wake + "',"
                + " 'WHEN_MENTIONED'" + (wakeConfig == null ? "" : ", '" + wakeConfig + "'::jsonb")
                + ")");
        return id;
    }

    private static void insertDecision(UUID id, String triggerSource, String outcome, String error)
            throws SQLException {
        execute("INSERT INTO judge_decisions (id, session_id, run_id, participant_id, trigger_source,"
                + " input_window, verdict, model_provider, model_name, latency_ms, outcome, error)"
                + " VALUES ('" + id + "', '" + SESSION_ID + "', NULL, '" + PARTICIPANT_ID + "', '"
                + triggerSource + "', 'lastN=20 seq=1..20', '{\"speak\":false}', 'bailian',"
                + " 'decision-model-preview', 399, '" + outcome + "',"
                + (error == null ? "NULL" : "'" + error + "'") + ")");
    }

    private static void assertColumn(String table, String column, String type, boolean nullable)
            throws SQLException {
        List<String[]> rows = query("SELECT data_type, is_nullable, column_default"
                + " FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '"
                + table + "' AND column_name = '" + column + "'");
        assertEquals(1, rows.size(), table + "." + column + " must exist");
        assertEquals(type, rows.getFirst()[0], table + "." + column + " type");
        assertEquals(nullable ? "YES" : "NO", rows.getFirst()[1], table + "." + column + " nullability");
    }

    /** {@code <referenced table>|<delete action letter>} (r = RESTRICT, c = CASCADE, n = SET NULL). */
    private static String foreignKey(String table, String column) throws SQLException {
        List<String[]> rows = query("SELECT target.relname, con.confdeltype FROM pg_constraint con"
                + " JOIN pg_class source ON source.oid = con.conrelid"
                + " JOIN pg_class target ON target.oid = con.confrelid"
                + " JOIN pg_attribute attribute ON attribute.attrelid = con.conrelid"
                + "  AND attribute.attnum = ANY (con.conkey)"
                + " WHERE source.relname = '" + table + "' AND attribute.attname = '" + column
                + "' AND con.contype = 'f'");
        assertEquals(1, rows.size(), table + "." + column + " must have exactly one foreign key");
        return rows.getFirst()[0] + "|" + rows.getFirst()[1];
    }
}
