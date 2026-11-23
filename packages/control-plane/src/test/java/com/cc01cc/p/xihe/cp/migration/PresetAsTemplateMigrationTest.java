package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.policy.GrantSources;
import com.cc01cc.p.xihe.cp.support.TestContainerLabels;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-933 / R39 (D-1926): V186 on a REAL PostgreSQL, both faces the card asked for.
 *
 * <p>The card's split-half trap is a silent full DENY: if the constants drop {@code preset} while
 * persisted rows still say it, every materialized subject loses its atoms without an error. So the
 * evidence has to be the migration itself, on the real constraint, not H2 — every Spring test here
 * runs {@code ddl-auto=create-drop}, which never builds {@code ck_grants_source} at all.</p>
 *
 * <p>Constructed <b>existing-database</b> upgrade (the "存量库" face): migrate to V185, seed the
 * V182-era shape (three {@code grant_presets} rows, their atoms, their bindings, and
 * {@code grants} rows carrying {@code source='preset'}), then run V186 → head and assert:</p>
 * <ol>
 *   <li>no {@code preset} row survives and every converted row is {@code assigned};</li>
 *   <li>{@code origin_preset_id} backfills only on a <b>unique</b> preset match — an atom held by
 *       two presets and an atom held by none both land NULL (a wrong attribution would make
 *       「与预设对比」 lie, which is worse than no attribution);</li>
 *   <li>the rebuilt CHECK rejects {@code 'preset'} with 23514 and accepts every
 *       {@link GrantSources#WRITABLE_SOURCES} value;</li>
 *   <li>the rebuilt unique key includes {@code origin_preset_id}, so the same atom imported from two
 *       presets is two rows (per-group reconcile) while an exact duplicate still fails 23505;</li>
 *   <li>untouched sources ({@code spawn}) keep their rows and NULL origin;</li>
 *   <li>R186 restores the pre-V186 world exactly (value back to {@code preset}, column dropped,
 *       key back on {@code 'preset'}), so the migration is reversible.</li>
 * </ol>
 */
@Testcontainers
@TestMethodOrder(MethodOrderer.MethodName.class)
class PresetAsTemplateMigrationTest {

    private static final String DOWN_SCRIPT =
            "db/rollback/R186__task933_preset_as_template.down.sql";

    /** V185 is the last migration before this card's file. */
    private static final String VERSION_BEFORE = "185";

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_v186")
            .withUsername("test")
            .withPassword("test")
            .withLabels(TestContainerLabels.runId());

    private static Connection connection;

    private static final String PRESET_ONE = "00000000-0000-4000-8000-0000000000a1";
    private static final String PRESET_TWO = "00000000-0000-4000-8000-0000000000a2";
    private static final String SUBJECT_UNIQUE = "00000000-0000-4000-8000-0000000000b1";
    private static final String SUBJECT_AMBIGUOUS = "00000000-0000-4000-8000-0000000000b2";
    private static final String SUBJECT_UNATTRIBUTED = "00000000-0000-4000-8000-0000000000b3";
    private static final String SUBJECT_SPAWN = "00000000-0000-4000-8000-0000000000b4";

    @BeforeAll
    static void buildAnExistingDatabaseAndSeedTheV182EraShape() throws SQLException {
        String url = postgres.getJdbcUrl();
        Flyway.configure()
                .dataSource(url, postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion(VERSION_BEFORE))
                .load()
                .migrate();
        connection = DriverManager.getConnection(url, postgres.getUsername(), postgres.getPassword());

        insertPreset(PRESET_ONE, "MIGRATION_PROBE_ONE");
        insertPreset(PRESET_TWO, "MIGRATION_PROBE_TWO");
        // P1: read + write. P2: read only. So `read` is ambiguous and `write` is unique.
        insertAtom(PRESET_ONE, "action:read");
        insertAtom(PRESET_ONE, "action:write");
        insertAtom(PRESET_TWO, "action:read");

        insertBinding(PRESET_ONE, SUBJECT_UNIQUE);
        insertBinding(PRESET_ONE, SUBJECT_AMBIGUOUS);
        insertBinding(PRESET_TWO, SUBJECT_AMBIGUOUS);
        insertBinding(PRESET_TWO, SUBJECT_UNATTRIBUTED);

        // The pre-V186 rows: what a materializer wrote in the V182 era.
        insertGrant(SUBJECT_UNIQUE, "action:read", "preset");
        insertGrant(SUBJECT_UNIQUE, "action:write", "preset");
        insertGrant(SUBJECT_AMBIGUOUS, "action:read", "preset");
        insertGrant(SUBJECT_AMBIGUOUS, "action:write", "preset");
        // Bound to P2 (read, write-without-P2): `action:network` matches no preset atom at all.
        insertGrant(SUBJECT_UNATTRIBUTED, "action:network", "preset");
        // A non-materialized source must not be touched by the conversion.
        insertGrant(SUBJECT_SPAWN, "action:read", "spawn");
    }

    @Test
    void convertsPresetRowsBackfillsOnlyUniqueMatchesAndRebuildsTheFences() throws SQLException {
        assertEquals(5, count("SELECT count(*) FROM grants WHERE source = 'preset'"),
                "fixture: five materialized rows in the V182-era shape");
        assertEquals(0, columnCount("grants", "origin_preset_id"),
                "the column really is V186's, not a leftover of the fixture");

        Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .load()
                .migrate();

        // 1) nothing says 'preset' any more, and the retired value is unwritable.
        assertEquals(0, count("SELECT count(*) FROM grants WHERE source = 'preset'"),
                "V186 must leave no preset row: with PRESET out of EVALUATION_SOURCES such a row "
                        + "would be silently inert (the full-DENY trap)");
        assertEquals(5, count("SELECT count(*) FROM grants WHERE source = 'assigned'"));
        assertEquals(1, count("SELECT count(*) FROM grants WHERE source = 'spawn'"),
                "the conversion is scoped to the retired value only");

        // 2) backfill: unique preset match -> that preset; ambiguous / no match -> NULL.
        assertEquals(PRESET_ONE, originOf(SUBJECT_UNIQUE, "action:read"),
                "only P1 carries read for this subject: 1 match, backfilled");
        assertEquals(PRESET_ONE, originOf(SUBJECT_UNIQUE, "action:write"),
                "only P1 carries write for this subject: 1 match, backfilled");
        assertNull(originOf(SUBJECT_AMBIGUOUS, "action:read"),
                "two presets carry read for this subject: the backfill must not guess");
        assertEquals(PRESET_ONE, originOf(SUBJECT_AMBIGUOUS, "action:write"),
                "write is unique even though read is not: attribution is per (subject, scope, atom)");
        assertNull(originOf(SUBJECT_UNATTRIBUTED, "action:network"),
                "no preset carries network: 0 matches, NULL (local work, never deleted by a group)");
        assertNull(originOf(SUBJECT_SPAWN, "action:read"),
                "a spawn row is not an import and keeps no template origin");

        // 3) the CHECK of record is now exactly the writable set, and it rejects the retired value.
        SQLException rejected = assertThrows(SQLException.class,
                () -> execute("INSERT INTO grants (id, subject_type, subject_id, permissions, source,"
                        + " scope_type, read_state) VALUES (gen_random_uuid(), 'user', gen_random_uuid(),"
                        + " '[]'::jsonb, 'preset', 'instance', 'read')"));
        assertEquals("23514", rejected.getSQLState(), "the CHECK must still be a fence, not a formality");
        assertTrue(rejected.getMessage().contains("ck_grants_source"), rejected.getMessage());
        for (String writable : GrantSources.WRITABLE_SOURCES) {
            execute("INSERT INTO grants (id, subject_type, subject_id, permissions, source,"
                    + " scope_type, read_state) VALUES (gen_random_uuid(), 'user', gen_random_uuid(),"
                    + " '[]'::jsonb, '" + writable + "', 'instance', 'read')");
        }
        assertEquals(GrantSources.WRITABLE_SOURCES.size(),
                count("SELECT count(*) FROM grants WHERE permissions = '[]'::jsonb"),
                "every GrantSources.WRITABLE_SOURCES value is storable (Java/DB element-wise parity)");

        // 4) origin_preset_id is IN the unique key: the same atom under two presets is two rows.
        String shared = "00000000-0000-4000-8000-0000000000c1";
        execute("INSERT INTO grants (id, subject_type, subject_id, permissions, source,"
                + " origin_preset_id, scope_type, read_state) VALUES (gen_random_uuid(), 'user',"
                + " '" + shared + "', '[{\"actionClass\":\"action:read\"}]'::jsonb, 'assigned',"
                + " '" + PRESET_ONE + "', 'instance', 'read')");
        execute("INSERT INTO grants (id, subject_type, subject_id, permissions, source,"
                + " origin_preset_id, scope_type, read_state) VALUES (gen_random_uuid(), 'user',"
                + " '" + shared + "', '[{\"actionClass\":\"action:read\"}]'::jsonb, 'assigned',"
                + " '" + PRESET_TWO + "', 'instance', 'read')");
        assertEquals(2, count("SELECT count(*) FROM grants WHERE subject_id = '" + shared + "'"),
                "two import groups holding the same atom must coexist (per-group reconcile), or a"
                        + " second import would delete the first subject's fine-tune");
        SQLException duplicate = assertThrows(SQLException.class,
                () -> execute("INSERT INTO grants (id, subject_type, subject_id, permissions, source,"
                        + " origin_preset_id, scope_type, read_state) VALUES (gen_random_uuid(), 'user',"
                        + " '" + shared + "', '[{\"actionClass\":\"action:read\"}]'::jsonb, 'assigned',"
                        + " '" + PRESET_ONE + "', 'instance', 'read')"));
        assertEquals("23505", duplicate.getSQLState(),
                "the key still fences an exact (atom, group) duplicate");

        // 5) the index predicate moved to the new value.
        String definition = scalar("SELECT indexdef FROM pg_indexes WHERE indexname ="
                + " 'uq_grants_role_atom'");
        assertTrue(definition.contains("origin_preset_id"),
                "V182 left this index dead; V186 rebuilds it on assigned + origin: " + definition);
        assertTrue(definition.contains("'assigned'"), definition);
    }

    @Test
    void rollbackRestoresThePreV186World() throws SQLException, IOException {
        // Runs SECOND (MethodName order) on the SAME container as the forward test, which also left
        // probe rows behind. Every count below is therefore scoped to this class's own four fixture
        // subjects — a global count would measure the other test's probes, not the rollback.
        Flyway.configure()
                .dataSource(postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .load()
                .migrate();
        runRollback();

        assertEquals(0, columnCount("grants", "origin_preset_id"),
                "the provenance column goes with the rollback");
        assertEquals(5, count("SELECT count(*) FROM grants WHERE source = 'preset' AND subject_id IN ("
                        + fixtureSubjects() + ")"),
                "assigned rows convert back to the historical value");
        assertEquals(0, count("SELECT count(*) FROM grants WHERE source = 'assigned' AND subject_id IN ("
                        + fixtureSubjects() + ")"));
        assertEquals(1, count("SELECT count(*) FROM grants WHERE source = 'spawn' AND subject_id = '"
                        + SUBJECT_SPAWN + "'"),
                "the untouched spawn row is still there");
        SQLException rejected = assertThrows(SQLException.class,
                () -> execute("INSERT INTO grants (id, subject_type, subject_id, permissions, source,"
                        + " scope_type, read_state) VALUES (gen_random_uuid(), 'user', gen_random_uuid(),"
                        + " '[]'::jsonb, 'assigned', 'instance', 'read')"));
        assertEquals("23514", rejected.getSQLState(),
                "the DOWN state admits 'preset' again and not 'assigned' — exactly the pre-UP fence");
        String definition = scalar("SELECT indexdef FROM pg_indexes WHERE indexname ="
                + " 'uq_grants_role_atom'");
        // V87 wrote predicate 'role' and V182 renamed the values without rebuilding the index, so
        // the pre-V186 state IS a dead key. Restoring 'preset' instead would make it live and the
        // CREATE INDEX would fail on any subject that imported one atom from two presets (a shape
        // V186 allows on purpose) — measured, which is why this line asserts the predicate.
        assertTrue(definition.contains("'role'"),
                "the key returns to the dead V87/V182 predicate, not a live 'preset' one: " + definition);
        assertFalse(definition.contains("origin_preset_id"), definition);
    }

    // ---------------------------------------------------------------- helpers

    private static String fixtureSubjects() {
        return "'" + SUBJECT_UNIQUE + "','" + SUBJECT_AMBIGUOUS + "','" + SUBJECT_UNATTRIBUTED
                + "','" + SUBJECT_SPAWN + "'";
    }

    private static void insertPreset(String id, String name) throws SQLException {
        execute("INSERT INTO grant_presets (id, name, display_name, is_system) VALUES ('" + id
                + "', '" + name + "', '" + name + "', FALSE)");
    }

    private static void insertAtom(String presetId, String actionClass) throws SQLException {
        execute("INSERT INTO grant_preset_atoms (role_id, action_class, resource_pattern) VALUES ('"
                + presetId + "', '" + actionClass + "', '*')");
    }

    private static void insertBinding(String presetId, String subjectId) throws SQLException {
        execute("INSERT INTO grant_preset_bindings (id, role_id, subject_type, subject_id,"
                + " scope_type, granted_at) VALUES (gen_random_uuid(), '" + presetId
                + "', 'user', '" + subjectId + "', 'instance', NOW())");
    }

    private static void insertGrant(String subjectId, String actionClass, String source)
            throws SQLException {
        execute("INSERT INTO grants (id, subject_type, subject_id, permissions, source, scope_type,"
                + " read_state) VALUES (gen_random_uuid(), 'user', '" + subjectId + "', '"
                + "[{\"actionClass\":\"" + actionClass + "\"}]" + "'::jsonb, '" + source
                + "', 'instance', 'read')");
    }

    private static String originOf(String subjectId, String actionClass) throws SQLException {
        return scalar("SELECT origin_preset_id::text FROM grants WHERE subject_id = '" + subjectId
                + "' AND permissions #>> '{0,actionClass}' = '" + actionClass + "'");
    }

    private static void runRollback() throws SQLException, IOException {
        String sql;
        try (InputStream stream = PresetAsTemplateMigrationTest.class
                .getClassLoader().getResourceAsStream(DOWN_SCRIPT)) {
            assertNotNull(stream, "rollback script on the classpath");
            sql = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
        StringBuilder statement = new StringBuilder();
        for (String line : sql.split("\n")) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("--")) {
                continue;
            }
            statement.append(line).append('\n');
            if (trimmed.endsWith(";")) {
                execute(statement.toString());
                statement.setLength(0);
            }
        }
    }

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private static int count(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            rs.next();
            return rs.getInt(1);
        }
    }

    private static String scalar(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            return rs.next() ? rs.getString(1) : null;
        }
    }

    private static int columnCount(String table, String column) throws SQLException {
        List<String> found = new ArrayList<>();
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery("SELECT column_name"
                     + " FROM information_schema.columns WHERE table_name = '" + table
                     + "' AND column_name = '" + column + "'")) {
            while (rs.next()) {
                found.add(rs.getString(1));
            }
        }
        return found.size();
    }
}
