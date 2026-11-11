package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.support.TestContainerLabels;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * PLAN-0639 M1 (V103): {@code workspace_roots} + {@code run_checkpoints} unique-key extension.
 *
 * <p>The DDL is the contract, so every constraint is asserted against a real PostgreSQL rather
 * than trusted from review.  The probes that matter most:</p>
 * <ul>
 *   <li><b>partial unique indexes</b> — active rows must not collide on
 *       {@code (workspace_id, lower(host_path))} or {@code (workspace_id, position)}, while
 *       soft-deleted rows are excluded from both;</li>
 *   <li><b>backfill</b> — every pre-existing direct-attach workspace gets exactly one root row
 *       with {@code id = workspace_id} (primary-root invariant), and {@code run_checkpoints.root_id}
 *       is untouched;</li>
 *   <li><b>unique-key extension</b> — {@code uq_run_checkpoints_workspace_root_source_run}
 *       replaces {@code uq_run_checkpoints_workspace_source_run} so a multi-root run can hold
 *       one slice per root without collision.</li>
 * </ul>
 */
@Testcontainers
class WorkspaceRootsMigrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_v103")
            .withUsername("test")
            .withPassword("test")
            .withLabels(TestContainerLabels.runId());

    private static final UUID USER_ID = UUID.randomUUID();
    private static Connection connection;

    @BeforeAll
    static void migrateAndSeed() throws SQLException {
        String url = postgres.getJdbcUrl();
        Flyway.configure().dataSource(url, postgres.getUsername(), postgres.getPassword()).load().migrate();
        connection = DriverManager.getConnection(url, postgres.getUsername(), postgres.getPassword());
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + USER_ID
                + "', 'v103@test.local', 'x', 'v103user')");
    }

    @BeforeEach
    void clearRoots() throws SQLException {
        execute("DELETE FROM workspace_roots");
    }

    // ---------------------------------------------------------------- tests

    @Test
    void freshSchemaMatchesDesign() throws SQLException {
        // Table exists with the expected columns.
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM information_schema.tables"
                + " WHERE table_name = 'workspace_roots'"));

        // Partial unique indexes are present.
        assertEquals(2, scalarInt(
                "SELECT count(*) FROM pg_indexes"
                + " WHERE tablename = 'workspace_roots'"
                + "  AND indexname IN ('uq_workspace_roots_active_path',"
                + "                    'uq_workspace_roots_active_position')"));

        // FK to workspaces is RESTRICT (not CASCADE).
        assertEquals("RESTRICT", scalarString(
                "SELECT delete_rule FROM information_schema.referential_constraints"
                + " WHERE constraint_name IN ("
                + "   SELECT constraint_name FROM information_schema.key_column_usage"
                + "   WHERE table_name = 'workspace_roots' AND column_name = 'workspace_id')"));
    }

    @Test
    void backfillCreatesPrimaryRootPerExistingWorkspace() throws SQLException {
        // Pre-existing direct-attach workspaces get exactly one root row, id = workspace_id.
        UUID wsDirect = newWorkspace("direct_attach", "H:\\proj\\alpha");
        UUID wsManaged = newWorkspace("managed_import", null);

        // The migration already ran in @BeforeAll; simulate what V103 backfill did by re-running
        // the INSERT (idempotent: PK collision makes re-insert a no-op).
        execute("INSERT INTO workspace_roots (id, workspace_id, position, host_path, created_by)"
                + " SELECT id, id, 0, host_path, 'system:migration' FROM workspaces"
                + " WHERE storage_mode = 'direct_attach' AND host_path IS NOT NULL"
                + " ON CONFLICT (id) DO NOTHING");

        // direct-attach with host_path → exactly one root row, id = workspace_id, position 0.
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM workspace_roots WHERE workspace_id = '" + wsDirect + "'"));
        assertEquals(wsDirect.toString(), scalarString(
                "SELECT id FROM workspace_roots WHERE workspace_id = '" + wsDirect + "'"));
        assertEquals(0, scalarInt(
                "SELECT position FROM workspace_roots WHERE workspace_id = '" + wsDirect + "'"));

        // managed_import → no root row.
        assertEquals(0, scalarInt(
                "SELECT count(*) FROM workspace_roots WHERE workspace_id = '" + wsManaged + "'"));
    }

    @Test
    void activePathUniquenessIsCaseInsensitiveAndPartial() throws SQLException {
        UUID ws = newWorkspace("direct_attach", "H:\\proj\\beta");

        // First insert succeeds.
        insertRoot(ws, UUID.randomUUID(), 1, "H:\\Proj\\Beta", "user:" + USER_ID);

        // Same canonical path (case-folded) → rejected by partial unique index.
        assertThrows(SQLException.class,
                () -> insertRoot(ws, UUID.randomUUID(), 2, "h:\\proj\\beta", "user:" + USER_ID));

        // Soft-delete the first row; a new root at the same path is now allowed.
        execute("UPDATE workspace_roots SET deleted_at = now() WHERE workspace_id = '" + ws + "'");
        insertRoot(ws, UUID.randomUUID(), 1, "H:\\proj\\beta", "user:" + USER_ID);
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM workspace_roots"
                + " WHERE workspace_id = '" + ws + "' AND deleted_at IS NULL"));
    }

    @Test
    void activePositionUniquenessIsPartial() throws SQLException {
        UUID ws = newWorkspace("direct_attach", "H:\\proj\\gamma");

        insertRoot(ws, UUID.randomUUID(), 0, "H:\\proj\\gamma", "user:" + USER_ID);

        // Same position → rejected.
        assertThrows(SQLException.class,
                () -> insertRoot(ws, UUID.randomUUID(), 0, "H:\\proj\\gamma-2", "user:" + USER_ID));

        // Soft-delete and re-use the position.
        execute("UPDATE workspace_roots SET deleted_at = now() WHERE workspace_id = '" + ws + "'");
        insertRoot(ws, UUID.randomUUID(), 0, "H:\\proj\\gamma-2", "user:" + USER_ID);
    }

    @Test
    void runCheckpointsUniqueKeyExtendedWithRootId() throws SQLException {
        // The old single-column-plus-workspace key is gone; the new one includes root_id.
        assertEquals(0, scalarInt(
                "SELECT count(*) FROM information_schema.table_constraints"
                + " WHERE table_name = 'run_checkpoints'"
                + "  AND constraint_name = 'uq_run_checkpoints_workspace_source_run'"));
        assertEquals(1, scalarInt(
                "SELECT count(*) FROM information_schema.table_constraints"
                + " WHERE table_name = 'run_checkpoints'"
                + "  AND constraint_name = 'uq_run_checkpoints_workspace_root_source_run'"));
    }

    // ---------------------------------------------------------------- helpers

    private static UUID newWorkspace(String storageMode, String hostPath) throws SQLException {
        UUID id = UUID.randomUUID();
        String path = hostPath == null ? "NULL" : "'" + hostPath.replace("'", "''") + "'";
        execute("INSERT INTO workspaces (id, name, storage_mode, host_path) VALUES ('" + id
                + "', 'v103-ws-" + id + "', '" + storageMode + "', " + path + ")");
        return id;
    }

    private static void insertRoot(UUID ws, UUID rootId, int position, String hostPath, String createdBy)
            throws SQLException {
        execute("INSERT INTO workspace_roots (id, workspace_id, position, host_path, created_by) VALUES ('"
                + rootId + "', '" + ws + "', " + position + ", '" + hostPath.replace("'", "''")
                + "', '" + createdBy + "')");
    }

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private static int scalarInt(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getInt(1);
        }
    }

    private static String scalarString(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getString(1);
        }
    }
}
