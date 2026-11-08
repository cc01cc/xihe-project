package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
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
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0705 / BL-515: the V145 rollback script is executable and never silent.
 *
 * <p>Two states are drilled on independent Testcontainers clones (never the dev PG):
 * empty (rollback restores NOT NULL + drops the partial index, and is idempotent) and
 * with-NULL data (the precheck blocks the rollback and names table.column + row count).</p>
 */
class V145RollbackScriptTest {

    private static final String SCRIPT = "db/rollback/R145__plan0647_workspaceless_sessions.down.sql";
    private static final List<String> TABLES =
            List.of("sessions", "chat_runs", "context_events", "context_projections");

    private static TestDatabaseProvider.DatabaseRef emptyDb;
    private static TestDatabaseProvider.DatabaseRef dataDb;
    private static String script;

    @BeforeAll
    static void prepare() throws IOException, SQLException {
        emptyDb = TestDatabaseProvider.migratedDatabase("r145_rollback_empty");
        dataDb = TestDatabaseProvider.migratedDatabase("r145_rollback_data");
        migrate(emptyDb);
        migrate(dataDb);
        try (InputStream in = V145RollbackScriptTest.class.getClassLoader().getResourceAsStream(SCRIPT)) {
            if (in == null) {
                throw new IllegalStateException("missing rollback script " + SCRIPT);
            }
            script = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static void migrate(TestDatabaseProvider.DatabaseRef database) {
        Flyway.configure()
                .dataSource(database.jdbcUrl(), database.username(), database.password())
                .locations("classpath:db/migration")
                .load()
                .migrate();
    }

    @Test
    void emptyDatabaseRollsBackToNotNullAndIsIdempotent() throws SQLException {
        try (Connection connection = connect(emptyDb)) {
            execute(connection, script);
            assertNotNullColumns(connection);

            // Idempotent: a retried rollback is a no-op, not an error.
            execute(connection, script);
            assertNotNullColumns(connection);
            try (Statement statement = connection.createStatement();
                 ResultSet rs = statement.executeQuery(
                         "SELECT count(*) FROM pg_indexes WHERE indexname ="
                                 + " 'idx_sessions_user_active_no_workspace'")) {
                rs.next();
                assertEquals(0, rs.getInt(1), "the pure-chat partial index must be dropped");
            }
        }
    }

    @Test
    void nullRowsBlockRollbackWithActionableError() throws SQLException {
        UUID userId = UUID.randomUUID();
        UUID sessionId = UUID.randomUUID();
        try (Connection connection = connect(dataDb)) {
            try (Statement statement = connection.createStatement()) {
                statement.execute("INSERT INTO users (id, email, username, password_hash) VALUES ('"
                        + userId + "', 'r145-" + userId + "@test.local', 'r145-" + userId.toString().substring(0, 8) + "', 'x')");
                statement.execute("INSERT INTO sessions (id, user_id, title, workspace_id) VALUES ('"
                        + sessionId + "', '" + userId + "', 'rollback drill', NULL)");
            }

            SQLException blocked = assertThrows(SQLException.class, () -> execute(connection, script));
            String message = rootMessage(blocked);
            assertTrue(message.contains("V145 rollback blocked"), message);
            assertTrue(message.contains("sessions.workspace_id=1 rows"), message);
            // The precheck runs before any DDL: the four columns must still be nullable.
            assertNullableColumns(connection);

            try (Statement statement = connection.createStatement()) {
                statement.execute("DELETE FROM sessions WHERE id = '" + sessionId + "'");
                statement.execute("DELETE FROM users WHERE id = '" + userId + "'");
            }
            execute(connection, script);
            assertNotNullColumns(connection);
        }
    }

    private static Connection connect(TestDatabaseProvider.DatabaseRef database) throws SQLException {
        return DriverManager.getConnection(database.jdbcUrl(), database.username(), database.password());
    }

    private static void assertNotNullColumns(Connection connection) throws SQLException {
        for (String table : TABLES) {
            assertFalse(isNullable(connection, table), table + ".workspace_id must be NOT NULL");
        }
    }

    private static void assertNullableColumns(Connection connection) throws SQLException {
        for (String table : TABLES) {
            assertTrue(isNullable(connection, table), table + ".workspace_id must still be nullable");
        }
    }

    private static boolean isNullable(Connection connection, String table) throws SQLException {
        try (java.sql.PreparedStatement statement = connection.prepareStatement(
                "SELECT is_nullable FROM information_schema.columns"
                        + " WHERE table_name = ? AND column_name = 'workspace_id'")) {
            statement.setString(1, table);
            try (ResultSet rs = statement.executeQuery()) {
                if (!rs.next()) {
                    throw new IllegalStateException("missing column " + table + ".workspace_id");
                }
                return "YES".equals(rs.getString(1));
            }
        }
    }

    private static String rootMessage(Throwable failure) {
        StringBuilder message = new StringBuilder();
        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
            if (cause.getMessage() != null) {
                message.append(cause.getMessage()).append(' ');
            }
        }
        return message.toString();
    }

    private static void execute(Connection connection, String sql) throws SQLException {
        for (String statement : statements(sql)) {
            if (!statement.isBlank()) {
                try (Statement jdbc = connection.createStatement()) {
                    jdbc.execute(statement);
                }
            }
        }
    }

    /** Split on ';' while respecting single-quoted literals and {@code $$} blocks. */
    private static List<String> statements(String sql) {
        List<String> out = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        boolean inSingle = false;
        boolean inDollar = false;
        for (int i = 0; i < sql.length(); i++) {
            char c = sql.charAt(i);
            if (!inSingle && c == '$' && i + 1 < sql.length() && sql.charAt(i + 1) == '$') {
                inDollar = !inDollar;
                current.append("$$");
                i++;
                continue;
            }
            if (!inDollar && c == '\'') {
                if (inSingle && i + 1 < sql.length() && sql.charAt(i + 1) == '\'') {
                    current.append("''");
                    i++;
                    continue;
                }
                inSingle = !inSingle;
            }
            if (c == ';' && !inSingle && !inDollar) {
                out.add(current.toString());
                current.setLength(0);
                continue;
            }
            current.append(c);
        }
        if (!current.toString().isBlank()) {
            out.add(current.toString());
        }
        return out;
    }
}
