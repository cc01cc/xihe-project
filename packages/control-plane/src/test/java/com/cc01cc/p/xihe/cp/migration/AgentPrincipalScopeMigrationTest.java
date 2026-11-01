package com.cc01cc.p.xihe.cp.migration;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0622 T0.2 (M0.2): V90 — agent-principal three-tier scope, model intent, connection/model
 * resource limits.
 *
 * <p>The scope migration is a one-shot: every pre-existing principal is backfilled to
 * {@code WORKSPACE} (the only tier that existed), so this class seeds a legacy row at the V89
 * shape and then migrates to the current head before asserting. The two CHECK constraints are the
 * contract the service layer relies on — {@code PERSONAL} without an owner and a non-personal
 * scope with an owner must both be rejected by the database, not only by Java.</p>
 */
@Testcontainers
class AgentPrincipalScopeMigrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_v90")
            .withUsername("test")
            .withPassword("test");

    private static final UUID LEGACY_PRINCIPAL_ID = UUID.randomUUID();
    private static final UUID LEGACY_USER_ID = UUID.randomUUID();

    private static Connection connection;

    @BeforeAll
    static void backfillProvesTheOneShotScopeMigration() throws SQLException {
        String url = postgres.getJdbcUrl();
        Flyway.configure()
                .dataSource(url, postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("89"))
                .load()
                .migrate();
        connection = DriverManager.getConnection(url, postgres.getUsername(), postgres.getPassword());
        // V89 shape: users.role is gone, agent_principals has no scope yet.
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + LEGACY_USER_ID
                + "', 'legacy-" + LEGACY_USER_ID + "@test.local', 'x', 'legacy" + LEGACY_USER_ID.toString().substring(0, 8)
                + "')");
        execute("INSERT INTO agent_principals (id, name, created_by_user_id) VALUES ('"
                + LEGACY_PRINCIPAL_ID + "', 'legacy principal', '" + LEGACY_USER_ID + "')");
        // A V89-era instance tier binding: V91 must backfill its materialized CREATE_OWN_AGENT row,
        // otherwise existing accounts would keep the five-atom set until their next materialization.
        execute("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type, scope_id,"
                + " granted_by) VALUES ('" + UUID.randomUUID() + "', '"
                + "00000000-0000-4000-8000-000000000003', 'user', '" + LEGACY_USER_ID
                + "', 'instance', NULL, '" + LEGACY_USER_ID + "')");

        Flyway.configure()
                .dataSource(url, postgres.getUsername(), postgres.getPassword())
                .locations("classpath:db/migration")
                .load()
                .migrate();
    }

    @Test
    void legacyPrincipalsAreBackfilledToWorkspaceWithoutAnOwner() throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT scope, owner_user_id, default_model_provider,"
                     + " default_model_name, allowed_models FROM agent_principals WHERE id = '"
                     + LEGACY_PRINCIPAL_ID + "'")) {
            assertTrue(rows.next(), "the seeded legacy principal survives the migration");
            assertEquals("WORKSPACE", rows.getString("scope"),
                    "every pre-existing principal is WORKSPACE (they only worked through workspace_agents)");
            assertNull(rows.getString("owner_user_id"), "WORKSPACE keeps a null owner");
            assertNull(rows.getString("default_model_provider"));
            assertNull(rows.getString("default_model_name"));
            assertNull(rows.getString("allowed_models"));
        }
    }

    @Test
    void scopeAndOwnerShapeMatchesTheColumnContract() throws SQLException {
        assertEquals("WORKSPACE", columnDefault("agent_principals", "scope"),
                "scope defaults to WORKSPACE for clients that omit it");
        assertFalse(isNullable("agent_principals", "scope"), "scope is NOT NULL");
        assertTrue(isNullable("agent_principals", "owner_user_id"));
        assertTrue(isNullable("agent_principals", "default_model_provider"));
        assertTrue(isNullable("agent_principals", "default_model_name"));
        assertTrue(isNullable("agent_principals", "allowed_models"));
    }

    @Test
    void databaseRejectsTheThreeIllegalScopeShapes() throws SQLException {
        // 1: PERSONAL without an owner.
        assertThrows(SQLException.class, () -> execute(principalInsert(UUID.randomUUID(), "PERSONAL", null)),
                "PERSONAL without owner_user_id violates ck_agent_principals_owner");
        // 2: a non-personal scope carrying an owner.
        assertThrows(SQLException.class, () -> execute(principalInsert(UUID.randomUUID(), "WORKSPACE",
                        LEGACY_USER_ID)),
                "WORKSPACE with an owner_user_id violates ck_agent_principals_owner");
        // 3: an unknown tier.
        assertThrows(SQLException.class, () -> execute(principalInsert(UUID.randomUUID(), "SHARED", null)),
                "scope must stay inside the three tiers");
    }

    @Test
    void personalScopeWithItsOwnerIsAccepted() throws SQLException {
        UUID principal = UUID.randomUUID();
        execute(principalInsert(principal, "PERSONAL", LEGACY_USER_ID));
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT scope, owner_user_id FROM agent_principals WHERE id = '"
                     + principal + "'")) {
            assertTrue(rows.next());
            assertEquals("PERSONAL", rows.getString("scope"));
            assertEquals(LEGACY_USER_ID.toString(), rows.getString("owner_user_id"));
        }
    }

    @Test
    void connectionLimitColumnsAreNullableSoUnconfiguredMeansUnlimited() throws SQLException {
        for (String column : new String[] {"max_inflight", "max_queue", "window_token_budget", "window_seconds"}) {
            assertTrue(columnExists("provider_connections", column), "provider_connections." + column + " exists");
            assertTrue(isNullable("provider_connections", column),
                    column + " is nullable: an unconfigured limit means unlimited");
        }
    }

    @Test
    void modelLimitTableIsKeyedAndCascadesWithItsConnection() throws SQLException {
        UUID connectionId = UUID.randomUUID();
        execute("INSERT INTO provider_connections (id, owner_type, owner_id, provider_id, label,"
                + " connection_key, api_type_id, api_type_version) VALUES ('" + connectionId
                + "', 'USER', '" + LEGACY_USER_ID + "', 'openai', 'limit probe', 'limit-probe',"
                + " 'openai-chat-completions', 1)");
        execute("INSERT INTO provider_connection_model_limits (connection_id, provider, model, max_inflight,"
                + " window_token_budget, window_seconds) VALUES ('" + connectionId + "', 'openai', 'gpt-4o', 2,"
                + " 100000, 60)");
        assertThrows(SQLException.class, () -> execute("INSERT INTO provider_connection_model_limits"
                        + " (connection_id, provider, model) VALUES ('" + connectionId + "', 'openai', 'gpt-4o')"),
                "the (connection, provider, model) primary key refuses a duplicate limit row");
        assertThrows(SQLException.class, () -> execute("INSERT INTO provider_connection_model_limits"
                        + " (connection_id, provider, model) VALUES ('" + UUID.randomUUID() + "', 'openai', 'x')"),
                "an unknown connection is refused by the foreign key");

        execute("DELETE FROM provider_connections WHERE id = '" + connectionId + "'");
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT count(*) FROM provider_connection_model_limits"
                     + " WHERE connection_id = '" + connectionId + "'")) {
            assertTrue(rows.next());
            assertEquals(0, rows.getInt(1), "deleting the connection cascades its model limits");
        }
    }

    @Test
    void headSeedsMatchTheCodeSideCatalog() throws SQLException {
        // PLAN-0622 D8 (M0.3): V91 makes the PostgreSQL seed agree with the code catalog again.
        assertEquals(PermissionAtomCatalog.actionAtoms().size() + PermissionAtomCatalog.capabilityAtoms().size(),
                roleAtomCount(SystemAccessRoleCatalog.SUPER_ADMIN_ID),
                "SUPER_ADMIN carries every action atom plus the capability atoms");
        // The per-role counts are derived from the code-side seeds: V91 is the SQL mirror of
        // SystemAccessRoleCatalog, so a hard-coded 10/6 would be the next thing to rot.
        assertEquals(seedAtomCount(SystemAccessRoleCatalog.ADMIN),
                roleAtomCount(SystemAccessRoleCatalog.ADMIN_ID),
                "ADMIN seeds exactly the atoms of its code-side role definition "
                        + "(nine action atoms incl. CREATE_OWN_AGENT, plus instance:admin)");
        assertEquals(seedAtomCount(SystemAccessRoleCatalog.USER),
                roleAtomCount(SystemAccessRoleCatalog.USER_ID),
                "USER seeds exactly the atoms of its code-side role definition "
                        + "(five registration atoms plus CREATE_OWN_AGENT)");
        for (UUID roleId : new UUID[] {SystemAccessRoleCatalog.SUPER_ADMIN_ID,
                SystemAccessRoleCatalog.ADMIN_ID, SystemAccessRoleCatalog.USER_ID}) {
            assertEquals(1, scalarInt("SELECT count(*) FROM role_permissions WHERE role_id = '" + roleId
                            + "'::uuid AND action_class = 'CREATE_OWN_AGENT'"),
                    "CREATE_OWN_AGENT is seeded on " + roleId);
        }
    }

    @Test
    void v91BackfillsTheMaterializedOwnAgentAtomForExistingTierSubjects() throws SQLException {
        assertEquals(1, scalarInt("SELECT count(*) FROM grants WHERE subject_type = 'user'"
                        + " AND subject_id = '" + LEGACY_USER_ID + "' AND source = 'role'"
                        + " AND scope_type = 'instance' AND scope_id IS NULL"
                        + " AND permissions -> 0 ->> 'actionClass' = 'CREATE_OWN_AGENT'"),
                "the pre-existing tier subject gets exactly one materialized CREATE_OWN_AGENT row");
    }

    private static int roleAtomCount(UUID roleId) throws SQLException {
        return scalarInt("SELECT count(*) FROM role_permissions WHERE role_id = '" + roleId + "'::uuid");
    }

    /** All atoms of one seeded system role, per the code-side catalog (V91 mirrors it). */
    private static long seedAtomCount(String roleName) {
        return SystemAccessRoleCatalog.roleSeeds().stream()
                .filter(seed -> roleName.equals(seed.name()))
                .findFirst()
                .orElseThrow()
                .atoms().size();
    }

    private static int scalarInt(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            assertTrue(rows.next(), "scalar query returns a row: " + sql);
            return rows.getInt(1);
        }
    }

    private static String principalInsert(UUID id, String scope, UUID owner) {
        return "INSERT INTO agent_principals (id, name, created_by_user_id, scope, owner_user_id) VALUES ('"
                + id + "', 'scope probe', '" + LEGACY_USER_ID + "', '" + scope + "', "
                + (owner == null ? "NULL" : "'" + owner + "'") + ")";
    }

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private static boolean columnExists(String table, String column) throws SQLException {
        return columnInfo(table, column, "column_name") != null;
    }

    private static boolean isNullable(String table, String column) throws SQLException {
        return "YES".equals(columnInfo(table, column, "is_nullable"));
    }

    private static String columnDefault(String table, String column) throws SQLException {
        String value = columnInfo(table, column, "column_default");
        return value == null ? null : value.replace("'", "").replace("::character varying", "");
    }

    private static String columnInfo(String table, String column, String field) throws SQLException {
        String sql = "SELECT " + field + " FROM information_schema.columns WHERE table_name = '" + table
                + "' AND column_name = '" + column + "'";
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            return rows.next() ? rows.getString(1) : null;
        }
    }
}
