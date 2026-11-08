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
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.1 (V135 / D-65): the {@code plugins} registry — the real PostgreSQL DDL.
 *
 * <p>This runs on <b>real PostgreSQL</b> (the project's migration-test base: one empty database per
 * class from {@link TestDatabaseProvider}, Flyway to head). The H2 suite cannot substitute: the
 * {@code h2} profile is {@code ddl-auto=create-drop} off the JPA entity, so it would invent the
 * table from {@code Plugin} and prove nothing about the migration.</p>
 *
 * <p>Every frozen item is asserted positively <b>and</b> by absence where it matters: the exact
 * column list (a dropped or an extra column fails), the composite PK, the partial unique index with
 * its predicate, the {@code jsonb} object CHECK by negative case, and the "no FK, no soft-delete"
 * shape. The behavioural consequences (one current row per id, an array manifest rejected, a second
 * current row refused) are why those constraints exist; "the table exists" alone would not catch
 * any of the regressions this migration is exposed to.</p>
 */
class PluginSchemaMigrationTest {

    static TestDatabaseProvider.DatabaseRef postgres =
            TestDatabaseProvider.migratedDatabase("plugin_schema");

    private static final String TABLE = "plugins";

    private static Connection connection;

    @BeforeAll
    static void migrateToHead() throws SQLException {
        Flyway.configure()
                .dataSource(postgres.jdbcUrl(), postgres.username(), postgres.password())
                .locations("classpath:db/migration")
                .load()
                .migrate();
        connection = DriverManager.getConnection(
                postgres.jdbcUrl(), postgres.username(), postgres.password());
    }

    // ------------------------------------------------------------------ migration chain

    @Test
    void v135AppliedOnTopOfTheDebindingChain() throws SQLException {
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '135' AND success"));
        assertTrue(scalarString(
                "SELECT description FROM flyway_schema_history WHERE version = '135'")
                .toLowerCase().contains("plan0691"),
                "V135 must be the PLAN-0691 plugins migration");

        // V133 (PLAN-0689) precedes it in the same chain: the registry addition must not depend on
        // the dropped session column, and must not resurrect it.
        assertTrue(strings(
                "SELECT column_name FROM information_schema.columns"
                        + " WHERE table_schema = 'public' AND table_name = 'sessions'")
                .stream().noneMatch("agent_principal_id"::equals),
                "V133 remains in force on this chain");
    }

    // ------------------------------------------------------------------ shape: columns

    @Test
    void tableCarriesExactlyTheFrozenColumns() throws SQLException {
        List<String> names = new ArrayList<>();
        List<String> types = new ArrayList<>();
        List<String> nullables = new ArrayList<>();
        List<Integer> lengths = new ArrayList<>();
        List<String> defaults = new ArrayList<>();
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(
                     "SELECT column_name, data_type, is_nullable, character_maximum_length,"
                             + " coalesce(column_default, '') FROM information_schema.columns"
                             + " WHERE table_schema = 'public' AND table_name = '" + TABLE + "'"
                             + " ORDER BY ordinal_position")) {
            while (rows.next()) {
                names.add(rows.getString(1));
                types.add(rows.getString(2));
                nullables.add(rows.getString(3));
                lengths.add(rows.getInt(4));
                defaults.add(rows.getString(5));
            }
        }

        // Exact list: D-65's shape has no deleted_at (uninstall is a hard delete), no
        // agent_principal_id (that identity lives on session_participants / chat_runs) and no
        // per-row package path (the directory decides the source).
        assertEquals(List.of("id", "digest", "version", "state", "source", "manifest",
                "is_current", "created_at", "updated_at"), names);

        // sha256: + 64 hex = 71 columns; 80 leaves room for a future algorithm prefix (D-65).
        assertEquals(List.of("character varying", "character varying", "character varying",
                "character varying", "character varying", "jsonb", "boolean",
                "timestamp with time zone", "timestamp with time zone"), types);
        assertEquals(List.of(128, 80, 64, 16, 16, 0, 0, 0, 0), lengths);
        assertTrue(nullables.stream().allMatch("NO"::equals), "every frozen column is NOT NULL");

        // Fail-closed defaults: a row cannot be inserted as enabled, and a version cannot become
        // current by omitting the flag. Timestamps are DB-side so a manual INSERT is still sane.
        assertEquals("'disabled'::character varying", defaults.get(3));
        assertEquals("false", defaults.get(6));
        assertEquals("now()", defaults.get(7));
        assertEquals("now()", defaults.get(8));
        assertTrue(defaults.get(0).isEmpty() && defaults.get(1).isEmpty()
                && defaults.get(2).isEmpty() && defaults.get(4).isEmpty()
                && defaults.get(5).isEmpty(), "identity and content columns have no default");
    }

    // ------------------------------------------------------------------ keys and constraints

    @Test
    void primaryKeyIsIdPlusDigest() throws SQLException {
        assertEquals(List.of("id", "digest"), strings(
                "SELECT kcu.column_name FROM information_schema.table_constraints tc"
                        + " JOIN information_schema.key_column_usage kcu"
                        + " ON kcu.constraint_name = tc.constraint_name"
                        + " AND kcu.constraint_schema = tc.constraint_schema"
                        + " WHERE tc.table_schema = 'public' AND tc.table_name = '" + TABLE + "'"
                        + " AND tc.constraint_type = 'PRIMARY KEY'"
                        + " ORDER BY kcu.ordinal_position"));

        assertEquals("pk_plugins", scalarString(
                "SELECT constraint_name FROM information_schema.table_constraints"
                        + " WHERE table_schema = 'public' AND table_name = '" + TABLE + "'"
                        + " AND constraint_type = 'PRIMARY KEY'"),
                "the PK must be explicitly named (checklist A)");
    }

    @Test
    void currentVersionIsUniquePerPluginId() throws SQLException {
        String definition = scalarString(
                "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'"
                        + " AND tablename = '" + TABLE + "' AND indexname = 'ux_plugins_current'");
        assertNotNull(definition, "D-65's backstop index must exist");
        assertTrue(definition.contains("CREATE UNIQUE INDEX"), definition);
        assertTrue(definition.contains("(id)"), definition);
        assertTrue(definition.contains("WHERE is_current"), definition);
    }

    @Test
    void manifestMustBeAJsonObject() throws SQLException {
        insertVersion("official.object-accept", "v1", "{\"manifestVersion\":\"1\"}");
        assertEquals(1, scalarInt("SELECT count(*) FROM plugins WHERE id = 'official.object-accept'"));

        // D-65: the CHECK is what makes "manifest is an object" a database fact, not a validator
        // convention.
        assertInsertFailsWith("23514", "invalid-array", "v1", "[]");
        assertInsertFailsWith("23514", "invalid-scalar", "v1", "\"not-an-object\"");
    }

    @Test
    void noForeignKeysBecauseTheCatalogRowIsStandalone() throws SQLException {
        assertEquals(0, scalarInt(
                "SELECT count(*) FROM information_schema.table_constraints"
                        + " WHERE table_schema = 'public' AND table_name = '" + TABLE + "'"
                        + " AND constraint_type = 'FOREIGN KEY'"),
                "V135 is additive and standalone; an FK here means the design changed");

        // The one and only CHECK is the jsonb object rule — the state/source vocabulary is
        // enforced by Plugin.STATE_* / SOURCE_* at the service layer, deliberately not by the DB.
        assertEquals(List.of("ck_plugins_manifest_object"), strings(
                "SELECT conname FROM pg_constraint"
                        + " WHERE conrelid = 'plugins'::regclass AND contype = 'c'"
                        + " ORDER BY conname"));
        assertTrue(scalarString(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint"
                        + " WHERE conrelid = 'plugins'::regclass AND contype = 'c'")
                .contains("jsonb_typeof"));
    }

    // ------------------------------------------------------------------ behaviour

    @Test
    void atMostOneCurrentVersionPerPluginIdAndDefaultsAreClosed() throws SQLException {
        insertVersion("official.kv", "v1");
        insertVersion("official.kv", "v2");

        assertEquals(2, scalarInt("SELECT count(*) FROM plugins WHERE id = 'official.kv'"));
        assertEquals("disabled", scalarString(
                "SELECT state FROM plugins WHERE id = 'official.kv' AND digest = 'v1'"));
        assertEquals(0, scalarInt("SELECT count(*) FROM plugins WHERE is_current"
                        + " AND id IN ('official.kv', 'official.other')"),
                "is_current defaults to false for every inserted row");

        execute("UPDATE plugins SET is_current = TRUE WHERE id = ? AND digest = ?",
                "official.kv", "v1");
        assertEquals(1, scalarInt("SELECT count(*) FROM plugins WHERE id = 'official.kv'"
                + " AND is_current"));

        // The DB refuses a second current row for the same id even if the service layer's advisory
        // lock were bypassed; the partial index is the invariant, not a hint.
        assertUpdateFailsWith("23505", "official.kv", "v2");

        // Different ids are independent: both may be current.
        insertVersion("official.other", "v1");
        execute("UPDATE plugins SET is_current = TRUE WHERE id = ? AND digest = ?",
                "official.other", "v1");
        assertEquals(2, scalarInt("SELECT count(*) FROM plugins WHERE is_current"
                + " AND id IN ('official.kv', 'official.other')"));
    }

    @Test
    void updateOfAVersionRowKeepsTheIdentity() throws SQLException {
        insertVersion("official.lifecycle", "v1");
        execute("UPDATE plugins SET state = 'enabled', version = '1.2.0'"
                + " WHERE id = 'official.lifecycle' AND digest = 'v1'");

        assertEquals(1, scalarInt("SELECT count(*) FROM plugins WHERE id = 'official.lifecycle'"),
                "the row is updated in place, not replaced");
        assertEquals("enabled", scalarString(
                "SELECT state FROM plugins WHERE id = 'official.lifecycle'"));
        assertEquals("1.2.0", scalarString(
                "SELECT version FROM plugins WHERE id = 'official.lifecycle'"));
    }

    // ------------------------------------------------------------------ helpers

    private static void insertVersion(String id, String digest) throws SQLException {
        insertVersion(id, digest, "{\"manifestVersion\":\"1\"}");
    }

    private static void insertVersion(String id, String digest, String manifestJson)
            throws SQLException {
        execute("INSERT INTO plugins (id, digest, version, source, manifest)"
                        + " VALUES (?, ?, '1.0.0', 'builtin', ?::jsonb)",
                id, digest, manifestJson);
    }

    private static void assertUpdateFailsWith(String sqlState, String id, String digest)
            throws SQLException {
        SQLException failure = assertThrows(SQLException.class,
                () -> execute("UPDATE plugins SET is_current = TRUE"
                        + " WHERE id = ? AND digest = ?", id, digest));
        assertEquals(sqlState, failure.getSQLState(), failure.getMessage());
    }

    private static void assertInsertFailsWith(String sqlState, String id, String digest,
            String manifestJson) throws SQLException {
        SQLException failure = assertThrows(SQLException.class,
                () -> insertVersion(id, digest, manifestJson));
        assertEquals(sqlState, failure.getSQLState(), failure.getMessage());
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

    private static List<String> strings(String sql) throws SQLException {
        List<String> values = new ArrayList<>();
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery(sql)) {
            while (result.next()) {
                values.add(result.getString(1));
            }
        }
        return values;
    }
}
