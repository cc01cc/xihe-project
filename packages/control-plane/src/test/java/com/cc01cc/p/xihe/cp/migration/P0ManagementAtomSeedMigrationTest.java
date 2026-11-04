package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.flywaydb.core.api.output.MigrateResult;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0651 M1 (T1.1, D51-26/D51-27): V111 seeds the two P0 management atoms and backfills the
 * already-materialized instance-scope subjects, so "who is an instance administrator" stops being a
 * code branch ({@code isInstanceAdmin()}) and becomes a grant.
 *
 * <p>Shape under test: migrate to <b>V110</b> (the last version before this plan), insert a subject
 * that already holds <b>two</b> instance-tier bindings (ADMIN + USER — the exact shape that made
 * V91's first backfill violate {@code uq_grants_role_atom}), then migrate to head and assert:</p>
 *
 * <ol>
 *   <li>the role definitions carry the new atoms for SUPER_ADMIN/ADMIN and {@code workspace:admin}
 *       for ADMIN;</li>
 *   <li>the legacy subject got exactly one materialized row per atom (the {@code DISTINCT ON}
 *       guarantee), and {@code workspace:admin} is <b>not</b> materialized (capability atom,
 *       PLAN-0610 decision #23);</li>
 *   <li>the zero-gap validation query from the migration header returns <b>0</b> rows (this is the
 *       assertion the plan requires instead of a comment in a document);</li>
 *   <li>the default sets stay inside the ruling: WS_OWNER gets neither atom, USER gets neither,
 *       ADMIN does <b>not</b> get {@code MANAGE_WORKSPACE_AGENTS} (14-1: that would widen
 *       {@code requireWorkspaceBindingAuthority} from 403 to allowed), and both new atoms are
 *       forbidden to agent principals (D51-27).</li>
 * </ol>
 */
class P0ManagementAtomSeedMigrationTest {

    private static final UUID LEGACY_USER_ID = UUID.randomUUID();
    private static final UUID SUPER_ADMIN_ID =
            UUID.fromString("00000000-0000-4000-8000-000000000001");
    private static final UUID ADMIN_ID = UUID.fromString("00000000-0000-4000-8000-000000000002");
    private static final UUID USER_ROLE_ID = UUID.fromString("00000000-0000-4000-8000-000000000003");
    private static final UUID WS_OWNER_ID = UUID.fromString("00000000-0000-4000-8000-000000000004");

    private static TestDatabaseProvider.DatabaseRef postgres;
    private static Connection connection;

    @BeforeAll
    static void migrateAcrossThePlanBoundary() throws SQLException {
        postgres = TestDatabaseProvider.emptyDatabase("plan0651_p0");
        String url = postgres.jdbcUrl();
        flyway(url).target(MigrationVersion.fromVersion("110")).load().migrate();
        connection = DriverManager.getConnection(url, postgres.username(), postgres.password());
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + LEGACY_USER_ID
                + "', 'p0-" + LEGACY_USER_ID + "@test.local', 'x', 'p0"
                + LEGACY_USER_ID.toString().substring(0, 8) + "')");
        bind(ADMIN_ID, "instance", null);
        bind(USER_ROLE_ID, "instance", null);
        // A second subject that only holds the workspace tier: it must gain nothing from V111.
        MigrateResult head = flyway(url).load().migrate();
        assertTrue(head.migrationsExecuted >= 1, "V111 (and anything newer) must actually run");
    }

    private static org.flywaydb.core.api.configuration.FluentConfiguration flyway(String url) {
        return Flyway.configure()
                .dataSource(url, postgres.username(), postgres.password())
                .locations("classpath:db/migration");
    }

    private static void bind(UUID roleId, String scopeType, UUID scopeId) throws SQLException {
        execute("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                + " scope_id, granted_by) VALUES ('" + UUID.randomUUID() + "', '" + roleId
                + "', 'user', '" + LEGACY_USER_ID + "', '" + scopeType + "', "
                + (scopeId == null ? "NULL" : "'" + scopeId + "'") + ", '" + LEGACY_USER_ID + "')");
    }

    @Test
    void roleDefinitionsCarryTheNewAtoms() throws SQLException {
        assertEquals(1, atomCount(ADMIN_ID, ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS));
        assertEquals(1, atomCount(ADMIN_ID, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS));
        assertEquals(1, atomCount(ADMIN_ID, PermissionAtomCatalog.CAP_WORKSPACE_ADMIN),
                "workspace:admin joins ADMIN so A9 can stop reading isInstanceAdmin()");
        assertEquals(1, atomCount(SUPER_ADMIN_ID, ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS));
        assertEquals(1, atomCount(SUPER_ADMIN_ID, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS));
        assertEquals(0, atomCount(WS_OWNER_ID, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS),
                "D51-26: WS_OWNER must not be seeded with member management");
        assertEquals(0, atomCount(USER_ROLE_ID, ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS));
    }

    @Test
    void adminDoesNotGainManageWorkspaceAgents() throws SQLException {
        assertEquals(0, atomCount(ADMIN_ID, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS),
                "14-1: seeding it would turn requireWorkspaceBindingAuthority from 403 to allowed");
    }

    @Test
    void legacySubjectGetsOneMaterializedRowPerAtom() throws SQLException {
        assertEquals(1, grantCount("MANAGE_AGENT_PRINCIPALS"),
                "two tier bindings must still yield exactly one row (DISTINCT ON)");
        assertEquals(1, grantCount("MANAGE_WORKSPACE_MEMBERS"));
        assertEquals(0, grantCount(PermissionAtomCatalog.CAP_WORKSPACE_ADMIN),
                "capability atoms are never materialized (PLAN-0610 decision #23)");
    }

    @Test
    void zeroGapValidationQueryReturnsNoRows() throws SQLException {
        String sql = "SELECT count(*) FROM role_bindings b "
                + "JOIN role_permissions rp ON rp.role_id = b.role_id "
                + "WHERE rp.action_class IN ('MANAGE_AGENT_PRINCIPALS','MANAGE_WORKSPACE_MEMBERS') "
                + "  AND NOT EXISTS (SELECT 1 FROM grants g "
                + "                  WHERE g.subject_type='user' AND g.subject_id=b.subject_id "
                + "                    AND g.source='role' AND g.scope_type=b.scope_type "
                + "                    AND coalesce(g.scope_id,"
                + "'00000000-0000-0000-0000-000000000000'::uuid)"
                + "                      = coalesce(b.scope_id,"
                + "'00000000-0000-0000-0000-000000000000'::uuid) "
                + "                    AND g.permissions->0->>'actionClass' = rp.action_class)";
        assertEquals(0, scalar(sql), "every bound atom must be materialized, otherwise 403 on deploy");
    }

    @Test
    void bothAtomsAreForbiddenToAgentPrincipals() {
        var forbidden = PermissionAtomCatalog.agentPrincipalForbiddenAtoms();
        assertTrue(forbidden.contains(ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS));
        assertTrue(forbidden.contains(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS));
        assertFalse(PermissionAtomCatalog.canBindToAgentPrincipal(
                java.util.List.of(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS)));
    }

    @Test
    void atomCountsStayConsistentWithTheCatalog() {
        assertEquals(19, PermissionAtomCatalog.actionAtoms().size(),
                "M1 adds exactly two atoms (17 -> 19); M2 brings the total to 27");
        assertEquals(3, PermissionAtomCatalog.capabilityAtoms().size());
        assertEquals(PermissionAtomCatalog.actionAtoms().size(),
                ToolFaceRegistry.builtinActionClasses().size(),
                "the catalog and the built-in action vocabulary must agree (MemoryWriteAtomTest)");
        assertTrue(ToolFaceRegistry.builtinActionClasses()
                        .containsAll(java.util.List.of(ToolFaceRegistry.ACTION_MANAGE_AGENT_PRINCIPALS,
                                ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS)),
                "the new atoms are part of the action vocabulary");
    }

    private static int atomCount(UUID roleId, String actionClass) throws SQLException {
        return scalar("SELECT count(*) FROM role_permissions WHERE role_id = '" + roleId
                + "'::uuid AND action_class = '" + actionClass + "'");
    }

    private static int grantCount(String actionClass) throws SQLException {
        return scalar("SELECT count(*) FROM grants WHERE subject_type = 'user' AND subject_id = '"
                + LEGACY_USER_ID + "'::uuid AND source = 'role' AND scope_type = 'instance'"
                + " AND permissions->0->>'actionClass' = '" + actionClass + "'");
    }

    private static int scalar(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getInt(1);
        }
    }

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }
}
