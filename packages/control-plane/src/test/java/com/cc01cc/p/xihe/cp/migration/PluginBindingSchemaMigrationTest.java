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
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.2 (V136 / D-65 ②③ / DP-6 / SEC-2): the real PostgreSQL DDL of
 * {@code plugin_bindings} + {@code session_plugin_bindings}.
 *
 * <p>Real PG and Flyway to head, same base as {@code PluginSchemaMigrationTest}: the {@code h2}
 * profile is {@code ddl-auto=create-drop} off the JPA entities, so it can never prove a constraint
 * that only exists in the migration.</p>
 *
 * <p>The decisive assertions are behavioural, not structural:</p>
 * <ul>
 *   <li>D-65 ② — deleting a {@code plugins} row that a binding still names fails with
 *       {@code 23503} (composite FK, ON DELETE RESTRICT). This is what makes the uninstall guard a
 *       real invariant instead of an application check that a future writer can forget.</li>
 *   <li>DP-6 — deleting the binding removes its attachments, deleting the session removes its own
 *       attachments, and the attachment row carries no {@code workspace_id}/{@code user_id}.</li>
 *   <li>SEC-2 — the five lowercase states are the only values the DB accepts.</li>
 * </ul>
 */
class PluginBindingSchemaMigrationTest {

    static TestDatabaseProvider.DatabaseRef postgres =
            TestDatabaseProvider.emptyDatabase("plugin_binding_schema");

    private static final String BINDINGS = "plugin_bindings";
    private static final String ATTACHMENTS = "session_plugin_bindings";

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
    void v136AppliedOnTopOfTheRegistry() throws SQLException {
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '136' AND success"));
        assertTrue(scalarString(
                "SELECT description FROM flyway_schema_history WHERE version = '136'")
                .toLowerCase().contains("plan0691"),
                "V136 must be the PLAN-0691 binding migration");
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '135' AND success"),
                "V135 stays in force: V136 references plugins(id, digest)");
    }

    // ------------------------------------------------------------------ shape: columns

    @Test
    void bindingsCarryExactlyTheFrozenColumns() throws SQLException {
        List<String> names = new ArrayList<>();
        List<String> types = new ArrayList<>();
        List<String> nullables = new ArrayList<>();
        List<Integer> lengths = new ArrayList<>();
        List<String> defaults = new ArrayList<>();
        readColumns(BINDINGS, names, types, nullables, lengths, defaults);

        // DP-6: one workspace axis (workspace_id) and no user_id — the binding is workspace-scoped,
        // the snapshot is the only per-session artifact.
        assertEquals(List.of("id", "plugin_id", "digest", "version", "workspace_id", "scope_type",
                "state", "granted_atoms", "grant_source", "created_at", "updated_at"), names);
        assertEquals(List.of("uuid", "character varying", "character varying", "character varying",
                "uuid", "character varying", "character varying", "jsonb", "character varying",
                "timestamp with time zone", "timestamp with time zone"), types);
        assertEquals(List.of(0, 128, 80, 64, 0, 16, 16, 0, 32, 0, 0), lengths);
        assertTrue(nullables.stream().allMatch("NO"::equals), "every frozen column is NOT NULL");

        // Fail-closed defaults: a row cannot be born enabled, cannot be born with a grant it never
        // received (empty array), and cannot claim an unknown grant source.
        assertEquals("'workspace'::character varying", defaults.get(5));
        assertEquals("'pending'::character varying", defaults.get(6));
        assertEquals("'[]'::jsonb", defaults.get(7));
        assertEquals("'plugin_binding'::character varying", defaults.get(8));
        assertEquals("now()", defaults.get(9));
        assertEquals("now()", defaults.get(10));
    }

    @Test
    void attachmentsCarryExactlyTheFrozenColumns() throws SQLException {
        List<String> names = new ArrayList<>();
        List<String> types = new ArrayList<>();
        List<String> nullables = new ArrayList<>();
        List<Integer> lengths = new ArrayList<>();
        List<String> defaults = new ArrayList<>();
        readColumns(ATTACHMENTS, names, types, nullables, lengths, defaults);

        assertEquals(List.of("session_id", "binding_id", "snapshot", "revision", "attached_at",
                "detached_at"), names);
        assertEquals(List.of("uuid", "uuid", "jsonb", "integer",
                "timestamp with time zone", "timestamp with time zone"), types);
        assertEquals(List.of(0, 0, 0, 0, 0, 0), lengths);
        assertEquals(List.of("NO", "NO", "NO", "NO", "NO", "YES"), nullables);
        assertEquals("1", defaults.get(3));
        assertEquals("now()", defaults.get(4));
        assertTrue(defaults.get(0).isEmpty() && defaults.get(1).isEmpty()
                && defaults.get(2).isEmpty(), "identity/snapshot columns have no default");
    }

    // ------------------------------------------------------------------ keys and constraints

    @Test
    void keysAndForeignKeysAreNamedAsFrozen() throws SQLException {
        assertEquals(List.of("id"), strings(
                "SELECT kcu.column_name FROM information_schema.table_constraints tc"
                        + " JOIN information_schema.key_column_usage kcu"
                        + " ON kcu.constraint_name = tc.constraint_name"
                        + " AND kcu.constraint_schema = tc.constraint_schema"
                        + " WHERE tc.table_schema = 'public' AND tc.table_name = '" + BINDINGS + "'"
                        + " AND tc.constraint_type = 'PRIMARY KEY'"
                        + " ORDER BY kcu.ordinal_position"));
        assertEquals("pk_plugin_bindings", scalarString(
                "SELECT constraint_name FROM information_schema.table_constraints"
                        + " WHERE table_schema = 'public' AND table_name = '" + BINDINGS + "'"
                        + " AND constraint_type = 'PRIMARY KEY'"));

        assertEquals(List.of("session_id", "binding_id"), strings(
                "SELECT kcu.column_name FROM information_schema.table_constraints tc"
                        + " JOIN information_schema.key_column_usage kcu"
                        + " ON kcu.constraint_name = tc.constraint_name"
                        + " AND kcu.constraint_schema = tc.constraint_schema"
                        + " WHERE tc.table_schema = 'public' AND tc.table_name = '" + ATTACHMENTS
                        + "' AND tc.constraint_type = 'PRIMARY KEY'"
                        + " ORDER BY kcu.ordinal_position"));
        assertEquals(List.of("fk_plugin_bindings_plugin", "fk_plugin_bindings_workspace"),
                strings("SELECT conname FROM pg_constraint"
                        + " WHERE conrelid = '" + BINDINGS + "'::regclass AND contype = 'f'"
                        + " ORDER BY conname"));
        assertEquals(List.of("fk_session_plugin_bindings_binding",
                        "fk_session_plugin_bindings_session"),
                strings("SELECT conname FROM pg_constraint"
                        + " WHERE conrelid = '" + ATTACHMENTS + "'::regclass AND contype = 'f'"
                        + " ORDER BY conname"));
    }

    @Test
    void pluginForeignKeyIsCompositeAndRestrictsDeletes() throws SQLException {
        // D-65 ②: the target must be the composite (id, digest) key, and the delete rule must be
        // RESTRICT (confdeltype 'r'), never CASCADE or SET NULL.
        assertEquals(List.of("plugin_id", "digest"), strings(
                "SELECT a.attname FROM pg_constraint c"
                        + " JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true"
                        + " JOIN pg_attribute a ON a.attrelid = c.conrelid"
                        + " AND a.attnum = k.attnum"
                        + " WHERE c.conname = 'fk_plugin_bindings_plugin'"
                        + " ORDER BY k.ord"));
        assertEquals(List.of("id", "digest"), strings(
                "SELECT a.attname FROM pg_constraint c"
                        + " JOIN unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord) ON true"
                        + " JOIN pg_attribute a ON a.attrelid = c.confrelid"
                        + " AND a.attnum = k.attnum"
                        + " WHERE c.conname = 'fk_plugin_bindings_plugin'"
                        + " ORDER BY k.ord"));
        assertEquals("r", scalarString(
                "SELECT confdeltype::text FROM pg_constraint"
                        + " WHERE conname = 'fk_plugin_bindings_plugin'"));
        assertEquals("c", scalarString(
                "SELECT confdeltype::text FROM pg_constraint"
                        + " WHERE conname = 'fk_plugin_bindings_workspace'"));
        assertEquals("c", scalarString(
                "SELECT confdeltype::text FROM pg_constraint"
                        + " WHERE conname = 'fk_session_plugin_bindings_binding'"));
        assertEquals("c", scalarString(
                "SELECT confdeltype::text FROM pg_constraint"
                        + " WHERE conname = 'fk_session_plugin_bindings_session'"));
    }

    @Test
    void checksAreTheFrozenVocabulary() throws SQLException {
        assertEquals(List.of("ck_plugin_bindings_grant_source",
                        "ck_plugin_bindings_granted_atoms_array", "ck_plugin_bindings_scope_type",
                        "ck_plugin_bindings_state"),
                strings("SELECT conname FROM pg_constraint"
                        + " WHERE conrelid = '" + BINDINGS + "'::regclass AND contype = 'c'"
                        + " ORDER BY conname"));
        assertEquals(List.of("ck_session_plugin_bindings_detach_order",
                        "ck_session_plugin_bindings_revision",
                        "ck_session_plugin_bindings_snapshot_object"),
                strings("SELECT conname FROM pg_constraint"
                        + " WHERE conrelid = '" + ATTACHMENTS + "'::regclass AND contype = 'c'"
                        + " ORDER BY conname"));
    }

    // ------------------------------------------------------------------ behaviour: D-65 ②

    @Test
    void uninstallIsRefusedWhileAVersionIsStillBound() throws SQLException {
        UUID workspace = seedWorkspace();
        String pluginId = "official.bound-" + UUID.randomUUID();
        insertPlugin(pluginId, "sha256:bound", "builtin");
        UUID binding = insertBinding(workspace, pluginId, "sha256:bound", "enabled");

        // The service-level guard returns 409 before this point; the DB is the invariant behind it.
        assertSqlState("23503", () -> execute("DELETE FROM plugins WHERE id = ?", pluginId));

        execute("DELETE FROM plugin_bindings WHERE id = ?", binding);
        execute("DELETE FROM plugins WHERE id = ?", pluginId);
        assertEquals(0, scalarInt("SELECT count(*) FROM plugins WHERE id = '"
                + pluginId + "'"), "uninstall succeeds once the binding is gone");
    }

    @Test
    void bindingToAnUninstalledVersionIsRefused() throws SQLException {
        UUID workspace = seedWorkspace();
        assertSqlState("23503", () -> insertBinding(workspace, "official.missing-" + UUID.randomUUID(),
                "sha256:none", "pending"));
    }

    // ------------------------------------------------------------------ behaviour: DP-6 cascades

    @Test
    void deletingABindingRemovesItsAttachments() throws SQLException {
        UUID workspace = seedWorkspace();
        UUID session = seedSession(workspace);
        String pluginId = "official.attach-" + UUID.randomUUID();
        insertPlugin(pluginId, "sha256:attach", "builtin");
        UUID binding = insertBinding(workspace, pluginId, "sha256:attach", "enabled");
        attach(session, binding);

        assertEquals(1, scalarInt("SELECT count(*) FROM " + ATTACHMENTS
                + " WHERE binding_id = '" + binding + "'"));
        execute("DELETE FROM plugin_bindings WHERE id = ?", binding);
        assertEquals(0, scalarInt("SELECT count(*) FROM " + ATTACHMENTS
                + " WHERE binding_id = '" + binding + "'"), "the attachment cannot outlive the binding");

        execute("DELETE FROM plugins WHERE id = ?", pluginId);
    }

    @Test
    void deletingASessionRemovesItsAttachmentsButKeepsTheBinding() throws SQLException {
        UUID workspace = seedWorkspace();
        UUID session = seedSession(workspace);
        String pluginId = "official.session-" + UUID.randomUUID();
        insertPlugin(pluginId, "sha256:session", "builtin");
        UUID binding = insertBinding(workspace, pluginId, "sha256:session", "enabled");
        attach(session, binding);

        execute("DELETE FROM sessions WHERE id = ?", session);
        assertEquals(0, scalarInt("SELECT count(*) FROM " + ATTACHMENTS
                + " WHERE session_id = '" + session + "'"));
        assertEquals(1, scalarInt("SELECT count(*) FROM " + BINDINGS
                + " WHERE id = '" + binding + "'"), "the workspace binding is not session-owned");

        execute("DELETE FROM plugin_bindings WHERE id = ?", binding);
        execute("DELETE FROM plugins WHERE id = ?", pluginId);
    }

    @Test
    void attachmentsDoNotCarryASecondOwnershipAxis() throws SQLException {
        assertTrue(strings("SELECT column_name FROM information_schema.columns"
                        + " WHERE table_schema = 'public' AND table_name = '" + ATTACHMENTS + "'")
                .stream().noneMatch(name -> List.of("workspace_id", "user_id").contains(name)),
                "DP-6: ownership lives on the binding, never on the snapshot");
    }

    // ------------------------------------------------------------------ behaviour: value domains

    @Test
    void bindingStateAcceptsOnlyTheFiveLowercaseStates() throws SQLException {
        UUID workspace = seedWorkspace();
        String pluginId = "official.states-" + UUID.randomUUID();
        insertPlugin(pluginId, "sha256:states", "builtin");

        UUID binding = insertBindingRaw(workspace, pluginId, "sha256:states", null);
        assertEquals("pending", scalarString("SELECT state FROM " + BINDINGS
                + " WHERE id = '" + binding + "'"), "state defaults to the closed value");

        for (String state : List.of("enabled", "degraded", "suspended", "disabled")) {
            execute("UPDATE plugin_bindings SET state = ? WHERE id = ?", state, binding);
            assertEquals(state, scalarString("SELECT state FROM " + BINDINGS
                    + " WHERE id = '" + binding + "'"));
        }
        for (String rejected : List.of("active", "ENABLED", "removed")) {
            assertSqlState("23514", () -> execute(
                    "UPDATE plugin_bindings SET state = ? WHERE id = ?", rejected, binding));
        }
    }

    @Test
    void grantedAtomsMustBeAJsonArrayAndSourceIsKnown() throws SQLException {
        UUID workspace = seedWorkspace();
        String pluginId = "official.atoms-" + UUID.randomUUID();
        insertPlugin(pluginId, "sha256:atoms", "builtin");
        UUID binding = insertBinding(workspace, pluginId, "sha256:atoms", "enabled");

        assertSqlState("23514", () -> execute(
                "UPDATE plugin_bindings SET granted_atoms = '{\"atom\":\"plugin:invoke\"}'::jsonb"
                        + " WHERE id = ?", binding));
        assertSqlState("23514", () -> execute(
                "UPDATE plugin_bindings SET granted_atoms = '\"plugin:invoke\"'::jsonb"
                        + " WHERE id = ?", binding));
        execute("UPDATE plugin_bindings SET granted_atoms = '[\"plugin:invoke\"]'::jsonb"
                + " WHERE id = ?", binding);
        assertEquals("[\"plugin:invoke\"]", scalarString(
                "SELECT granted_atoms::text FROM " + BINDINGS + " WHERE id = '" + binding + "'"));

        assertSqlState("23514", () -> execute(
                "UPDATE plugin_bindings SET grant_source = 'admin' WHERE id = ?", binding));
        execute("UPDATE plugin_bindings SET grant_source = 'default' WHERE id = ?", binding);
        assertEquals("default", scalarString(
                "SELECT grant_source FROM " + BINDINGS + " WHERE id = '" + binding + "'"));
    }

    @Test
    void oneBindingPerWorkspaceAndPlugin() throws SQLException {
        UUID workspace = seedWorkspace();
        String pluginId = "official.unique-" + UUID.randomUUID();
        insertPlugin(pluginId, "sha256:unique", "builtin");
        insertBinding(workspace, pluginId, "sha256:unique", "pending");

        assertSqlState("23505", () -> insertBinding(workspace, pluginId, "sha256:unique", "pending"));

        // Another workspace may bind the same plugin: the constraint is per workspace.
        UUID other = seedWorkspace();
        insertBinding(other, pluginId, "sha256:unique", "pending");
        assertEquals(2, scalarInt("SELECT count(*) FROM " + BINDINGS
                + " WHERE plugin_id = '" + pluginId + "'"));
    }

    @Test
    void attachmentsAreUniquePerSessionAndBindingAndBumpRevision() throws SQLException {
        UUID workspace = seedWorkspace();
        UUID session = seedSession(workspace);
        String pluginId = "official.revision-" + UUID.randomUUID();
        insertPlugin(pluginId, "sha256:revision", "builtin");
        UUID binding = insertBinding(workspace, pluginId, "sha256:revision", "enabled");
        attach(session, binding);

        assertSqlState("23505", () -> attach(session, binding));

        execute("UPDATE session_plugin_bindings SET revision = 2, detached_at = NULL"
                + " WHERE session_id = ? AND binding_id = ?", session, binding);
        assertEquals(2, scalarInt("SELECT revision FROM " + ATTACHMENTS
                + " WHERE session_id = '" + session + "'"));
        assertSqlState("23514", () -> execute(
                "UPDATE session_plugin_bindings SET revision = 0 WHERE session_id = ?"
                        + " AND binding_id = ?", session, binding));
        assertSqlState("23514", () -> execute(
                "UPDATE session_plugin_bindings SET snapshot = '[]'::jsonb WHERE session_id = ?"
                        + " AND binding_id = ?", session, binding));
    }

    // ------------------------------------------------------------------ helpers

    private static void readColumns(String table, List<String> names, List<String> types,
            List<String> nullables, List<Integer> lengths, List<String> defaults)
            throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(
                     "SELECT column_name, data_type, is_nullable, character_maximum_length,"
                             + " coalesce(column_default, '') FROM information_schema.columns"
                             + " WHERE table_schema = 'public' AND table_name = '" + table + "'"
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

    private static UUID seedWorkspace() throws SQLException {
        UUID userId = UUID.randomUUID();
        // users.username is varchar(32); the un-hyphenated UUID fits it exactly.
        execute("INSERT INTO users (id, email, password_hash, username) VALUES (?, ?, ?, ?)",
                userId, "binding-" + userId + "@example.test", "hash",
                userId.toString().replace("-", ""));
        UUID workspaceId = UUID.randomUUID();
        // V89 dropped workspaces.owner_id (the owner fact moved into a WS_OWNER role binding), so the
        // workspace row carries no user reference; sessions still need a real users row for their FK.
        execute("INSERT INTO workspaces (id, name) VALUES (?, ?)",
                workspaceId, "binding-ws-" + workspaceId);
        return workspaceId;
    }

    private static UUID seedSession(UUID workspaceId) throws SQLException {
        UUID userId = scalarUuid("SELECT id FROM users ORDER BY created_at DESC LIMIT 1");
        UUID sessionId = UUID.randomUUID();
        execute("INSERT INTO sessions (id, workspace_id, user_id) VALUES (?, ?, ?)",
                sessionId, workspaceId, userId);
        return sessionId;
    }

    private static void insertPlugin(String pluginId, String digest, String source)
            throws SQLException {
        execute("INSERT INTO plugins (id, digest, version, source, manifest)"
                + " VALUES (?, ?, '1.0.0', ?, '{\"manifestVersion\":\"1\"}'::jsonb)",
                pluginId, digest, source);
    }

    private static UUID insertBinding(UUID workspaceId, String pluginId, String digest,
            String state) throws SQLException {
        UUID binding = insertBindingRaw(workspaceId, pluginId, digest, state);
        return binding;
    }

    private static UUID insertBindingRaw(UUID workspaceId, String pluginId, String digest,
            String state) throws SQLException {
        UUID binding = UUID.randomUUID();
        if (state == null) {
            execute("INSERT INTO plugin_bindings (id, plugin_id, digest, version, workspace_id)"
                            + " VALUES (?, ?, ?, '1.0.0', ?)",
                    binding, pluginId, digest, workspaceId);
        } else {
            execute("INSERT INTO plugin_bindings (id, plugin_id, digest, version, workspace_id,"
                            + " state) VALUES (?, ?, ?, '1.0.0', ?, ?)",
                    binding, pluginId, digest, workspaceId, state);
        }
        return binding;
    }

    private static void attach(UUID sessionId, UUID bindingId) throws SQLException {
        execute("INSERT INTO session_plugin_bindings (session_id, binding_id, snapshot)"
                        + " VALUES (?, ?, '{\"bindingId\":\"x\"}'::jsonb)",
                sessionId, bindingId);
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

    private static UUID scalarUuid(String sql) throws SQLException {
        return UUID.fromString(scalarString(sql));
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
