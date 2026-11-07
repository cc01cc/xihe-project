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
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.5 (V141 / DP-1 / DP-6a / DP-7): the real PostgreSQL DDL of {@code plugin_kv}.
 *
 * <p>Real PG + Flyway to head, same base as {@link PluginBindingSchemaMigrationTest}: the {@code h2}
 * profile is {@code ddl-auto=create-drop} over JPA entities, and this table has no entity, so H2 can
 * never prove any of it.
 *
 * <p>Two groups of assertions, and the second group is the point:
 * <ul>
 *   <li><b>shape</b> — the frozen columns, the composite primary key and the three indexes (the
 *       prefix one with {@code text_pattern_ops} because the default collation cannot serve
 *       {@code LIKE 'p%'});</li>
 *   <li><b>behaviour</b> — <b>DP-6a</b>: this table has <i>no</i> foreign key to
 *       {@code plugin_bindings}, so a KV row may outlive its binding (orphan), an uninstall is never
 *       blocked by leftover KV data, and the (workspace, plugin) slot is free again immediately. Those
 *       three facts are exactly why option C was ruled over CASCADE/RESTRICT, so they are asserted
 *       against a real database rather than trusted to the DDL text.</li>
 * </ul>
 */
class PluginKvSchemaMigrationTest {

    static TestDatabaseProvider.DatabaseRef postgres =
            TestDatabaseProvider.emptyDatabase("plugin_kv_schema");

    private static final String KV = "plugin_kv";

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
    void v141AppliedOnTopOfThePluginChain() throws SQLException {
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '141' AND success"));
        assertTrue(scalarString(
                "SELECT description FROM flyway_schema_history WHERE version = '141'")
                .toLowerCase().contains("plan0691"),
                "V141 must be the PLAN-0691 KV migration");
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '137' AND success"),
                "V137 (plugin atoms) stays in force; V141 is purely additive");
    }

    // ------------------------------------------------------------------ shape: columns

    @Test
    void kvCarriesExactlyTheFrozenColumns() throws SQLException {
        List<String> names = new ArrayList<>();
        List<String> types = new ArrayList<>();
        List<String> nullables = new ArrayList<>();
        List<Integer> lengths = new ArrayList<>();
        List<String> defaults = new ArrayList<>();
        readColumns(names, types, nullables, lengths, defaults);

        // DP-1 + the Lead's 2026-11-08 correction: `version` (not `revision`), and `orphaned_at` as the
        // explicit clock the T3.2 purge job reads (falling back to updated_at).
        assertEquals(List.of("binding_id", "namespace", "key", "value", "version", "expires_at",
                "orphaned_at", "updated_at"), names);
        assertEquals(List.of("uuid", "character varying", "character varying", "jsonb", "bigint",
                "timestamp with time zone", "timestamp with time zone", "timestamp with time zone"),
                types);
        assertEquals(List.of("NO", "NO", "NO", "NO", "NO", "YES", "YES", "NO"), nullables);
        // CP-side guards: the namespace/key widths are not a spec number, they are what the service
        // rejects before the row is attempted (PluginKvService MAX_NAMESPACE_LENGTH/MAX_KEY_LENGTH).
        assertEquals(List.of(0, 64, 256, 0, 0, 0, 0, 0), lengths);
        assertTrue(defaults.get(4).startsWith("1"), "version defaults to 1, got " + defaults.get(4));
        assertTrue(defaults.get(7).toLowerCase().contains("now()"),
                "updated_at defaults to now(), got " + defaults.get(7));
    }

    @Test
    void primaryKeyIsTheFullPointLookupTuple() throws SQLException {
        // DP-1: (binding_id, namespace, key). Every API-1/2/3 read is a full-tuple lookup.
        assertEquals(List.of("binding_id", "namespace", "key"), strings(
                "SELECT a.attname FROM pg_index i"
                        + " JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)"
                        + " WHERE i.indrelid = 'plugin_kv'::regclass AND i.indisprimary"
                        + " ORDER BY array_position(i.indkey, a.attnum)"));
    }

    @Test
    void indexesServeTheThreeAccessPathsTheSpecNames() throws SQLException {
        String prefix = indexDefinition("idx_plugin_kv_prefix");
        assertNotNull(prefix, "idx_plugin_kv_prefix is missing");
        assertTrue(prefix.contains("(binding_id, namespace, key"),
                "prefix index must lead with binding_id + namespace: " + prefix);
        // Default collation btree cannot answer LIKE 'p%'; text_pattern_ops is what makes API-4 a
        // range scan instead of a seq scan.
        assertTrue(prefix.contains("text_pattern_ops"), "prefix index needs text_pattern_ops: " + prefix);

        String expires = indexDefinition("idx_plugin_kv_expires_at");
        assertNotNull(expires, "idx_plugin_kv_expires_at is missing");
        assertTrue(expires.contains("(expires_at)"), expires);
        assertTrue(expires.contains("WHERE (expires_at IS NOT NULL)"),
                "expiry sweep index must be partial: " + expires);

        String orphaned = indexDefinition("idx_plugin_kv_orphaned_at");
        assertNotNull(orphaned, "idx_plugin_kv_orphaned_at is missing");
        assertTrue(orphaned.contains("(orphaned_at)"), orphaned);
        assertTrue(orphaned.contains("WHERE (orphaned_at IS NOT NULL)"),
                "purge scan entry must be partial: " + orphaned);
    }

    // ------------------------------------------------------------------ DP-6a: no foreign key

    @Test
    void kvHasNoForeignKeyAtAll() throws SQLException {
        // DP-6a, the ruling itself: "FK 语义改由应用层维护". A CASCADE would delete the rows LC-6 needs
        // to keep alive; a RESTRICT would block uninstall behind KV data. So: zero FKs, and this test
        // fails the day somebody "fixes" that.
        assertEquals(List.of(), strings(
                "SELECT conname FROM pg_constraint"
                        + " WHERE conrelid = 'plugin_kv'::regclass AND contype = 'f'"),
                "plugin_kv must stay FK-free (spec/data-plane.md DP-6a)");
    }

    @Test
    void kvRowMayExistForABindingThatNeverExisted() throws SQLException {
        // Direct consequence of the missing FK, asserted so the degradation is visible rather than
        // discovered in production: the DB cannot tell a live binding from a deleted one.
        UUID phantom = UUID.randomUUID();
        insertKvRow(phantom, "default", "orphan-by-construction", "{\"v\":1}", null);
        assertEquals(1, scalarInt("SELECT count(*) FROM plugin_kv WHERE binding_id = '"
                + phantom + "'"));
    }

    // ------------------------------------------------------------------ DP-6a: orphan lifecycle

    @Test
    void uninstallIsNotBlockedAndLeavesAnOrphanRow() throws SQLException {
        UUID workspaceId = seedWorkspace();
        String pluginId = "official.orphan-probe";
        insertPlugin(pluginId, "sha256:orphan-probe");
        UUID bindingId = insertBinding(workspaceId, pluginId, "sha256:orphan-probe", "enabled");

        insertKvRow(bindingId, "default", "counter", "{\"n\":7}", null);

        // 1. Deleting the binding must succeed — with ON DELETE RESTRICT this is the statement that
        //    would fail, and with CASCADE the row below would disappear.
        execute("DELETE FROM plugin_bindings WHERE id = ?", bindingId);

        // 2. LC-6/V6: the KV row survives, still naming the dead binding — the orphan T3.2 purges
        //    after the grace window measured from orphaned_at (fallback updated_at).
        assertEquals(1, scalarInt("SELECT count(*) FROM plugin_kv WHERE binding_id = '"
                + bindingId + "'"));

        // 3. Reinstalling the same plugin in the same workspace is not blocked by that orphan: the
        //    (workspace_id, plugin_id) slot was freed by the delete, which is what makes
        //    uq_plugin_bindings_workspace_plugin survive option C.
        UUID rebound = insertBinding(workspaceId, pluginId, "sha256:orphan-probe", "pending");
        assertEquals(1, scalarInt("SELECT count(*) FROM plugin_bindings WHERE workspace_id = '"
                + workspaceId + "' AND plugin_id = '" + pluginId + "'"),
                "the reinstall must not be blocked by the orphan (" + rebound + ")");

        // 4. The purge predicate the T3.2 job will use is expressible against the surviving row.
        execute("UPDATE plugin_kv SET orphaned_at = now() - interval '604801 seconds'"
                + " WHERE binding_id = ?", bindingId);
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM plugin_kv WHERE coalesce(orphaned_at, updated_at)"
                        + " < now() - interval '604800 seconds'"));
    }

    // ------------------------------------------------------------------ constraints

    @Test
    void duplicateTripleIsRejectedByThePrimaryKey() throws SQLException {
        UUID bindingId = UUID.randomUUID();
        insertKvRow(bindingId, "default", "dup", "{\"v\":1}", null);
        assertSqlState("23505", () ->
                insertKvRow(bindingId, "default", "dup", "{\"v\":2}", null));
    }

    @Test
    void versionMustStartAtOne() throws SQLException {
        UUID bindingId = UUID.randomUUID();
        assertSqlState("23514", () -> execute(
                "INSERT INTO plugin_kv (binding_id, namespace, key, value, version)"
                        + " VALUES (?, 'default', 'zero', '{}'::jsonb, 0)", bindingId));
    }

    @Test
    void valueIsMandatory() throws SQLException {
        UUID bindingId = UUID.randomUUID();
        assertSqlState("23502", () -> execute(
                "INSERT INTO plugin_kv (binding_id, namespace, key, value)"
                        + " VALUES (?, 'default', 'null-value', NULL)", bindingId));
    }

    @Test
    void expiresAtAndOrphanedAtAreNullableTimestamps() throws SQLException {
        UUID bindingId = UUID.randomUUID();
        insertKvRow(bindingId, "default", "ttl", "{}", "now() + interval '60 seconds'");
        assertEquals(1, scalarInt("SELECT count(*) FROM plugin_kv WHERE binding_id = '"
                + bindingId + "' AND expires_at IS NOT NULL AND orphaned_at IS NULL"));
    }

    // ------------------------------------------------------------------ helpers

    private static void readColumns(List<String> names, List<String> types, List<String> nullables,
            List<Integer> lengths, List<String> defaults) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(
                     "SELECT column_name, data_type, is_nullable, character_maximum_length,"
                             + " coalesce(column_default, '') FROM information_schema.columns"
                             + " WHERE table_schema = 'public' AND table_name = '" + KV + "'"
                             + " ORDER BY ordinal_position")) {
            while (rows.next()) {
                names.add(rows.getString(1));
                types.add(rows.getString(2));
                nullables.add(rows.getString(3));
                lengths.add(rows.getInt(4));
                defaults.add(rows.getString(5));
            }
        }
    }

    private static String indexDefinition(String indexName) throws SQLException {
        return scalarString(
                "SELECT indexdef FROM pg_indexes WHERE tablename = '" + KV + "'"
                        + " AND indexname = '" + indexName + "'");
    }

    private static UUID seedWorkspace() throws SQLException {
        UUID workspaceId = UUID.randomUUID();
        execute("INSERT INTO workspaces (id, name) VALUES (?, ?)",
                workspaceId, "kv-ws-" + workspaceId);
        return workspaceId;
    }

    private static void insertPlugin(String pluginId, String digest) throws SQLException {
        execute("INSERT INTO plugins (id, digest, version, source, manifest)"
                        + " VALUES (?, ?, '1.0.0', 'builtin', '{\"manifestVersion\":\"1\"}'::jsonb)",
                pluginId, digest);
    }

    private static UUID insertBinding(UUID workspaceId, String pluginId, String digest, String state)
            throws SQLException {
        UUID bindingId = UUID.randomUUID();
        execute("INSERT INTO plugin_bindings (id, plugin_id, digest, version, workspace_id, state)"
                + " VALUES (?, ?, ?, '1.0.0', ?, ?)", bindingId, pluginId, digest, workspaceId, state);
        return bindingId;
    }

    /** {@code expiresAt} is a raw SQL expression so the test can express relative time in the DB. */
    private static void insertKvRow(UUID bindingId, String namespace, String key, String jsonText,
            String expiresAt) throws SQLException {
        String expires = expiresAt == null ? "NULL" : expiresAt;
        execute("INSERT INTO plugin_kv (binding_id, namespace, key, value, expires_at)"
                + " VALUES (?, ?, ?, CAST(? AS jsonb), " + expires + ")",
                bindingId, namespace, key, jsonText);
    }

    private static void assertSqlState(String sqlState, SqlCall call) {
        SQLException failure = assertThrows(SQLException.class, call::run);
        assertEquals(sqlState, failure.getSQLState(), failure.getMessage());
    }

    private interface SqlCall {
        void run() throws SQLException;
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
