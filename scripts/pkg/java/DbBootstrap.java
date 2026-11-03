import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Locale;

/**
 * PLAN-0632 M2-3: first-run bootstrap for the bundled PostgreSQL — role, database and the
 * {@code vector} extension, each step <b>verified with a real query over a real TCP connection</b>.
 *
 * <p>Why this exists instead of a shell script: the zonky payload the installer ships is the
 * <i>server-only</i> runtime (PLAN-0632 D32-15). There is no {@code psql}, {@code pg_dump},
 * {@code pg_isready} or {@code pg_config} in it, so the only SQL client available on a clean machine
 * is the JDBC driver we already ship for the control plane. D32-13 also proves that
 * {@code postgres --single} exits 0 even when the SQL failed, which makes exit codes useless as a
 * signal — hence every step below is followed by a {@code SELECT} that must return a row.</p>
 *
 * <p>Idempotent by construction: it is safe to run on every start. "created" vs "verified" is what
 * the launcher logs, so the second run of an install reads as {@code verified}, not as work.</p>
 *
 * <p>Built at packaging time (not part of the Maven build): {@code javac DbBootstrap.java} into
 * {@code bootstrap/db-bootstrap.jar} next to the PostgreSQL JDBC driver.</p>
 *
 * <p>Exit codes: 0 = every step verified; 1 = a step failed (the message names the step);
 * 2 = bad arguments. The password is never printed.</p>
 */
public final class DbBootstrap {

    private static final String ROLE = "xihe";
    private static final String EXTENSION = "vector";
    private static final String MAINTENANCE_DB = "postgres";

    private DbBootstrap() {
    }

    public static void main(String[] args) {
        String host = "127.0.0.1";
        String port = "12634";
        String user = ROLE;
        String password = "";
        String database = "xihe";
        for (int index = 0; index < args.length; index++) {
            String arg = args[index];
            String value = index + 1 < args.length ? args[index + 1] : null;
            switch (arg) {
                case "--host" -> host = require(value, arg);
                case "--port" -> port = require(value, arg);
                case "--user" -> user = require(value, arg);
                case "--password" -> password = require(value, arg);
                case "--database" -> database = require(value, arg);
                default -> fail(2, "unknown argument " + arg);
            }
            index++;
        }
        if (password.isBlank()) {
            // The launcher passes the generated password through the environment so it never shows
            // up in a process command line (the only reason --password still exists is manual use).
            String fromEnv = System.getenv("XIHE_BOOTSTRAP_PG_PASSWORD");
            if (fromEnv != null) {
                password = fromEnv;
            }
        }
        if (password.isBlank()) {
            fail(2, "no password: pass --password or set XIHE_BOOTSTRAP_PG_PASSWORD");
        }
        String base = "jdbc:postgresql://" + host + ":" + port + "/";
        try {
            bootstrapRoleAndDatabase(base, user, password, database);
            verifyApplicationDatabase(base, user, password, database);
        } catch (SQLException error) {
            fail(1, error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        System.out.println("bootstrap: OK");
    }

    private static void bootstrapRoleAndDatabase(String base, String user, String password, String database)
            throws SQLException {
        try (Connection connection = DriverManager.getConnection(base + MAINTENANCE_DB, user, password)) {
            connection.setAutoCommit(true);

            // --- role ---------------------------------------------------
            // `initdb -U xihe` already creates the superuser, so this is normally "present". The
            // CREATE branch exists for a cluster initialized by something else (e.g. a manually
            // restored data directory) and still ends with a verification query.
            if (scalar(connection, "SELECT 1 FROM pg_roles WHERE rolname = ?", ROLE) == null) {
                execute(connection, "CREATE ROLE " + quoteIdentifier(ROLE) + " LOGIN SUPERUSER PASSWORD "
                        + quoteLiteral(password));
                System.out.println("role: " + ROLE + " created");
            } else {
                System.out.println("role: " + ROLE + " present");
            }
            requireScalar(connection, "role", "SELECT 1 FROM pg_roles WHERE rolname = ?", ROLE);

            // --- database -----------------------------------------------
            if (scalar(connection, "SELECT 1 FROM pg_database WHERE datname = ?", database) == null) {
                // CREATE DATABASE cannot run inside a transaction block; autoCommit is on and the
                // driver sends it as a plain statement.
                execute(connection, "CREATE DATABASE " + quoteIdentifier(database) + " OWNER "
                        + quoteIdentifier(ROLE));
                System.out.println("database: " + database + " created");
            } else {
                System.out.println("database: " + database + " verified");
            }
            requireScalar(connection, "database", "SELECT 1 FROM pg_database WHERE datname = ?", database);
        }
    }

    private static void verifyApplicationDatabase(String base, String user, String password, String database)
            throws SQLException {
        try (Connection connection = DriverManager.getConnection(base + database, user, password)) {
            connection.setAutoCommit(true);
            // IF NOT EXISTS is a guard, not a verification: if the payload lacks vector.control the
            // statement throws "extension is not available" (PLAN-0632 D32-13) — exactly the failure
            // we want to see here rather than 60 seconds later inside Flyway.
            execute(connection, "CREATE EXTENSION IF NOT EXISTS " + EXTENSION);
            String version = scalar(connection, "SELECT extversion FROM pg_extension WHERE extname = ?", EXTENSION);
            if (version == null) {
                throw new SQLException("step=extension: pg_extension has no row for " + EXTENSION);
            }
            System.out.println("extension: " + EXTENSION + " " + version + " verified");
            try (Statement statement = connection.createStatement();
                 ResultSet result = statement.executeQuery("SELECT current_user, current_database(), 1")) {
                if (!result.next()) {
                    throw new SQLException("step=verify: SELECT returned no row");
                }
                System.out.println("verify: connected as " + result.getString(1) + " to "
                        + result.getString(2) + ", SELECT 1 = " + result.getInt(3));
            }
        }
    }

    /** One nullable column of the first row (NULL when there is no row). */
    private static String scalar(Connection connection, String sql, String parameter) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, parameter);
            try (ResultSet result = statement.executeQuery()) {
                return result.next() ? result.getString(1) : null;
            }
        }
    }

    private static void requireScalar(Connection connection, String step, String sql, String parameter)
            throws SQLException {
        if (scalar(connection, sql, parameter) == null) {
            throw new SQLException("step=" + step + ": verification query returned no row for " + parameter);
        }
    }

    private static void execute(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private static String quoteIdentifier(String identifier) {
        if (!identifier.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            fail(2, "identifier is not a plain name: " + identifier);
        }
        return "\"" + identifier + "\"";
    }

    private static String quoteLiteral(String value) {
        return "'" + value.replace("'", "''") + "'";
    }

    private static String require(String value, String flag) {
        if (value == null || value.isBlank()) {
            fail(2, flag + " needs a value");
        }
        return value;
    }

    private static void fail(int code, String message) {
        System.err.println("bootstrap: " + message.toLowerCase(Locale.ROOT));
        System.exit(code);
    }
}
