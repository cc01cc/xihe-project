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
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-188 MVP⑤ S2 (task-188 V172): team_tasks on an empty database.
 *
 * <p>The properties under test are the ones a looser shape would silently lose:</p>
 * <ul>
 *   <li>the id columns are <b>native uuid</b>, not varchar(36) — the entity maps them through
 *       UuidStringConverter, and Hibernate's schema validation compares the CONVERTED type, so a
 *       varchar column makes every Spring context fail at startup (measured, not guessed);</li>
 *   <li>task_no / revision are <b>bigint</b> for the same mechanical reason (Java long);</li>
 *   <li>(team_root_session_id, task_no) is UNIQUE — that pair IS the board identity (task-&lt;n&gt;),
 *       so a duplicate would make "task-3" ambiguous inside one team;</li>
 *   <li>status has a CHECK limited to the four frozen values.</li>
 * </ul>
 *
 * <p>Negative controls: a duplicate board number must be refused (23505) and an unknown status must
 * be refused (23514) — a constraint nobody tries to violate is indistinguishable from an absent one.</p>
 */
class TeamTasksMigrationTest {

    private static TestDatabaseProvider.DatabaseRef postgres;
    private static Connection connection;

    @BeforeAll
    static void migrateToHeadOnAnEmptyDatabase() throws SQLException {
        postgres = TestDatabaseProvider.emptyDatabase("task188_team_tasks");
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
    void startFromEmptyTable() throws SQLException {
        execute("DELETE FROM team_tasks");
    }

    @Test
    void idColumnsAreNativeUuidBecauseTheEntityMapsThemThroughTheConverter() throws SQLException {
        for (String column : new String[] {"team_root_session_id", "created_by_session_id",
                "workspace_id", "owner_session_id", "created_by_participant_id"}) {
            assertEquals("uuid", text("SELECT data_type FROM information_schema.columns"
                    + " WHERE table_name = 'team_tasks' AND column_name = '" + column + "'"),
                    column + " must be uuid — a varchar(36) column fails Hibernate schema validation"
                            + " and takes the whole Spring context down");
        }
    }

    @Test
    void countersAreBigintAndStatusIsCheckConstrained() throws SQLException {
        assertEquals("bigint", text("SELECT data_type FROM information_schema.columns"
                + " WHERE table_name = 'team_tasks' AND column_name = 'task_no'"));
        assertEquals("bigint", text("SELECT data_type FROM information_schema.columns"
                + " WHERE table_name = 'team_tasks' AND column_name = 'revision'"));
        assertEquals("0", text("SELECT column_default FROM information_schema.columns"
                + " WHERE table_name = 'team_tasks' AND column_name = 'revision'"),
                "revision starts at 0 (the CAS identity a caller passes as expectedRevision)");
        final String statusCheck = text("SELECT pg_get_constraintdef(oid) FROM pg_constraint"
                + " WHERE conrelid = 'team_tasks'::regclass AND contype = 'c'"
                + " AND pg_get_constraintdef(oid) LIKE '%status%'");
        assertTrue(statusCheck.contains("pending") && statusCheck.contains("in_progress")
                && statusCheck.contains("completed") && statusCheck.contains("deleted"),
                "the frozen lifecycle vocabulary is a DB CHECK: " + statusCheck);
    }

    @Test
    void theBoardIdentityIsRootPlusTaskNo() throws SQLException {
        final String unique = text("SELECT pg_get_constraintdef(oid) FROM pg_constraint"
                + " WHERE conrelid = 'team_tasks'::regclass AND contype = 'u'");
        assertTrue(unique.contains("team_root_session_id") && unique.contains("task_no"),
                "task-<n> must be unique INSIDE one board: " + unique);
    }

    @Test
    void aDuplicateBoardNumberIsRefusedAndTheControlInsertProvesTheKey() throws SQLException {
        // Both inserts must name the SAME root, otherwise the key never sees a collision.
        UUID board = UUID.randomUUID();
        insertInto(board, 1);
        SQLException refused = assertThrows(SQLException.class, () -> insertInto(board, 1));
        assertEquals("23505", refused.getSQLState(), "unique violation");
        // Control: the same task_no in a DIFFERENT board is fine — the key is (root, task_no),
        // not task_no alone.
        insertInto(UUID.randomUUID(), 1);
    }

    @Test
    void anUnknownStatusIsRefusedWhileTheFourFrozenValuesAreAccepted() throws SQLException {
        for (String status : new String[] {"pending", "in_progress", "completed", "deleted"}) {
            insertWithStatus(1, status);
            execute("DELETE FROM team_tasks");
        }
        SQLException refused = assertThrows(SQLException.class, () -> insertWithStatus(1, "sideways"));
        assertEquals("23514", refused.getSQLState(), "check violation");
    }

    private void insert(long taskNo) throws SQLException {
        insertWithStatus(taskNo, "pending");
    }

    private void insertWithStatus(long taskNo, String status) throws SQLException {
        insertInto(UUID.randomUUID(), taskNo, status);
    }

    private void insertInto(UUID root, long taskNo) throws SQLException {
        insertInto(root, taskNo, "pending");
    }

    private void insertInto(UUID root, long taskNo, String status) throws SQLException {
        execute("INSERT INTO team_tasks (id, task_no, subject, status, created_by_session_id,"
                + " team_root_session_id, workspace_id, revision)"
                + " VALUES (gen_random_uuid(), " + taskNo + ", 'subject', '" + status + "',"
                + " gen_random_uuid(), '" + root + "', gen_random_uuid(), 0)");
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
