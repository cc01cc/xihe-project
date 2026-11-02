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
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * PLAN-0624 M2 (V94): the wake-schedule projection columns on scheduled_tasks.
 * wake_config stays the config truth; the scheduled_tasks row is the dispatch projection
 * (D24-06). Existing user rows backfill origin='user' via the DEFAULT.
 */
class WakeScheduleProjectionMigrationTest {
    /** PLAN-eff/task-13 M1（A1）：空库由 JVM 单例容器下发；本类仍自行 Flyway 到目标版本。 */
    static TestDatabaseProvider.DatabaseRef postgres = TestDatabaseProvider.emptyDatabase("wake_schedule");

    private static final UUID USER_ID = UUID.randomUUID();
    private static final UUID WORKSPACE_ID = UUID.randomUUID();
    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID LEGACY_TASK_ID = UUID.randomUUID();

    private static Connection connection;

    @BeforeAll
    static void seedLegacyTaskThenMigrate() throws SQLException {
        String url = postgres.jdbcUrl();
        migrate(url, "93");
        connection = DriverManager.getConnection(url, postgres.username(), postgres.password());
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + USER_ID
                + "', 'plan0624-wake@test.local', 'x', 'plan0624wake')");
        execute("INSERT INTO workspaces (id, name) VALUES ('" + WORKSPACE_ID + "', 'wake ws')");
        execute("INSERT INTO sessions (id, workspace_id, user_id, title) VALUES ('" + SESSION_ID
                + "', '" + WORKSPACE_ID + "', '" + USER_ID + "', 'wake session')");
        execute("INSERT INTO scheduled_tasks (id, workspace_id, user_id, trigger_kind, timezone,"
                + " target_kind, target_session_id, prompt, status, next_fire_at, expires_at)"
                + " VALUES ('" + LEGACY_TASK_ID + "', '" + WORKSPACE_ID + "', '" + USER_ID
                + "', 'delay_once', 'UTC', 'session_wakeup', '" + SESSION_ID
                + "', 'legacy prompt', 'scheduled', NOW() + INTERVAL '1 hour',"
                + " NOW() + INTERVAL '2 hours')");
        migrate(url, null);
    }

    @Test
    void intervalAndParticipantWakeJoinTheVocabulary() throws SQLException {
        UUID task = insertTask("interval", "participant_wake", 300, null);
        assertNotNull(task, "interval trigger + participant_wake target are valid after V94");
        // The CHECKs govern the prompt/target pairing, not which targets may use interval:
        // session_wakeup + prompt stays valid DB-level; the API layer owns user trigger kinds.
        assertNotNull(insertTask("interval", "session_wakeup", 300, "prompt!"));
        assertThrows(SQLException.class,
                () -> insertTask("interval", "participant_wake", 30, null),
                "sub-minute intervals are rejected at the CHECK (>= 60s)");
        assertThrows(SQLException.class,
                () -> insertTask("interval", "participant_wake", null, null),
                "interval without interval_seconds violates the contract");
        assertThrows(SQLException.class,
                () -> insertTask("cron", "participant_wake", 300, null),
                "cron keeps its own trigger kind");
    }

    @Test
    void legacyUserTasksBackfillToOriginUser() throws SQLException {
        List<String[]> rows = query("SELECT origin FROM scheduled_tasks WHERE id = '"
                + LEGACY_TASK_ID + "'");
        assertEquals(1, rows.size());
        assertEquals("user", rows.getFirst()[0], "every pre-V94 row is a user-created task");
        assertEquals(1, query("SELECT id FROM scheduled_tasks WHERE origin = 'user'").size(),
                "the seeded legacy task is exactly the backfilled row count");
    }

    @Test
    void systemWakeProjectionShapeIsEnforced() throws SQLException {
        UUID task = insertTask("interval", "participant_wake", 120, null);
        execute("UPDATE scheduled_tasks SET origin = 'system' WHERE id = '" + task + "'");
        List<String[]> rows = query("SELECT origin, interval_seconds, prompt FROM scheduled_tasks"
                + " WHERE id = '" + task + "'");
        assertEquals("system", rows.getFirst()[0]);
        assertEquals("120", rows.getFirst()[1]);
        assertNull(rows.getFirst()[2], "participant_wake rows carry payload, never a prompt");
    }

    @Test
    void intervalSecondsAbsentForLegacyTriggers() throws SQLException {
        List<String[]> rows = query("SELECT interval_seconds FROM scheduled_tasks WHERE id = '"
                + LEGACY_TASK_ID + "'");
        assertNull(rows.getFirst()[0], "delay_once keeps interval_seconds NULL");
    }

    @Test
    void wakeConfigColumnExistsOnParticipants() throws SQLException {
        List<String[]> rows = query("SELECT data_type, is_nullable FROM information_schema.columns"
                + " WHERE table_schema = 'public' AND table_name = 'session_participants'"
                + " AND column_name = 'wake_config'");
        assertEquals(1, rows.size());
        assertEquals("jsonb", rows.getFirst()[0]);
        assertEquals("YES", rows.getFirst()[1]);
    }

    private static UUID insertTask(String trigger, String target, Integer intervalSeconds,
                                   String prompt) throws SQLException {
        UUID id = UUID.randomUUID();
        String interval = intervalSeconds == null ? "NULL" : String.valueOf(intervalSeconds);
        String promptValue = prompt == null ? "NULL" : "'" + prompt + "'";
        execute("INSERT INTO scheduled_tasks (id, workspace_id, user_id, trigger_kind, timezone,"
                + " target_kind, target_session_id, prompt, payload, status, next_fire_at,"
                + " interval_seconds) VALUES ('" + id + "', '" + WORKSPACE_ID + "', '" + USER_ID
                + "', '" + trigger + "', 'UTC', '" + target + "', '" + SESSION_ID + "', "
                + promptValue + ", '{\"participantId\":\"" + UUID.randomUUID() + "\"}',"
                + " 'scheduled', NOW() + INTERVAL '1 hour', " + interval + ")");
        return id;
    }

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
}
