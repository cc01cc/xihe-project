package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0623 M0: V92 — the session-participant contract.
 *
 * <p>Four rungs of the frozen contract are asserted here, in the order the migration has to run
 * (D16 lesson: nullable column → backfill → NOT NULL/DEFAULT → CHECK/index):</p>
 *
 * <ol>
 *   <li><b>R1</b> {@code chat_runs.agent_principal_id}: the run's responder, nullable for legacy
 *       runs, FK to {@code agent_principals} with {@code ON DELETE RESTRICT};</li>
 *   <li><b>R2</b> {@code session_participants}: polymorphic {@code (principal_kind, principal_id)}
 *       with <b>no</b> FK on the polymorphic side (the {@code role_bindings} precedent), one PRIMARY
 *       per session (partial unique index), unique {@code order_index} per session (R4);</li>
 *   <li><b>R7</b> {@code session_participant_cursors}: read-only in 0623, backfilled to
 *       {@code MAX(context_events.sequence)} (history counts as read);</li>
 *   <li><b>D23-20</b> {@code agent_principals.context_policy}: assembly policy on the agent
 *       subject, <b>not</b> a {@code context-policy} config domain.</li>
 * </ol>
 *
 * <p>The backfill is proved the same way {@code AgentPrincipalScopeMigrationTest} proves V90: seed
 * the pre-V92 shape, then migrate to head. Two legacy sessions are seeded on purpose — one bound to
 * a principal (gets a PRIMARY participant) and one unbound (must stay empty: the migration never
 * invents a responder).</p>
 */
class SessionParticipantsMigrationTest {
    /** PLAN-eff/task-13 M1（A1）：空库由 JVM 单例容器下发；本类仍自行 Flyway 到目标版本。 */
    static TestDatabaseProvider.DatabaseRef postgres = TestDatabaseProvider.emptyDatabase("session_partic");

    private static final UUID USER_ID = UUID.randomUUID();
    private static final UUID PRINCIPAL_ID = UUID.randomUUID();
    private static final UUID WORKSPACE_ID = UUID.randomUUID();
    private static final UUID BOUND_SESSION_ID = UUID.randomUUID();
    private static final UUID UNBOUND_SESSION_ID = UUID.randomUUID();

    private static Connection connection;

    @BeforeAll
    static void seedLegacyShapeThenMigrateToHead() throws SQLException {
        String url = postgres.jdbcUrl();
        migrate(url, "91");
        connection = DriverManager.getConnection(url, postgres.username(), postgres.password());
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + USER_ID
                + "', 'plan0623-participants@test.local', 'x', 'plan0623part')");
        // V89 dropped workspaces.owner_id (ownership now lives in role_bindings), so the V91 shape
        // only needs id + name; storage_mode/execution_mode carry their defaults.
        execute("INSERT INTO workspaces (id, name) VALUES ('" + WORKSPACE_ID
                + "', 'participants workspace')");
        execute("INSERT INTO agent_principals (id, name, created_by_user_id) VALUES ('" + PRINCIPAL_ID
                + "', 'legacy agent principal', '" + USER_ID + "')");
        execute("INSERT INTO sessions (id, workspace_id, user_id, title, agent_principal_id) VALUES ('"
                + BOUND_SESSION_ID + "', '" + WORKSPACE_ID + "', '" + USER_ID + "', 'legacy bound', '"
                + PRINCIPAL_ID + "')");
        execute("INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('" + UNBOUND_SESSION_ID
                + "', '" + WORKSPACE_ID + "', '" + USER_ID + "', 'legacy unbound')");
        execute("INSERT INTO context_events (id, session_id, workspace_id, user_id, event_type, sequence)"
                + " VALUES ('" + UUID.randomUUID() + "', '" + BOUND_SESSION_ID + "', '" + WORKSPACE_ID
                + "', '" + USER_ID + "', 'message', 3)");
        migrate(url, null);
    }

    // ---------------------------------------------------------------- R1

    @Test
    void runLevelResponderIsNullableAndRestrictsPrincipalDeletion() throws SQLException {
        assertColumn("chat_runs", "agent_principal_id", "uuid", true);
        assertEquals("agent_principals|r", foreignKey("chat_runs", "agent_principal_id"),
                "R1: the responder is a real principal, and deleting it is RESTRICTed");
        assertTrue(indexColumns().contains("chat_runs:agent_principal_id"),
                "the responder column is indexed (run lists group by principal)");
        assertNullColumnDefault("chat_runs", "agent_principal_id",
                "legacy runs have no responder: the migration backfills nothing");
    }

    // ---------------------------------------------------------------- R2

    @Test
    void participantsCarryThePolymorphicPairAndTheSessionFk() throws SQLException {
        assertColumn("session_participants", "id", "uuid", false);
        assertColumn("session_participants", "session_id", "uuid", false);
        assertColumn("session_participants", "principal_kind", "text", false);
        assertColumn("session_participants", "principal_id", "uuid", false);
        assertColumn("session_participants", "role", "text", false);
        assertColumn("session_participants", "order_index", "integer", false);
        assertColumn("session_participants", "wake_policy", "text", false);
        assertColumn("session_participants", "respond_policy", "text", false);
        assertColumn("session_participants", "created_at", "timestamp with time zone", false);
        assertColumn("session_participants", "disabled_at", "timestamp with time zone", true);
        assertFalse(columnExists("session_participants", "cap_snapshot"),
                "Lead ruling 2026-11-02: the cap is resolved live via resolveCapFor(principalId,"
                        + " workspaceId); storing a participant-level snapshot would create a second"
                        + " source of truth");
        assertEquals("sessions|c", foreignKey("session_participants", "session_id"),
                "a deleted session takes its participant rows with it");
        assertTrue(foreignKeysOn("session_participants").stream()
                        .noneMatch(fk -> fk.contains("principal_id")),
                "R2: the polymorphic side carries no FK (role_bindings precedent)");
    }

    @Test
    void theThreeUniquenessRulesAreEnforcedByTheDatabase() throws SQLException {
        UUID sessionId = newSession("uniqueness");
        UUID kindOk = insertParticipant(sessionId, "AGENT", PRINCIPAL_ID, "PRIMARY", 10);
        assertNotNull(kindOk);

        assertThrows(SQLException.class,
                () -> insertParticipant(sessionId, "AGENT", PRINCIPAL_ID, "MEMBER", 20),
                "UNIQUE(session_id, principal_kind, principal_id)");
        assertThrows(SQLException.class,
                () -> insertParticipant(sessionId, "AGENT", UUID.randomUUID(), "PRIMARY", 20),
                "a session has exactly one PRIMARY (partial unique index WHERE role='PRIMARY')");
        assertThrows(SQLException.class,
                () -> insertParticipant(sessionId, "AGENT", UUID.randomUUID(), "MEMBER", 10),
                "R4: order_index is unique per session");
        UUID member = insertParticipant(sessionId, "HUMAN", UUID.randomUUID(), "MEMBER", 20);
        assertNotNull(member, "a second participant at the next step is fine (10, 20, …)");
    }

    @Test
    void theEnumVocabularyIsEnforcedByNamedCheckConstraints() throws SQLException {
        UUID sessionId = newSession("enums");
        assertThrows(SQLException.class,
                () -> insertParticipant(sessionId, "ROBOT", UUID.randomUUID(), "MEMBER", 10),
                "principal_kind is HUMAN or AGENT");
        assertThrows(SQLException.class,
                () -> insertParticipant(sessionId, "AGENT", UUID.randomUUID(), "OWNER", 10),
                "D23-02: role is PRIMARY/MEMBER/GUARD — never the workspace word OWNER");
        assertThrows(SQLException.class,
                () -> insertParticipant(sessionId, "AGENT", UUID.randomUUID(), "MEMBER", 10, "SCHEDULE", "ALWAYS"),
                "D23-04: SCHEDULE is 0624, not part of the 0623 wake vocabulary");
        assertThrows(SQLException.class,
                () -> insertParticipant(sessionId, "AGENT", UUID.randomUUID(), "MEMBER", 10, "MENTION", "SCHEDULE"),
                "D23-05: respond_policy is ALWAYS/WHEN_MENTIONED/JUDGE/MUTED");
        UUID judge = insertParticipant(sessionId, "AGENT", UUID.randomUUID(), "MEMBER", 10, "MENTION", "JUDGE");
        assertNotNull(judge, "JUDGE is a reserved-but-valid enum value in 0623");
    }

    // ---------------------------------------------------------------- R7 + D23-20

    @Test
    void cursorsAreAReadPointerWithTheSessionCascade() throws SQLException {
        assertColumn("session_participant_cursors", "participant_id", "uuid", false);
        assertColumn("session_participant_cursors", "last_read_event_seq", "bigint", false);
        assertColumn("session_participant_cursors", "mention_count", "integer", false);
        assertColumn("session_participant_cursors", "updated_at", "timestamp with time zone", false);
        assertEquals("session_participants|c", foreignKey("session_participant_cursors", "participant_id"),
                "cursors die with their participant");
    }

    @Test
    void agentSubjectsCarryTheAssemblyPolicyOutsideTheConfigDomain() throws SQLException {
        assertColumn("agent_principals", "context_policy", "jsonb", true);
        assertNullColumnDefault("agent_principals", "context_policy",
                "D23-20: default assembly stays in code/config domains, not as a column default");
    }

    // ---------------------------------------------------------------- backfill

    @Test
    void legacySessionsGetOnePrimaryParticipantAndAReadCursor() throws SQLException {
        List<String[]> rows = query("SELECT principal_kind, principal_id, role, order_index, wake_policy,"
                + " respond_policy FROM session_participants WHERE session_id = '" + BOUND_SESSION_ID
                + "' ORDER BY order_index");
        assertEquals(1, rows.size(), "exactly one participant is backfilled (the session's responder)");
        String[] row = rows.getFirst();
        assertEquals("AGENT", row[0], "R2: the legacy responder is an agent principal");
        assertEquals(PRINCIPAL_ID.toString(), row[1]);
        assertEquals("PRIMARY", row[2], "D23-13: one PRIMARY per session, taken from sessions.agent_principal_id");
        assertEquals("10", row[3], "R4: the first participant sits at the initial step (10)");
        assertEquals("ALL_MESSAGES", row[4], "R3: PRIMARY wakes on every message");
        assertEquals("ALWAYS", row[5], "R3: PRIMARY responds to every message");

        List<String[]> cursors = query("SELECT last_read_event_seq, mention_count FROM"
                + " session_participant_cursors c JOIN session_participants p ON p.id = c.participant_id"
                + " WHERE p.session_id = '" + BOUND_SESSION_ID + "'");
        assertEquals(1, cursors.size(), "the PRIMARY gets a cursor row");
        assertEquals("3", cursors.getFirst()[0],
                "R7: history counts as read — the cursor starts at MAX(context_events.sequence)");
        assertEquals("0", cursors.getFirst()[1]);
    }

    @Test
    void unboundSessionsStayEmptyInsteadOfInventingAResponder() throws SQLException {
        assertEquals(0, query("SELECT id FROM session_participants WHERE session_id = '"
                        + UNBOUND_SESSION_ID + "'").size(),
                "a principal-null session has no participant row until it binds one (M1)");
        assertEquals(0, query("SELECT id FROM session_participant_cursors c"
                        + " JOIN session_participants p ON p.id = c.participant_id WHERE p.session_id = '"
                        + UNBOUND_SESSION_ID + "'").size());
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

    private static UUID newSession(String tag) throws SQLException {
        UUID sessionId = UUID.randomUUID();
        execute("INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('" + sessionId + "', '"
                + WORKSPACE_ID + "', '" + USER_ID + "', '" + tag + "')");
        return sessionId;
    }

    private static UUID insertParticipant(UUID sessionId, String kind, UUID principalId, String role,
                                          int orderIndex) throws SQLException {
        return insertParticipant(sessionId, kind, principalId, role, orderIndex, "MENTION", "WHEN_MENTIONED");
    }

    private static UUID insertParticipant(UUID sessionId, String kind, UUID principalId, String role,
                                          int orderIndex, String wake, String respond) throws SQLException {
        UUID id = UUID.randomUUID();
        execute("INSERT INTO session_participants (id, session_id, principal_kind, principal_id, role,"
                + " order_index, wake_policy, respond_policy) VALUES ('" + id + "', '" + sessionId + "', '"
                + kind + "', '" + principalId + "', '" + role + "', " + orderIndex + ", '" + wake
                + "', '" + respond + "')");
        return id;
    }

    private static List<String[]> query(String sql) throws SQLException {
        List<String[]> rows = new ArrayList<>();
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery(sql)) {
            int columns = result.getMetaData().getColumnCount();
            while (result.next()) {
                String[] row = new String[columns];
                for (int index = 1; index <= columns; index++) {
                    row[index - 1] = String.valueOf(result.getString(index));
                }
                rows.add(row);
            }
        }
        return rows;
    }

    private static void assertColumn(String table, String column, String type, boolean nullable)
            throws SQLException {
        List<String[]> rows = query("SELECT data_type, is_nullable FROM information_schema.columns"
                + " WHERE table_schema = 'public' AND table_name = '" + table
                + "' AND column_name = '" + column + "'");
        assertEquals(1, rows.size(), table + "." + column + " must exist");
        assertEquals(type, rows.getFirst()[0], table + "." + column + " type");
        assertEquals(nullable ? "YES" : "NO", rows.getFirst()[1], table + "." + column + " nullability");
    }

    private static boolean columnExists(String table, String column) throws SQLException {
        return !query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'"
                + " AND table_name = '" + table + "' AND column_name = '" + column + "'").isEmpty();
    }

    private static void assertNullColumnDefault(String table, String column, String message)
            throws SQLException {
        List<String[]> rows = query("SELECT column_default FROM information_schema.columns"
                + " WHERE table_schema = 'public' AND table_name = '" + table
                + "' AND column_name = '" + column + "'");
        assertEquals(1, rows.size(), table + "." + column + " must exist");
        assertTrue(rows.getFirst()[0] == null || "null".equalsIgnoreCase(rows.getFirst()[0]),
                message);
    }

    /** {@code <referenced table>|<delete action letter>} (r = RESTRICT, c = CASCADE). */
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

    private static List<String> foreignKeysOn(String table) throws SQLException {
        List<String> keys = new ArrayList<>();
        for (String[] row : query("SELECT pg_get_constraintdef(con.oid) FROM pg_constraint con"
                + " JOIN pg_class source ON source.oid = con.conrelid"
                + " WHERE source.relname = '" + table + "' AND con.contype = 'f'")) {
            keys.add(row[0].toLowerCase(Locale.ROOT));
        }
        return keys;
    }

    private static List<String> indexColumns() throws SQLException {
        List<String> indexed = new ArrayList<>();
        for (String[] row : query("SELECT tablename, indexdef FROM pg_indexes"
                + " WHERE schemaname = 'public'")) {
            String definition = row[1].toLowerCase(Locale.ROOT);
            int open = definition.indexOf('(');
            int close = definition.indexOf(')', open);
            if (open < 0 || close < 0) {
                continue;
            }
            for (String part : definition.substring(open + 1, close).split(",")) {
                indexed.add(row[0] + ":" + part.trim());
            }
        }
        return indexed;
    }
}
