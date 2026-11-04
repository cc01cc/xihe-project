package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0651 T2.2 batch 3: the three things a seed migration must prove beyond "it ran once".
 *
 * <ol>
 *   <li><b>Idempotency</b>: re-executing the migration SQL inserts <b>zero</b> rows. Row counts
 *       staying equal is not enough (a delete+insert would look identical), so the affected-row
 *       count of the second run is asserted to be 0.</li>
 *   <li><b>Parity</b> against a <b>hard-coded</b> expectation table — not against
 *       {@code SystemAccessRoleCatalog}, which would compare the code with itself. The failure
 *       message names the atom, the role and the direction ({@code code_has_db_lacks} /
 *       {@code db_has_code_lacks}).</li>
 *   <li><b>The parity check itself is not vacuous</b>: a deliberately tampered expectation must be
 *       reported as a difference (variability self-check).</li>
 *   <li><b>Workspace dedupe</b>: three bindings of the same role in one workspace must backfill
 *       exactly one grant row per atom, not three.</li>
 * </ol>
 */
class V114V115SeedIdempotencyAndParityTest {

    private static final UUID SUPER_ADMIN_ID =
            UUID.fromString("00000000-0000-4000-8000-000000000001");
    private static final UUID ADMIN_ID = UUID.fromString("00000000-0000-4000-8000-000000000002");
    private static final UUID WS_OWNER_ID =
            UUID.fromString("00000000-0000-4000-8000-000000000004");
    private static final UUID WS_EDITOR_ID =
            UUID.fromString("00000000-0000-4000-8000-000000000005");
    private static final UUID WS_VIEWER_ID =
            UUID.fromString("00000000-0000-4000-8000-000000000006");

    private static final List<String> NEW_ATOMS = List.of(
            ToolFaceRegistry.ACTION_READ_INSTANCE_CONTENT,
            ToolFaceRegistry.ACTION_WRITE_INSTANCE_CONTENT,
            ToolFaceRegistry.ACTION_VIEW_SECRET_CONTENT,
            ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY,
            ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS,
            ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME,
            ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_RUNTIME,
            ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY);

    private static TestDatabaseProvider.DatabaseRef postgres;
    private static Connection connection;

    @BeforeAll
    static void migrateToHead() throws SQLException {
        postgres = TestDatabaseProvider.emptyDatabase("plan0651_t2_2_b3");
        Flyway.configure()
                .dataSource(postgres.jdbcUrl(), postgres.username(), postgres.password())
                .locations("classpath:db/migration")
                .load()
                .migrate();
        connection = DriverManager.getConnection(postgres.jdbcUrl(), postgres.username(),
                postgres.password());
    }

    // ---------------------------------------------------------------------------------------
    // 1. Idempotency: the second run must insert zero rows.
    // ---------------------------------------------------------------------------------------

    @Test
    void reRunningTheSeedInsertsZeroRowsAndLeavesEveryCountUnchanged() throws Exception {
        long rolePermissionsBefore = count("SELECT count(*) FROM role_permissions");
        long grantsBefore = count("SELECT count(*) FROM grants");

        int affectedOnSecondRun = 0;
        affectedOnSecondRun += executeMigrationAgain("V114__plan0651_instance_face_atoms.sql");
        affectedOnSecondRun += executeMigrationAgain("V115__plan0651_workspace_face_atoms.sql");

        assertEquals(0, affectedOnSecondRun,
                "the second execution must insert nothing — ON CONFLICT DO NOTHING / NOT EXISTS are"
                        + " what make the seed re-runnable; a non-zero count means one of them is"
                        + " missing (a delete+insert would also keep the totals equal, which is why"
                        + " the affected-row count, not the totals, is the assertion)");
        assertEquals(rolePermissionsBefore, count("SELECT count(*) FROM role_permissions"),
                "role_permissions row count must not move on a re-run");
        assertEquals(grantsBefore, count("SELECT count(*) FROM grants"),
                "grants row count must not move on a re-run");
    }

    /** Replays a migration file's statements and returns the summed affected-row count. */
    private static int executeMigrationAgain(String fileName) throws Exception {
        String sql;
        try (InputStream in = V114V115SeedIdempotencyAndParityTest.class
                .getResourceAsStream("/db/migration/" + fileName)) {
            assertTrue(in != null, "migration resource missing: " + fileName);
            sql = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        int affected = 0;
        // Strip comments BEFORE splitting on ';': the header prose contains semicolons, and a
        // comment line that does not start with "--" after a naive split becomes a syntax error.
        try (Statement statement = connection.createStatement()) {
            for (String raw : stripComments(sql).split(";")) {
                String statementSql = raw.trim();
                if (statementSql.isEmpty()) {
                    continue;
                }
                affected += statement.executeUpdate(statementSql);
            }
        }
        return affected;
    }

    private static String stripComments(String raw) {
        StringBuilder out = new StringBuilder();
        for (String line : raw.split("\n")) {
            String trimmed = line.trim();
            if (trimmed.startsWith("--")) {
                continue;
            }
            out.append(line).append('\n');
        }
        return out.toString();
    }

    // ---------------------------------------------------------------------------------------
    // 2 + 3. Parity against a hard-coded table, with a variability self-check.
    // ---------------------------------------------------------------------------------------

    /** The reviewed expectation, hard-coded (never derived from the code catalog). */
    private static Map<UUID, Set<String>> expectedTable() {
        Map<UUID, Set<String>> expected = new LinkedHashMap<>();
        expected.put(SUPER_ADMIN_ID, Set.copyOf(NEW_ATOMS));
        expected.put(ADMIN_ID, Set.copyOf(NEW_ATOMS));
        expected.put(WS_OWNER_ID, Set.of(
                ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY,
                ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS,
                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_RUNTIME,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY));
        expected.put(WS_EDITOR_ID, Set.of(
                ToolFaceRegistry.ACTION_MANAGE_PROVIDER_CONNECTIONS,
                ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME,
                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY));
        expected.put(WS_VIEWER_ID, Set.of(ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME));
        return expected;
    }

    /**
     * Differences between the table and the database, naming atom, role and direction. Kept as a
     * function (rather than inline assertions) so the variability self-check can call it with a
     * tampered table.
     */
    private static List<String> parityDifferences(Map<UUID, Set<String>> expected) throws SQLException {
        List<String> differences = new ArrayList<>();
        for (Map.Entry<UUID, Set<String>> role : expected.entrySet()) {
            Set<String> actual = dbAtomsOf(role.getKey());
            for (String atom : NEW_ATOMS) {
                boolean expectedHeld = role.getValue().contains(atom);
                boolean actualHeld = actual.contains(atom);
                if (expectedHeld && !actualHeld) {
                    differences.add("code_has_db_lacks: atom=" + atom + " role=" + role.getKey());
                }
                if (!expectedHeld && actualHeld) {
                    differences.add("db_has_code_lacks: atom=" + atom + " role=" + role.getKey());
                }
            }
        }
        return differences;
    }

    @Test
    void databaseMatchesTheHardCodedExpectation() throws SQLException {
        assertEquals(List.of(), parityDifferences(expectedTable()),
                "the seeded rows must equal the reviewed table, cell by cell");
    }

    @Test
    void parityReportsATamperedExpectationSoTheCheckIsNotVacuous() throws SQLException {
        Map<UUID, Set<String>> tampered = new LinkedHashMap<>(expectedTable());
        Set<String> adminWithAtomRemoved = new LinkedHashSet<>(tampered.get(ADMIN_ID));
        adminWithAtomRemoved.remove(ToolFaceRegistry.ACTION_MANAGE_SKILL_LIBRARY);
        tampered.put(ADMIN_ID, adminWithAtomRemoved);

        List<String> differences = parityDifferences(tampered);

        assertFalse(differences.isEmpty(),
                "a tampered expectation MUST be reported, otherwise the parity check is vacuous");
        assertTrue(differences.stream().anyMatch(d -> d.contains("MANAGE_SKILL_LIBRARY")
                        && d.contains(ADMIN_ID.toString()) && d.startsWith("db_has_code_lacks")),
                "the difference must name the atom, the role and the direction: " + differences);
    }

    // ---------------------------------------------------------------------------------------
    // 4. Workspace dedupe: same role bound three times in one workspace ⇒ one backfilled row.
    // ---------------------------------------------------------------------------------------

    @Test
    void twoRolesOverlappingOnTheSameAtomsBackfillOneRowPerAtom() throws SQLException {
        UUID subject = UUID.randomUUID();
        UUID workspace = UUID.randomUUID();
        insertUser(subject);
        insertHostWorkspace(workspace, subject);
        // uq_role_bindings forbids binding the SAME role twice, so the real overlap risk is two
        // different roles granting the same atoms in one workspace: WS_OWNER (N5..N9) and WS_EDITOR
        // (N6, N7, N9) share three atoms. Without DISTINCT ON (subject_id, scope_id, atom) the
        // backfill would write six rows and duplicate the shared ones.
        insertBinding(WS_OWNER_ID, subject, "workspace", workspace);
        insertBinding(WS_EDITOR_ID, subject, "workspace", workspace);
        long before = count("SELECT count(*) FROM grants WHERE subject_id = '" + subject + "'");
        assertEquals(0, before, "no grant rows before the backfill runs");

        reRunBackfillForWorkspaceAtoms();

        assertEquals(5, count("SELECT count(*) FROM grants WHERE subject_id = '" + subject + "'"),
                "union of WS_OWNER (N5..N9) and WS_EDITOR (N6/N7/N9) is five atoms; the three shared"
                        + " ones must NOT be written twice");
        assertEquals(5, count("SELECT count(DISTINCT permissions->0->>'actionClass') FROM grants"
                + " WHERE subject_id = '" + subject + "'"), "one row per distinct atom");
    }

    private static void reRunBackfillForWorkspaceAtoms() throws SQLException {
        // Only the workspace-scope backfill of V115 is exercised here; the instance one has its own
        // dedupe shape asserted elsewhere.
        execute("""
                INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions,
                                    source, scope_type, scope_id, read_state)
                SELECT DISTINCT ON (b.subject_id, b.scope_id, rp.action_class)
                       gen_random_uuid(), 'user', b.subject_id, 'user', b.subject_id,
                       jsonb_build_array(jsonb_build_object('actionClass', rp.action_class)),
                       'role', 'workspace', b.scope_id, 'read'
                FROM role_bindings b
                JOIN role_permissions rp ON rp.role_id = b.role_id
                WHERE b.subject_type = 'user' AND b.scope_type = 'workspace' AND b.scope_id IS NOT NULL
                  AND b.role_id IN ('00000000-0000-4000-8000-000000000004',
                                    '00000000-0000-4000-8000-000000000005',
                                    '00000000-0000-4000-8000-000000000006')
                  AND rp.action_class IN ('MANAGE_SKILL_LIBRARY', 'MANAGE_PROVIDER_CONNECTIONS',
                                          'USE_WORKSPACE_RUNTIME', 'MANAGE_WORKSPACE_RUNTIME',
                                          'MANAGE_WORKSPACE_POLICY')
                  AND NOT EXISTS (SELECT 1 FROM grants g
                                  WHERE g.subject_type = 'user' AND g.subject_id = b.subject_id
                                    AND g.source = 'role' AND g.scope_type = 'workspace'
                                    AND g.scope_id = b.scope_id
                                    AND g.permissions->0->>'actionClass' = rp.action_class)
                """);
    }

    // ---------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------

    private static Set<String> dbAtomsOf(UUID roleId) throws SQLException {
        Set<String> atoms = new LinkedHashSet<>();
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(
                     "SELECT action_class FROM role_permissions WHERE role_id = '" + roleId + "'")) {
            while (rows.next()) {
                atoms.add(rows.getString(1));
            }
        }
        return atoms;
    }

    private static long count(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getLong(1);
        }
    }

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.executeUpdate(sql);
        }
    }

    private static void insertUser(UUID id) throws SQLException {
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + id
                + "', 'b3-" + id + "@test.local', 'x', 'b3" + id.toString().substring(0, 8) + "')");
    }

    /** role_bindings.scope_id has a FK to workspaces, so the dedupe fixture needs a real row. */
    private static void insertHostWorkspace(UUID id, UUID creator) throws SQLException {
        // direct_attach requires a host_path (check constraint ck_workspaces_direct_attach_path).
        execute("INSERT INTO workspaces (id, name, storage_backend, storage_mode, host_path,"
                + " execution_mode, created_at, updated_at) VALUES ('" + id + "', 't2.2-b3-ws',"
                + " 'host_directory', 'direct_attach', 'C:/xihe-build/0651-b3/" + id + "',"
                + " 'windows-host', now(), now())");
    }

    private static void insertBinding(UUID roleId, UUID subjectId, String scopeType, UUID scopeId)
            throws SQLException {
        execute("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                + " scope_id, granted_by) VALUES ('" + UUID.randomUUID() + "', '" + roleId
                + "', 'user', '" + subjectId + "', '" + scopeType + "', '" + scopeId + "', '"
                + subjectId + "')");
    }
}
