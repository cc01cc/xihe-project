package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T2.2 (V142): {@code plugin_records} and {@code plugin_index_declarations} on real
 * PostgreSQL 17, migrated by the real Flyway files.
 *
 * <p>Why PostgreSQL-only: the H2 profile runs {@code spring.flyway.enabled=false} with
 * {@code ddl-auto=create-drop} over the JPA entities, and there are no JPA entities for these two
 * tables (DP-6: plugin tables hold no CP columns, so they are not projections of the CP model). An H2
 * green therefore says nothing about this schema — including the DP-6a "no foreign key" property,
 * which is the one a future entity mapping would silently break.</p>
 *
 * <p>Assertions state what they exclude:</p>
 * <ul>
 *   <li>column/pk shape — proves the DDL matches DP-2/DP-3, not that the executor uses it;</li>
 *   <li>the two CHECK constraints are exercised <b>negatively</b> (a legal row also exists, so a
 *       constraint that rejected everything would fail the positive case);</li>
 *   <li>zero foreign keys on either table — DP-6a's "records outlive their binding" decision, proven
 *       by inserting a record for a binding id that has no row anywhere;</li>
 *   <li>{@code flyway_schema_history} records V142 as successful, so this is the migration and not a
 *       table some test created by hand.</li>
 * </ul>
 */
class PluginRecordsIndexSchemaTest {

    private static Connection connection;

    @BeforeAll
    static void migrateToHeadAndConnect() throws SQLException {
        TestDatabaseProvider.DatabaseRef database =
                TestDatabaseProvider.migratedDatabase("plugin-records-schema");
        connection = DriverManager.getConnection(database.jdbcUrl(), database.username(),
                database.password());
    }

    @AfterAll
    static void close() throws SQLException {
        if (connection != null) {
            connection.close();
        }
    }

    @Test
    void theMigrationCreatedTheTwoTablesWithTheirDocumentedColumns() throws SQLException {
        assertEquals(List.of("binding_id:uuid:NO", "collection:character varying:NO",
                        "id:text:NO", "doc:jsonb:NO", "version:bigint:NO",
                        "updated_at:timestamp with time zone:NO"),
                columns("plugin_records"),
                "DP-2 columns; a nullable column here would let the executor write half a record");
        assertEquals(List.of("binding_id:uuid:NO", "collection:character varying:NO",
                        "index_name:character varying:NO", "fields:ARRAY:NO",
                        "unique_flag:boolean:NO", "state:character varying:NO",
                        "applied_at:timestamp with time zone:YES", "error:text:YES"),
                columns("plugin_index_declarations"),
                "DP-3 columns; applied_at/error are the only nullable ones by construction");
    }

    @Test
    void theRecordPrimaryKeyIsBindingCollectionAndId() throws SQLException {
        assertEquals(List.of("binding_id", "collection", "id"), primaryKey("plugin_records"),
                "DP-2: (binding_id, collection, id) — the prefix is also what the purge sweep uses");
        assertEquals(List.of("binding_id", "collection", "index_name"),
                primaryKey("plugin_index_declarations"),
                "DP-3: one ledger row per (binding, collection, declaration)");
    }

    @Test
    void aRecordNeedsOnlyItsOwnColumnsAndDefaultsItsVersionAndTimestamp() throws SQLException {
        UUID bindingId = UUID.randomUUID();
        execute("INSERT INTO plugin_records (binding_id, collection, id, doc)"
                + " VALUES (?, ?, ?, ?::jsonb)", bindingId, "contacts", "r-1", "{\"email\":\"a@b\"}");

        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT version, updated_at, doc->>'email' FROM plugin_records"
                        + " WHERE binding_id = ? AND collection = ? AND id = ?")) {
            statement.setObject(1, bindingId);
            statement.setString(2, "contacts");
            statement.setString(3, "r-1");
            try (ResultSet rs = statement.executeQuery()) {
                assertTrue(rs.next());
                assertEquals(1L, rs.getLong(1), "DP-7: CP owns the version sequence, starting at 1");
                assertNotNull(rs.getTimestamp(2), "updated_at must be filled by the database");
                assertEquals("a@b", rs.getString(3), "doc is JSONB, not text");
            }
        }
        // Same key twice must be refused by the primary key, otherwise "upsert by id" would be
        // ambiguous for the reader layer.
        SQLException duplicate = assertThrows(SQLException.class,
                () -> execute("INSERT INTO plugin_records (binding_id, collection, id, doc)"
                        + " VALUES (?, ?, ?, '{}'::jsonb)", bindingId, "contacts", "r-1"));
        assertEquals("23505", duplicate.getSQLState(),
                "duplicate (binding, collection, id) must be a unique violation: "
                        + duplicate.getMessage());
    }

    @Test
    void aLedgerRowIsAcceptedOnlyWithAKnownStateAndBetweenOneAndFourFields() throws SQLException {
        UUID bindingId = UUID.randomUUID();
        execute("INSERT INTO plugin_index_declarations"
                        + " (binding_id, collection, index_name, fields, unique_flag, state, applied_at)"
                        + " VALUES (?, ?, ?, ARRAY['email']::text[], TRUE, 'applied', NOW())",
                bindingId, "contacts", "by_email");

        // Negative: the vocabulary is a fence, not documentation. 23514 + the constraint name is the
        // only shape that distinguishes "constraint present" from "value tolerated".
        SQLException badState = assertThrows(SQLException.class,
                () -> execute("INSERT INTO plugin_index_declarations"
                                + " (binding_id, collection, index_name, fields, state)"
                                + " VALUES (?, ?, ?, ARRAY['email']::text[], 'bogus')",
                        bindingId, "notes", "by_title"));
        assertEquals("23514", badState.getSQLState(), badState.getMessage());
        assertTrue(badState.getMessage().contains("ck_plugin_index_declarations_state"),
                "the failure must name the state fence: " + badState.getMessage());

        SQLException emptyFields = assertThrows(SQLException.class,
                () -> execute("INSERT INTO plugin_index_declarations"
                                + " (binding_id, collection, index_name, fields, state)"
                                + " VALUES (?, ?, ?, ARRAY[]::text[], 'applied')",
                        bindingId, "notes", "by_title"));
        assertEquals("23514", emptyFields.getSQLState(), emptyFields.getMessage());
        assertTrue(emptyFields.getMessage().contains("ck_plugin_index_declarations_fields"),
                "a declared index always has fields (schema minItems 1): "
                        + emptyFields.getMessage());

        SQLException tooManyFields = assertThrows(SQLException.class,
                () -> execute("INSERT INTO plugin_index_declarations"
                                + " (binding_id, collection, index_name, fields, state)"
                                + " VALUES (?, ?, ?, ARRAY['a','b','c','d','e']::text[], 'applied')",
                        bindingId, "notes", "by_title"));
        assertEquals("23514", tooManyFields.getSQLState(), tooManyFields.getMessage());
    }

    /**
     * DP-6a: no foreign key to {@code plugin_bindings}. The purge job and the 7-day grace period
     * (LC-6) only work if user records can outlive the binding row, and a cascade would delete them at
     * uninstall while a restrict would make uninstall impossible.
     */
    @Test
    void bindingIdCarriesNoForeignKeySoRecordsOutliveTheirBinding() throws SQLException {
        assertEquals(0, foreignKeyCount("plugin_records"),
                "DP-6a: a foreign key here would decide uninstall semantics in the wrong place");
        assertEquals(0, foreignKeyCount("plugin_index_declarations"),
                "DP-6a: the ledger must survive uninstall too (LC-6)");

        // The behavioural half: a binding id that exists nowhere is accepted, i.e. there is no
        // dependency to violate — an orphan record is representable by design.
        UUID orphanBinding = UUID.randomUUID();
        execute("INSERT INTO plugin_records (binding_id, collection, id, doc)"
                + " VALUES (?, ?, ?, '{}'::jsonb)", orphanBinding, "contacts", "orphan-1");
        execute("INSERT INTO plugin_index_declarations"
                        + " (binding_id, collection, index_name, fields, state)"
                        + " VALUES (?, ?, ?, ARRAY['email']::text[], 'failed')",
                orphanBinding, "contacts", "by_email");
        assertTrue(countWhere("plugin_records", orphanBinding) >= 1,
                "an orphan record must be storable: that is the grace period");
    }

    @Test
    void flywayRecordedThisMigrationAsApplied() throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT success FROM flyway_schema_history WHERE version = ?")) {
            statement.setString(1, "142");
            try (ResultSet rs = statement.executeQuery()) {
                assertTrue(rs.next(), "V142 must be in flyway_schema_history");
                assertTrue(rs.getBoolean(1), "V142 must have applied successfully");
            }
        }
    }

    // ------------------------------------------------------------------ helpers

    private List<String> columns(String table) throws SQLException {
        List<String> found = new ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT column_name, data_type, is_nullable FROM information_schema.columns"
                        + " WHERE table_schema = 'public' AND table_name = ?"
                        + " ORDER BY ordinal_position")) {
            statement.setString(1, table);
            try (ResultSet rs = statement.executeQuery()) {
                while (rs.next()) {
                    found.add(rs.getString(1) + ":" + rs.getString(2) + ":" + rs.getString(3));
                }
            }
        }
        assertTrue(!found.isEmpty(), "table " + table + " must exist");
        return found;
    }

    private List<String> primaryKey(String table) throws SQLException {
        List<String> columns = new ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT a.attname FROM pg_index i"
                        + " JOIN pg_class c ON c.oid = i.indrelid"
                        + " JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE"
                        + " JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum"
                        + " WHERE c.relname = ? AND i.indisprimary ORDER BY k.ord")) {
            statement.setString(1, table);
            try (ResultSet rs = statement.executeQuery()) {
                while (rs.next()) {
                    columns.add(rs.getString(1));
                }
            }
        }
        return columns;
    }

    private int foreignKeyCount(String table) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT count(*) FROM pg_constraint WHERE contype = 'f'"
                        + " AND conrelid = ?::regclass")) {
            statement.setString(1, table);
            try (ResultSet rs = statement.executeQuery()) {
                rs.next();
                return rs.getInt(1);
            }
        }
    }

    private int countWhere(String table, UUID bindingId) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(
                "SELECT count(*) FROM " + table + " WHERE binding_id = ?")) {
            statement.setObject(1, bindingId);
            try (ResultSet rs = statement.executeQuery()) {
                rs.next();
                return rs.getInt(1);
            }
        }
    }

    private void execute(String sql, Object... arguments) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            for (int i = 0; i < arguments.length; i++) {
                Object argument = arguments[i];
                if (argument instanceof UUID uuid) {
                    statement.setObject(i + 1, uuid);
                } else if (argument instanceof Timestamp timestamp) {
                    statement.setTimestamp(i + 1, timestamp);
                } else {
                    statement.setString(i + 1, String.valueOf(argument));
                }
            }
            statement.executeUpdate();
        }
    }
}
