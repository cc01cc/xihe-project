package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0610 W2: V88 data copy on a database that still carries the V87 shape plus legacy rows
 * (users.role, workspace_users.role, workspaces.owner_id, grants source=default/direct).
 *
 * <p>Proves T2.1/T2.1a/T2.1b: the five-value workspace mapping loses no row, the owner fact
 * becomes a {@code WS_OWNER} binding, user defaults are replaced by the materialized role union,
 * {@code default} splits by subject ({@code role} vs frozen {@code agent_default}), {@code direct}
 * splits by subject (audited delete vs {@code credential_binding}), and the same migration narrows
 * {@code ck_grants_source} and drops the V38/V65 fences. Runs on real PostgreSQL (Testcontainers);
 * the H2 unit profile never runs Flyway (application-h2.properties).</p>
 */
class AccessRoleDataBackfillMigrationTest {
    /** PLAN-eff/task-13 M1（A1）：空库由 JVM 单例容器下发；本类仍自行 Flyway 到目标版本。 */
    static TestDatabaseProvider.DatabaseRef postgres = TestDatabaseProvider.emptyDatabase("access_role_da");

    private static final UUID ROLE_ADMIN = UUID.fromString("00000000-0000-4000-8000-000000000002");
    private static final UUID ROLE_USER = UUID.fromString("00000000-0000-4000-8000-000000000003");
    private static final UUID ROLE_WS_OWNER = UUID.fromString("00000000-0000-4000-8000-000000000004");
    private static final UUID ROLE_WS_EDITOR = UUID.fromString("00000000-0000-4000-8000-000000000005");
    private static final UUID ROLE_WS_VIEWER = UUID.fromString("00000000-0000-4000-8000-000000000006");

    private static Connection connection;

    private static UUID adminUser;
    private static UUID plainUser;
    private static UUID ownerUser;
    private static UUID editorUser;
    private static UUID viewerUser;
    private static UUID adminMemberUser;
    private static UUID memberUser;
    private static UUID workspaceId;
    private static UUID sessionDefaultSubject;
    private static UUID principalDefaultSubject;
    private static UUID principalDirectSubject;
    private static UUID principalConflictSubject;
    private static UUID principalDuplicateDefaultSubject;

    // ---------------------------------------------------------------------
    // setup: V87 window + legacy fixtures
    // ---------------------------------------------------------------------

    @BeforeAll
    static void migrateToV87AndSeedLegacyRows() throws SQLException {
        Flyway.configure()
                .dataSource(postgres.jdbcUrl(), postgres.username(), postgres.password())
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("87"))
                .load()
                .migrate();
        connection = DriverManager.getConnection(
                postgres.jdbcUrl(), postgres.username(), postgres.password());

        adminUser = createUser("ADMIN");
        plainUser = createUser("USER");
        ownerUser = createUser("USER");
        editorUser = createUser("USER");
        viewerUser = createUser("USER");
        adminMemberUser = createUser("USER");
        memberUser = createUser("USER");

        workspaceId = UUID.randomUUID();
        executeUpdate("INSERT INTO workspaces (id, name, owner_id) VALUES ('" + workspaceId
                + "'::uuid, 'v88-ws', '" + ownerUser + "'::uuid)");

        // design I5: the instance owner must hold SUPER_ADMIN after the copy (pre-migration-audit §3.2)
        executeUpdate("UPDATE instance_owner SET owner_user_id = '" + adminUser
                + "'::uuid, assigned_at = NOW() WHERE id = 1");

        // All five stored workspace roles; OWNER comes twice (membership row + workspaces.owner_id)
        // so the idempotent owner binding is exercised.
        insertWorkspaceMember(workspaceId, ownerUser, "OWNER");
        insertWorkspaceMember(workspaceId, editorUser, "EDITOR");
        insertWorkspaceMember(workspaceId, viewerUser, "VIEWER");
        insertWorkspaceMember(workspaceId, adminMemberUser, "ADMIN");
        insertWorkspaceMember(workspaceId, memberUser, "MEMBER");

        sessionDefaultSubject = UUID.randomUUID();
        principalDefaultSubject = UUID.randomUUID();
        principalDirectSubject = UUID.randomUUID();
        principalConflictSubject = UUID.randomUUID();
        principalDuplicateDefaultSubject = UUID.randomUUID();

        // legacy defaults: users (ADMIN has the legacy 6-atom set, USER the 5-atom set)
        insertGrant("default", "user", adminUser,
                "[{\"actionClass\":\"read\"},{\"actionClass\":\"write\"},{\"actionClass\":\"delete\"},"
                        + "{\"actionClass\":\"exec\"},{\"actionClass\":\"network\"},{\"actionClass\":\"credential\"}]");
        insertGrant("default", "user", plainUser,
                "[{\"actionClass\":\"read\"},{\"actionClass\":\"write\"},{\"actionClass\":\"delete\"},"
                        + "{\"actionClass\":\"exec\"},{\"actionClass\":\"network\"}]");
        // legacy defaults for agent session + agent principal -> frozen agent_default
        insertGrant("default", "agent", sessionDefaultSubject, "[{\"actionClass\":\"read\"}]");
        insertGrant("default", "agent_principal", principalDefaultSubject, "[{\"actionClass\":\"read\"}]");
        // a subject that already has the W1a frozen snapshot + a stale legacy default row
        insertGrant("agent_default", "agent_principal", principalDuplicateDefaultSubject,
                "[{\"actionClass\":\"read\"}]");
        insertGrant("default", "agent_principal", principalDuplicateDefaultSubject,
                "[{\"actionClass\":\"write\"}]");

        // legacy direct rows: user (retire+audit), agent session (retire+audit),
        // agent principal (rename to credential_binding), agent principal with an existing
        // credential_binding row (legacy copy dropped, credential row wins)
        insertGrant("direct", "user", plainUser,
                "[{\"actionClass\":\"read\"},{\"actionClass\":\"exec\"}]");
        insertGrant("direct", "agent", UUID.randomUUID(), "[{\"actionClass\":\"read\"}]");
        insertGrant("direct", "agent_principal", principalDirectSubject,
                "[{\"actionClass\":\"credential_use\",\"resource\":\"credential:*\"}]");
        insertGrant("credential_binding", "agent_principal", principalConflictSubject,
                "[{\"actionClass\":\"credential_use\",\"resource\":\"credential:*\"}]");
        insertGrant("direct", "agent_principal", principalConflictSubject,
                "[{\"actionClass\":\"credential_use\",\"resource\":\"credential:*\"}]");

        // orphaned user default (subject not in users): audited then dropped
        insertGrant("default", "user", UUID.randomUUID(), "[{\"actionClass\":\"read\"}]");

        // switch to the V88 window — this class asserts what V88 leaves behind for V89, so it must
        // not run the destructive V89 step (the schema tests cover that).
        Flyway.configure()
                .dataSource(postgres.jdbcUrl(), postgres.username(), postgres.password())
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("88"))
                .load()
                .migrate();
    }

    // ---------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------

    private static int scalarInt(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            rs.next();
            return rs.getInt(1);
        }
    }

    private static String scalarString(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            rs.next();
            return rs.getString(1);
        }
    }

    private static void executeUpdate(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.executeUpdate(sql);
        }
    }

    private static UUID createUser(String role) throws SQLException {
        UUID userId = UUID.randomUUID();
        executeUpdate("INSERT INTO users (id, email, password_hash, role, username) VALUES ('" + userId
                + "'::uuid, 'v88-" + userId + "@test.local', 'hash', '" + role
                + "', 'x' || left(md5(random()::text), 31))");
        return userId;
    }

    private static void insertWorkspaceMember(UUID workspace, UUID user, String role) throws SQLException {
        executeUpdate("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ('" + workspace
                + "'::uuid, '" + user + "'::uuid, '" + role + "')");
    }

    private static void insertGrant(String source, String subjectType, UUID subjectId, String permissionsJson)
            throws SQLException {
        executeUpdate("INSERT INTO grants (id, subject_type, subject_id, permissions, source) VALUES ('"
                + UUID.randomUUID() + "'::uuid, '" + subjectType + "', '" + subjectId + "'::uuid, CAST('"
                + permissionsJson + "' AS JSONB), '" + source + "')");
    }

    private static String instanceRole(UUID user) throws SQLException {
        return scalarString("SELECT r.name FROM role_bindings b JOIN roles r ON r.id = b.role_id "
                + "WHERE b.subject_type = 'user' AND b.subject_id = '" + user + "'::uuid "
                + "AND b.scope_type = 'instance'");
    }

    private static String bindingRole(UUID user, UUID workspace) throws SQLException {
        return scalarString("SELECT r.name FROM role_bindings b JOIN roles r ON r.id = b.role_id "
                + "WHERE b.subject_type = 'user' AND b.subject_id = '" + user + "'::uuid "
                + "AND b.scope_type = 'workspace' AND b.scope_id = '" + workspace + "'::uuid");
    }

    // ---------------------------------------------------------------------
    // V88 assertions
    // ---------------------------------------------------------------------

    @Test
    void v88IsRecordedAndNarrowsTheSourceAllowListInTheSameMigration() throws SQLException {
        assertEquals(1, scalarInt("SELECT count(*) FROM flyway_schema_history "
                + "WHERE version = '88' AND success = true"), "V88 must be applied");
        String definition = scalarString("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                + "WHERE conname = 'ck_grants_source'");
        for (String source : new String[]{"role", "spawn", "template", "credential_binding", "agent_default"}) {
            assertTrue(definition.contains("'" + source + "'"), "allowed source: " + source + " in " + definition);
        }
        assertTrue(!definition.contains("'default'"), "V88 must narrow default away: " + definition);
        assertTrue(!definition.contains("'direct'"), "V88 must narrow direct away: " + definition);

        assertThrows(SQLException.class, () -> insertGrant("default", "user", UUID.randomUUID(),
                "[{\"actionClass\":\"read\"}]"), "legacy source is rejected after V88");
        assertThrows(SQLException.class, () -> insertGrant("direct", "user", UUID.randomUUID(),
                "[{\"actionClass\":\"read\"}]"), "legacy source is rejected after V88");

        assertEquals(0, scalarInt("SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' "
                + "AND indexname IN ('uq_grants_default_subject', 'uq_grants_direct_subject')"),
                "the V38/V65 fences are dropped after their rows are converted");
    }

    @Test
    void v88CreatesInstanceBindingsFromUsersRole() throws SQLException {
        assertEquals("ADMIN", instanceRole(adminUser), "users.role ADMIN maps to the ADMIN role");
        assertEquals("USER", instanceRole(plainUser), "users.role USER maps to the USER role");
        assertEquals(1, scalarInt("SELECT count(*) FROM role_bindings b JOIN roles r ON r.id = b.role_id "
                + "WHERE b.subject_type = 'user' AND b.subject_id = '" + adminUser + "'::uuid "
                + "AND b.scope_type = 'instance' AND r.name = 'ADMIN'"));
        assertEquals("SUPER_ADMIN", scalarString("SELECT r.name FROM role_bindings b "
                + "JOIN roles r ON r.id = b.role_id WHERE b.subject_type = 'user' AND b.subject_id = '"
                + adminUser + "'::uuid AND b.scope_type = 'instance' AND r.name = 'SUPER_ADMIN'"),
                "design I5: the instance owner gets the SUPER_ADMIN binding");
        assertEquals(0, scalarInt("SELECT count(*) FROM users u WHERE "
                + "NOT EXISTS (SELECT 1 FROM role_bindings b WHERE b.subject_type = 'user' "
                + "AND b.subject_id = u.id AND b.scope_type = 'instance')"),
                "every user ends with an instance binding");
    }

    @Test
    void v88MapsAllFiveWorkspaceRolesWithZeroLoss() throws SQLException {
        assertEquals("WS_OWNER", bindingRole(ownerUser, workspaceId));
        assertEquals("WS_EDITOR", bindingRole(editorUser, workspaceId));
        assertEquals("WS_EDITOR", bindingRole(adminMemberUser, workspaceId),
                "legacy ADMIN canonicalizes to EDITOR (WorkspaceRole.canonicalName)");
        assertEquals("WS_EDITOR", bindingRole(memberUser, workspaceId),
                "legacy MEMBER canonicalizes to EDITOR");
        assertEquals("WS_VIEWER", bindingRole(viewerUser, workspaceId));

        assertEquals(5, scalarInt("SELECT count(*) FROM workspace_users"), "fixture sanity");
        assertEquals(5, scalarInt("SELECT count(*) FROM role_bindings b "
                + "WHERE b.scope_type = 'workspace' AND b.scope_id = '" + workspaceId + "'::uuid"),
                "each workspace_users row produced exactly one binding (owner row is idempotent)");
        assertEquals(1, scalarInt("SELECT count(*) FROM role_bindings b JOIN roles r ON r.id = b.role_id "
                + "WHERE b.subject_type = 'user' AND b.subject_id = '" + ownerUser + "'::uuid "
                + "AND b.scope_type = 'workspace' AND b.scope_id = '" + workspaceId + "'::uuid "
                + "AND r.name = 'WS_OWNER'"), "workspaces.owner_id created the owner binding");
    }

    @Test
    void v88ReplacesUserDefaultsWithTheMaterializedRoleUnion() throws SQLException {
        assertEquals(0, scalarInt("SELECT count(*) FROM grants WHERE source = 'default'"));
        // The ADMIN fixture is also the instance owner, so its instance atoms are the union of
        // ADMIN (8 materializable atoms) and SUPER_ADMIN (15 action atoms) = 15 distinct atoms.
        // The three SUPER_ADMIN capability atoms must never be materialized.
        assertEquals(15, scalarInt("SELECT count(*) FROM grants WHERE source = 'role' "
                + "AND subject_type = 'user' AND subject_id = '" + adminUser + "'::uuid "
                + "AND scope_type = 'instance'"),
                "owner atoms are the deduplicated ADMIN + SUPER_ADMIN union");
        assertEquals(5, scalarInt("SELECT count(*) FROM grants WHERE source = 'role' "
                + "AND subject_type = 'user' AND subject_id = '" + plainUser + "'::uuid "
                + "AND scope_type = 'instance'"));
        // Workspace scope is carried over from the binding (P0-1): a workspace-only atom never
        // appears for a non-owner, and the instance owner's SUPER_ADMIN legitimately carries
        // MANAGE_WORKSPACE_AGENTS at instance scope (decision #27 made it scope_class=both).
        assertEquals(0, scalarInt("SELECT count(*) FROM grants WHERE source = 'role' "
                + "AND scope_type = 'instance' AND subject_id = '" + plainUser + "'::uuid "
                + "AND permissions -> 0 ->> 'actionClass' = 'MANAGE_WORKSPACE_AGENTS'"));
        assertEquals(1, scalarInt("SELECT count(*) FROM grants WHERE source = 'role' "
                + "AND scope_type = 'instance' AND subject_id = '" + adminUser + "'::uuid "
                + "AND permissions -> 0 ->> 'actionClass' = 'MANAGE_WORKSPACE_AGENTS'"));
        assertEquals(1, scalarInt("SELECT count(*) FROM grants WHERE source = 'role' AND scope_type = 'workspace' "
                + "AND scope_id = '" + workspaceId + "'::uuid "
                + "AND subject_id = '" + ownerUser + "'::uuid "
                + "AND permissions -> 0 ->> 'actionClass' = 'MANAGE_WORKSPACE_AGENTS'"));
        assertEquals(0, scalarInt("SELECT count(*) FROM grants WHERE permissions -> 0 ->> 'actionClass' LIKE '%:%'"),
                "capability atoms never reach grants (decision #23)");
    }

    @Test
    void v88SplitsDefaultBySubjectIntoAgentDefault() throws SQLException {
        assertEquals(1, scalarInt("SELECT count(*) FROM grants WHERE source = 'agent_default' "
                + "AND subject_type = 'agent' AND subject_id = '" + sessionDefaultSubject + "'::uuid"));
        assertEquals(1, scalarInt("SELECT count(*) FROM grants WHERE source = 'agent_default' "
                + "AND subject_type = 'agent_principal' AND subject_id = '" + principalDefaultSubject + "'::uuid"));
        assertEquals(1, scalarInt("SELECT count(*) FROM grants WHERE source = 'agent_default' "
                + "AND subject_id = '" + principalDuplicateDefaultSubject + "'::uuid"),
                "an existing frozen snapshot wins over the stale legacy default row");
        assertEquals(1, scalarInt("SELECT count(*) FROM audit_logs WHERE action = "
                + "'authorization_default_grant_dropped_duplicate'"), "the dropped duplicate is audited");
        assertEquals(1, scalarInt("SELECT count(*) FROM audit_logs WHERE action = "
                + "'authorization_default_grant_dropped_orphan'"), "the orphaned user default is audited");
    }

    @Test
    void v88SplitsDirectBySubjectWithAnAuditLedger() throws SQLException {
        assertEquals(0, scalarInt("SELECT count(*) FROM grants WHERE source = 'direct'"));
        assertEquals(1, scalarInt("SELECT count(*) FROM grants WHERE source = 'credential_binding' "
                + "AND subject_type = 'agent_principal' AND subject_id = '" + principalDirectSubject + "'::uuid"),
                "agent-principal direct rows become credential bindings");
        assertEquals(1, scalarInt("SELECT count(*) FROM grants WHERE source = 'credential_binding' "
                + "AND subject_id = '" + principalConflictSubject + "'::uuid"),
                "the existing credential binding wins, the legacy copy is dropped");
        assertEquals(4, scalarInt("SELECT count(*) FROM audit_logs WHERE action = "
                + "'authorization_direct_grant_retired'"), "one audit row per retired direct row");
        assertEquals(1, scalarInt("SELECT count(*) FROM audit_logs WHERE action = "
                + "'authorization_direct_grant_retired' AND details::JSONB ->> 'subjectType' = 'user'"));
        assertTrue(scalarString("SELECT details FROM audit_logs WHERE action = "
                + "'authorization_direct_grant_retired' AND details::JSONB ->> 'subjectType' = 'user' "
                + "LIMIT 1").contains("permissions"), "the ledger keeps the retired atoms");
    }

    @Test
    void v88KeepsLegacyColumnsForV89() throws SQLException {
        // The column/table drop is V89 (W4b, exercised by the schema tests); V88 must not remove
        // the source facts.
        assertEquals(1, scalarInt("SELECT count(*) FROM information_schema.columns "
                + "WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'role'"));
        assertEquals(1, scalarInt("SELECT count(*) FROM information_schema.columns "
                + "WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'owner_id'"));
        assertEquals(1, scalarInt("SELECT count(*) FROM information_schema.tables "
                + "WHERE table_schema = 'public' AND table_name = 'workspace_users'"));
    }

    @Test
    void v88OnAnEmptyDatabaseIsANoOp() throws SQLException {
        // PLAN-eff/task-13 M1（A1）：空库来自 JVM 单例容器（不再自起第二个容器，也不再负责停止它）；
        // 现场保留到 JVM 退出，便于失败后进库排查。
        TestDatabaseProvider.DatabaseRef empty = TestDatabaseProvider.emptyDatabase("access_role_empty");
        Flyway.configure()
                .dataSource(empty.jdbcUrl(), empty.username(), empty.password())
                .locations("classpath:db/migration")
                .load()
                .migrate();
        try (Connection fresh = DriverManager.getConnection(
                empty.jdbcUrl(), empty.username(), empty.password());
             Statement statement = fresh.createStatement()) {
            try (ResultSet rs = statement.executeQuery(
                    "SELECT count(*) FROM flyway_schema_history WHERE version = '88' AND success = true")) {
                rs.next();
                assertEquals(1, rs.getInt(1), "V88 applies cleanly to a fresh database");
            }
            try (ResultSet rs = statement.executeQuery("SELECT count(*) FROM grants")) {
                rs.next();
                assertEquals(0, rs.getInt(1), "no legacy rows means no copied rows");
            }
            try (ResultSet rs = statement.executeQuery("SELECT count(*) FROM role_bindings")) {
                rs.next();
                assertEquals(0, rs.getInt(1), "no users means no bindings");
            }
        }
    }
}
