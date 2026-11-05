package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0651 D-174 (user ruling 2026-11-05) / V126: the agent-principal PERSONAL/WORKSPACE/INSTANCE
 * tier is removed outright — column, both CHECK constraints and the (scope, owner) index. The owner
 * column, {@code role_bindings.scope_type} and the atomic {@code scopeClass} are NOT part of the
 * removal (V126 header).
 *
 * <p>This class replaces the earlier V90-shaped assertions, which asserted the very column V126
 * drops ({@code SELECT scope}, {@code columnDefault(scope) = 'WORKSPACE'}, the three illegal tier
 * shapes). The口径 is now two-sided:</p>
 *
 * <p><b>Upgrade side</b>: replay migrations to the V125 shape (scope column, its default and both
 * CHECKs still in force), seed one legacy principal per tier, each with a workspace binding, a role
 * binding and a grant (only PERSONAL carries an owner — that coupling is exactly what V126
 * removes), then migrate to head. Every row, the owner relation, {@code workspace_agents},
 * {@code role_bindings} and {@code grants} must survive verbatim; the column, both CHECKs and the
 * (scope, owner) index must disappear; the owner FK must stay.</p>
 *
 * <p><b>Fresh side</b>: migrate an empty database straight to head. The column is not part of the
 * resulting schema and no tier CHECK exists, while {@code flyway_schema_history} proves V90 (which
 * adds the column) and V126 (which drops it) both ran — so the absence is a real end state, not a
 * migration that never executed. No tier data is fabricated on this side.</p>
 *
 * <p>The V90-era backfill, the V91 materialization, the provider limit contract and the head seed
 * parity stay in this class (same replay, same database). The fixture is therefore layered:
 * V89 shape → V125 shape (three tiers) → head.</p>
 */
class AgentPrincipalScopeMigrationTest {

    /** 升级侧：空库 → V89 形态种子 → V125 形态三档种子 → head。 */
    static TestDatabaseProvider.DatabaseRef postgres = TestDatabaseProvider.emptyDatabase("agent_principa_upg");
    /** fresh 侧：空库 → head（从不出现 tier 列）。 */
    static TestDatabaseProvider.DatabaseRef freshPostgres =
            TestDatabaseProvider.emptyDatabase("agent_principa_fresh");

    private static final UUID LEGACY_PRINCIPAL_ID = UUID.randomUUID();
    private static final UUID LEGACY_USER_ID = UUID.randomUUID();
    private static final UUID WORKSPACE_ID = UUID.randomUUID();

    private static final UUID PERSONAL_PRINCIPAL_ID = UUID.randomUUID();
    private static final UUID WORKSPACE_PRINCIPAL_ID = UUID.randomUUID();
    private static final UUID INSTANCE_PRINCIPAL_ID = UUID.randomUUID();

    private static final UUID PERSONAL_BINDING_ID = UUID.randomUUID();
    private static final UUID WORKSPACE_BINDING_ID = UUID.randomUUID();
    private static final UUID INSTANCE_BINDING_ID = UUID.randomUUID();

    private static final UUID PERSONAL_GRANT_ID = UUID.randomUUID();
    private static final UUID WORKSPACE_GRANT_ID = UUID.randomUUID();
    private static final UUID INSTANCE_GRANT_ID = UUID.randomUUID();

    /** The three tier principals, used by the before/after row comparisons. */
    private static final String TIER_PRINCIPALS = "'" + PERSONAL_PRINCIPAL_ID + "', '"
            + WORKSPACE_PRINCIPAL_ID + "', '" + INSTANCE_PRINCIPAL_ID + "'";

    private static Connection connection;
    private static Connection freshConnection;

    private static int principalsBefore;
    private static int workspaceAgentsBefore;
    private static int roleBindingsBefore;
    private static int grantsBefore;
    private static String workspaceBindingsBefore;
    private static String roleBindingSnapshotBefore;
    private static String grantSnapshotBefore;

    @BeforeAll
    static void replayBothSides() throws SQLException {
        // ---- upgrade side ----
        migrate(postgres, "89");
        connection = open(postgres);
        seedV89Shape();
        migrate(postgres, "125");
        seedLegacyTierFixture();
        assertLegacyTierContractIsInForceAtV125();
        capturePreRemovalState();
        migrate(postgres, null);
        // ---- fresh side ----
        migrate(freshPostgres, null);
        freshConnection = open(freshPostgres);
    }

    // ------------------------------------------------------------------ upgrade side: data survival

    @Test
    void everyLegacyTierPrincipalAndItsOwnerSurviveTheTierRemoval() throws SQLException {
        assertEquals(3, principalsBefore, "fixture: one principal per legacy tier was seeded");
        assertEquals(principalsBefore, countTierPrincipals(),
                "V126 drops a column; it must not drop principal rows");
        assertPrincipalSurvives(PERSONAL_PRINCIPAL_ID, "personal-tier-agent", LEGACY_USER_ID.toString(),
                "openai", "gpt-4o", "gpt-4o");
        assertPrincipalSurvives(WORKSPACE_PRINCIPAL_ID, "workspace-tier-agent", null,
                "anthropic", "claude-sonnet-4", null);
        assertPrincipalSurvives(INSTANCE_PRINCIPAL_ID, "instance-tier-agent", null, null, null, null);

        // The pre-tier (V89-shaped) principal also survives the whole replay, still ownerless.
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT name, created_by_user_id, owner_user_id"
                     + " FROM agent_principals WHERE id = '" + LEGACY_PRINCIPAL_ID + "'")) {
            assertTrue(rows.next(), "the V89-shaped principal survives the replay including V126");
            assertEquals("legacy principal", rows.getString("name"));
            assertEquals(LEGACY_USER_ID.toString(), rows.getString("created_by_user_id"));
            assertNull(rows.getString("owner_user_id"),
                    "V90's backfill never gave the pre-tier row an owner, and V126 must not invent one");
            assertFalse(rows.next(), "exactly one row for the legacy principal id");
        }
    }

    @Test
    void workspaceBindingsRoleBindingsAndGrantsSurviveVerbatim() throws SQLException {
        assertEquals(3, workspaceAgentsBefore,
                "fixture: every tier principal had a workspace binding");
        assertEquals(workspaceAgentsBefore, scalarInt(connection,
                        "SELECT count(*) FROM workspace_agents WHERE principal_id IN (" + TIER_PRINCIPALS + ")"),
                "workspace_agents rows are not deleted by V126");
        assertEquals(workspaceBindingsBefore, tierWorkspaceBindingSnapshot(),
                "workspace_agents rows (incl. permissions_snapshot) are unchanged by V126");
        assertEquals("read", workspaceBindingAtom(WORKSPACE_PRINCIPAL_ID));
        assertEquals("write", workspaceBindingAtom(INSTANCE_PRINCIPAL_ID));
        assertEquals(0, scalarInt(connection, "SELECT jsonb_array_length(permissions_snapshot)"
                + " FROM workspace_agents WHERE principal_id = '" + PERSONAL_PRINCIPAL_ID + "'"),
                "the empty ceiling of the personal binding is preserved as an empty array");

        assertEquals(3, roleBindingsBefore, "fixture: one role binding per tier principal");
        assertEquals(roleBindingsBefore, scalarInt(connection,
                        "SELECT count(*) FROM role_bindings WHERE subject_id IN (" + TIER_PRINCIPALS + ")"),
                "role_bindings rows are not deleted by V126");
        assertEquals(roleBindingSnapshotBefore, tierRoleBindingSnapshot(),
                "role_bindings rows (role/scope/granted_by/is_seed) are byte-for-byte unchanged by V126");
        assertRoleBindingSurvives(PERSONAL_BINDING_ID, SystemAccessRoleCatalog.AGENT_DELEGATOR_ID,
                "instance", null);
        assertRoleBindingSurvives(WORKSPACE_BINDING_ID, SystemAccessRoleCatalog.AGENT_DELEGATOR_ID,
                "workspace", WORKSPACE_ID);
        assertRoleBindingSurvives(INSTANCE_BINDING_ID, SystemAccessRoleCatalog.USER_ID, "instance", null);

        assertEquals(3, grantsBefore, "fixture: one grant per tier principal");
        // BL-345 (V129) legitimately materializes one extra MEMORY_WRITE_SELF grant for the USER-role
        // binding below; V126 itself deletes nothing, so the original rows must survive verbatim and
        // the total may only grow.
        assertTrue(scalarInt(connection,
                        "SELECT count(*) FROM grants WHERE subject_id IN (" + TIER_PRINCIPALS + ")")
                        >= grantsBefore,
                "grants rows are not deleted by V126 (V129 may add role grants)");
        assertGrantSurvives(PERSONAL_GRANT_ID, "read", "instance", null);
        assertGrantSurvives(WORKSPACE_GRANT_ID, "write", "workspace", WORKSPACE_ID);
        assertGrantSurvives(INSTANCE_GRANT_ID, "exec", "instance", null);

        assertEquals(1, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history"
                + " WHERE version = '126' AND success"), "V126 applied successfully on the upgrade side");
        assertEquals(1, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history"
                + " WHERE version = '127' AND success"), "V127 applied successfully on the upgrade side");
    }

    // ------------------------------------------------------------------ upgrade side: DDL removal

    @Test
    void upgradeDropsTheTierColumnBothChecksAndTheirIndexButKeepsTheOwnerColumn() throws SQLException {
        assertFalse(columnExists(connection, "agent_principals", "scope"),
                "the tier column is gone after V126");
        assertFalse(constraintExists(connection, "agent_principals", "ck_agent_principals_scope"),
                "the three-tier CHECK is gone");
        assertFalse(constraintExists(connection, "agent_principals", "ck_agent_principals_owner"),
                "the (scope, owner) coupling CHECK is gone");
        assertFalse(indexExists(connection, "agent_principals", "idx_agent_principals_scope_owner"),
                "the (scope, owner) index is gone");
        assertTrue(indexExists(connection, "agent_principals", "idx_agent_principals_owner"),
                "V126 replaces it with the owner-only index");

        assertTrue(columnExists(connection, "agent_principals", "owner_user_id"),
                "the owner column is NOT part of the tier removal");
        assertTrue(isNullable(connection, "agent_principals", "owner_user_id"));
        assertTrue(constraintExists(connection, "agent_principals", "fk_agent_principals_owner_user"),
                "the owner FK survives the removal");

        // Positive DB-level proof: owner coupling is no longer enforced — an owner without a tier,
        // and a tier-less ownerless row, are both accepted now (both were constrained at V125).
        UUID ownerOnly = UUID.randomUUID();
        UUID ownerless = UUID.randomUUID();
        execute(connection, "INSERT INTO agent_principals (id, name, created_by_user_id, owner_user_id)"
                + " VALUES ('" + ownerOnly + "', 'post-removal owned', '" + LEGACY_USER_ID + "', '"
                + LEGACY_USER_ID + "')");
        execute(connection, "INSERT INTO agent_principals (id, name, created_by_user_id)"
                + " VALUES ('" + ownerless + "', 'post-removal ownerless', '" + LEGACY_USER_ID + "')");
        assertEquals(2, scalarInt(connection, "SELECT count(*) FROM agent_principals WHERE id IN ('"
                + ownerOnly + "', '" + ownerless + "')"),
                "principals are inserted without any tier, with and without an owner");

        // Negative DB-level proof: the tier column is really gone (not merely unused) …
        SQLException noColumn = assertThrows(SQLException.class,
                () -> execute(connection, "INSERT INTO agent_principals (id, name, created_by_user_id, scope)"
                        + " VALUES ('" + UUID.randomUUID() + "', 'scope probe', '" + LEGACY_USER_ID
                        + "', 'PERSONAL')"),
                "no caller can send a tier payload any more: the column does not exist");
        assertTrue(noColumn.getMessage().contains("scope"),
                "the failure is the missing column, not something else: " + noColumn.getMessage());
        // … and the owner FK still rejects an unknown owner (V126 dropped the CHECKs, not the FK).
        SQLException unknownOwner = assertThrows(SQLException.class,
                () -> execute(connection, "INSERT INTO agent_principals (id, name, created_by_user_id,"
                        + " owner_user_id) VALUES ('" + UUID.randomUUID() + "', 'bad owner', '"
                        + LEGACY_USER_ID + "', '" + UUID.randomUUID() + "')"),
                "an unknown owner is still refused");
        assertTrue(unknownOwner.getMessage().contains("fk_agent_principals_owner_user"),
                "the owner FK is what refuses it: " + unknownOwner.getMessage());
    }

    // ------------------------------------------------------------------ fresh side

    @Test
    void freshHeadHasNoTierColumnAndNoTierCheck() throws SQLException {
        assertFalse(columnExists(freshConnection, "agent_principals", "scope"),
                "a fresh head schema has no scope column");
        assertFalse(constraintExists(freshConnection, "agent_principals", "ck_agent_principals_scope"),
                "a fresh head schema has no three-tier CHECK");
        assertFalse(constraintExists(freshConnection, "agent_principals", "ck_agent_principals_owner"),
                "a fresh head schema has no (scope, owner) CHECK");
        assertFalse(indexExists(freshConnection, "agent_principals", "idx_agent_principals_scope_owner"),
                "a fresh head schema has no (scope, owner) index");
        assertTrue(indexExists(freshConnection, "agent_principals", "idx_agent_principals_owner"),
                "the owner-only index exists on the fresh side");

        assertTrue(columnExists(freshConnection, "agent_principals", "owner_user_id"),
                "the owner column is not part of the removal");
        assertTrue(isNullable(freshConnection, "agent_principals", "owner_user_id"));
        assertTrue(constraintExists(freshConnection, "agent_principals", "fk_agent_principals_owner_user"),
                "the owner FK exists on the fresh side");

        // The absence above is a real end state: V90 (adds the column) and V126 (drops it) both ran.
        assertEquals(1, scalarInt(freshConnection, "SELECT count(*) FROM flyway_schema_history"
                + " WHERE version = '90' AND success"), "V90 ran on the fresh side");
        assertEquals(1, scalarInt(freshConnection, "SELECT count(*) FROM flyway_schema_history"
                + " WHERE version = '126' AND success"), "V126 ran on the fresh side");

        // No tier data is fabricated on the fresh side (that fixture exists only where the column
        // physically existed — the V125 replay on the upgrade side).
        assertEquals(0, scalarInt(freshConnection, "SELECT count(*) FROM agent_principals"),
                "fresh side fabricates no legacy tier data");
    }

    // ------------------------------------------------------------------ unchanged PLAN-0622 contract

    @Test
    void connectionLimitColumnsAreNullableSoUnconfiguredMeansUnlimited() throws SQLException {
        for (String column : new String[] {"max_inflight", "max_queue", "window_token_budget", "window_seconds"}) {
            assertTrue(columnExists(connection, "provider_connections", column),
                    "provider_connections." + column + " exists");
            assertTrue(isNullable(connection, "provider_connections", column),
                    column + " is nullable: an unconfigured limit means unlimited");
        }
    }

    @Test
    void modelLimitTableIsKeyedAndCascadesWithItsConnection() throws SQLException {
        UUID connectionId = UUID.randomUUID();
        execute(connection, "INSERT INTO provider_connections (id, owner_type, owner_id, provider_id, label,"
                + " connection_key, api_type_id, api_type_version) VALUES ('" + connectionId
                + "', 'USER', '" + LEGACY_USER_ID + "', 'openai', 'limit probe', 'limit-probe',"
                + " 'openai-chat-completions', 1)");
        execute(connection, "INSERT INTO provider_connection_model_limits (connection_id, provider, model,"
                + " max_inflight, window_token_budget, window_seconds) VALUES ('" + connectionId
                + "', 'openai', 'gpt-4o', 2, 100000, 60)");
        assertThrows(SQLException.class, () -> execute(connection, "INSERT INTO"
                        + " provider_connection_model_limits (connection_id, provider, model)"
                        + " VALUES ('" + connectionId + "', 'openai', 'gpt-4o')"),
                "the (connection, provider, model) primary key refuses a duplicate limit row");
        assertThrows(SQLException.class, () -> execute(connection, "INSERT INTO"
                        + " provider_connection_model_limits (connection_id, provider, model)"
                        + " VALUES ('" + UUID.randomUUID() + "', 'openai', 'x')"),
                "an unknown connection is refused by the foreign key");

        execute(connection, "DELETE FROM provider_connections WHERE id = '" + connectionId + "'");
        assertEquals(0, scalarInt(connection, "SELECT count(*) FROM provider_connection_model_limits"
                        + " WHERE connection_id = '" + connectionId + "'"),
                "deleting the connection cascades its model limits");
    }

    @Test
    void headSeedsMatchTheCodeSideCatalog() throws SQLException {
        // PLAN-0622 D8 (M0.3): V91 makes the PostgreSQL seed agree with the code catalog again.
        assertEquals(PermissionAtomCatalog.actionAtoms().size() + PermissionAtomCatalog.capabilityAtoms().size(),
                roleAtomCount(connection, SystemAccessRoleCatalog.SUPER_ADMIN_ID),
                "SUPER_ADMIN carries every action atom plus the capability atoms");
        // The per-role counts are derived from the code-side seeds: V91 is the SQL mirror of
        // SystemAccessRoleCatalog, so a hard-coded 10/6 would be the next thing to rot.
        assertEquals(seedAtomCount(SystemAccessRoleCatalog.ADMIN),
                roleAtomCount(connection, SystemAccessRoleCatalog.ADMIN_ID),
                "ADMIN seeds exactly the atoms of its code-side role definition "
                        + "(nine action atoms incl. CREATE_OWN_AGENT, plus instance:admin)");
        assertEquals(seedAtomCount(SystemAccessRoleCatalog.USER),
                roleAtomCount(connection, SystemAccessRoleCatalog.USER_ID),
                "USER seeds exactly the atoms of its code-side role definition "
                        + "(five registration atoms plus CREATE_OWN_AGENT)");
        for (UUID roleId : new UUID[] {SystemAccessRoleCatalog.SUPER_ADMIN_ID,
                SystemAccessRoleCatalog.ADMIN_ID, SystemAccessRoleCatalog.USER_ID}) {
            assertEquals(1, scalarInt(connection, "SELECT count(*) FROM role_permissions WHERE role_id = '"
                            + roleId + "'::uuid AND action_class = 'CREATE_OWN_AGENT'"),
                    "CREATE_OWN_AGENT is seeded on " + roleId);
        }
        // D-165 (Lead ruling 2026-11-05): A13 reuses N9 MANAGE_WORKSPACE_POLICY, so ADMIN keeps its
        // V115 N9 default.
        assertEquals(1, scalarInt(connection, "SELECT count(*) FROM role_permissions WHERE role_id = '"
                        + SystemAccessRoleCatalog.ADMIN_ID + "'::uuid"
                        + " AND action_class = 'MANAGE_WORKSPACE_POLICY'"),
                "ADMIN default set carries N9 (V115), the atom A13 now uses");
        // D-168 (user ruling 2026-11-05, migration V125): ADMIN gains MANAGE_ROLES — but only
        // together with the subset guard (PLAN-0673 M1), so it can never delegate beyond itself.
        assertEquals(1, scalarInt(connection, "SELECT count(*) FROM role_permissions WHERE role_id = '"
                        + SystemAccessRoleCatalog.ADMIN_ID + "'::uuid AND action_class = 'MANAGE_ROLES'"),
                "ADMIN holds MANAGE_ROLES since V125 (D-168)");
        // D-166: the subset bypass is SUPER_ADMIN-only; ADMIN must never hold it.
        assertEquals(1, scalarInt(connection, "SELECT count(*) FROM role_permissions WHERE role_id = '"
                        + SystemAccessRoleCatalog.SUPER_ADMIN_ID + "'::uuid"
                        + " AND action_class = 'GRANT_ANY_ATOM'"), "SUPER_ADMIN holds the bypass atom (V125)");
        assertEquals(0, scalarInt(connection, "SELECT count(*) FROM role_permissions WHERE role_id = '"
                        + SystemAccessRoleCatalog.ADMIN_ID + "'::uuid AND action_class = 'GRANT_ANY_ATOM'"),
                "ADMIN must not hold the subset bypass");
        // The migration itself is part of the fresh-database contract (V125 success).
        assertEquals(1, scalarInt(connection, "SELECT count(*) FROM flyway_schema_history"
                        + " WHERE version = '125' AND success"),
                "V125 (GRANT_ANY_ATOM + ADMIN MANAGE_ROLES) applied successfully");
    }

    @Test
    void v91BackfillsTheMaterializedOwnAgentAtomForExistingTierSubjects() throws SQLException {
        assertEquals(1, scalarInt(connection, "SELECT count(*) FROM grants WHERE subject_type = 'user'"
                        + " AND subject_id = '" + LEGACY_USER_ID + "' AND source = 'role'"
                        + " AND scope_type = 'instance' AND scope_id IS NULL"
                        + " AND permissions -> 0 ->> 'actionClass' = 'CREATE_OWN_AGENT'"),
                "the pre-existing tier subject gets exactly one materialized CREATE_OWN_AGENT row");
    }

    // ------------------------------------------------------------------ fixture: both legacy shapes

    /** V89 shape: users.role is gone, agent_principals has no scope column yet. */
    private static void seedV89Shape() throws SQLException {
        execute(connection, "INSERT INTO users (id, email, password_hash, username) VALUES ('"
                + LEGACY_USER_ID + "', 'legacy-" + LEGACY_USER_ID + "@test.local', 'x', 'legacy"
                + LEGACY_USER_ID.toString().substring(0, 8) + "')");
        execute(connection, "INSERT INTO agent_principals (id, name, created_by_user_id) VALUES ('"
                + LEGACY_PRINCIPAL_ID + "', 'legacy principal', '" + LEGACY_USER_ID + "')");
        // A V89-era instance tier binding: V91 must backfill its materialized CREATE_OWN_AGENT row,
        // otherwise existing accounts would keep the five-atom set until their next materialization.
        execute(connection, "INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                + " scope_id, granted_by) VALUES ('" + UUID.randomUUID() + "', '"
                + SystemAccessRoleCatalog.USER_ID + "', 'user', '" + LEGACY_USER_ID
                + "', 'instance', NULL, '" + LEGACY_USER_ID + "')");
    }

    /**
     * V125 shape: the tier column, its WORKSPACE default and both CHECKs are still in force. One
     * principal per legacy tier, each with a workspace binding, a role binding and a grant. Only
     * PERSONAL may carry an owner at V125 — V126 removes that coupling.
     */
    private static void seedLegacyTierFixture() throws SQLException {
        execute(connection, "INSERT INTO workspaces (id, name) VALUES ('" + WORKSPACE_ID
                + "', 'legacy tier workspace')");

        insertTierPrincipal(PERSONAL_PRINCIPAL_ID, "personal-tier-agent", "PERSONAL", LEGACY_USER_ID,
                "openai", "gpt-4o", "gpt-4o");
        insertTierPrincipal(WORKSPACE_PRINCIPAL_ID, "workspace-tier-agent", "WORKSPACE", null,
                "anthropic", "claude-sonnet-4", null);
        insertTierPrincipal(INSTANCE_PRINCIPAL_ID, "instance-tier-agent", "INSTANCE", null, null, null, null);

        insertWorkspaceBinding(PERSONAL_PRINCIPAL_ID, "[]");
        insertWorkspaceBinding(WORKSPACE_PRINCIPAL_ID, "[{\"actionClass\": \"read\"}]");
        insertWorkspaceBinding(INSTANCE_PRINCIPAL_ID, "[{\"actionClass\": \"write\"}]");

        insertRoleBinding(PERSONAL_BINDING_ID, PERSONAL_PRINCIPAL_ID,
                SystemAccessRoleCatalog.AGENT_DELEGATOR_ID, "instance", null);
        insertRoleBinding(WORKSPACE_BINDING_ID, WORKSPACE_PRINCIPAL_ID,
                SystemAccessRoleCatalog.AGENT_DELEGATOR_ID, "workspace", WORKSPACE_ID);
        insertRoleBinding(INSTANCE_BINDING_ID, INSTANCE_PRINCIPAL_ID, SystemAccessRoleCatalog.USER_ID,
                "instance", null);

        insertGrant(PERSONAL_GRANT_ID, PERSONAL_PRINCIPAL_ID, "read", "instance", null);
        insertGrant(WORKSPACE_GRANT_ID, WORKSPACE_PRINCIPAL_ID, "write", "workspace", WORKSPACE_ID);
        insertGrant(INSTANCE_GRANT_ID, INSTANCE_PRINCIPAL_ID, "exec", "instance", null);
    }

    /**
     * Preconditions: the V90 contract really is in force at V125. Without this the post-migration
     * assertions would be vacuous — they would compare against a column that never existed.
     */
    private static void assertLegacyTierContractIsInForceAtV125() throws SQLException {
        assertTrue(columnExists(connection, "agent_principals", "scope"),
                "precondition: V90's tier column exists before V126");
        assertEquals("WORKSPACE", columnDefault(connection, "agent_principals", "scope"),
                "precondition: scope defaults to WORKSPACE at V125");
        assertFalse(isNullable(connection, "agent_principals", "scope"),
                "precondition: scope is NOT NULL at V125");
        assertTrue(constraintExists(connection, "agent_principals", "ck_agent_principals_scope"),
                "precondition: the three-tier CHECK exists at V125");
        assertTrue(constraintExists(connection, "agent_principals", "ck_agent_principals_owner"),
                "precondition: the (scope, owner) CHECK exists at V125");
        assertTrue(indexExists(connection, "agent_principals", "idx_agent_principals_scope_owner"),
                "precondition: the (scope, owner) index exists at V125");

        assertEquals(3, countTierPrincipals(), "precondition: one legacy principal per tier was seeded");
        assertEquals(1, scalarInt(connection, "SELECT count(*) FROM agent_principals WHERE id = '"
                        + PERSONAL_PRINCIPAL_ID + "' AND scope = 'PERSONAL' AND owner_user_id = '"
                        + LEGACY_USER_ID + "'"),
                "precondition: the PERSONAL principal carries its owner at V125");
        assertEquals(2, scalarInt(connection, "SELECT count(*) FROM agent_principals WHERE id IN ('"
                        + WORKSPACE_PRINCIPAL_ID + "', '" + INSTANCE_PRINCIPAL_ID + "')"
                        + " AND owner_user_id IS NULL"),
                "precondition: WORKSPACE/INSTANCE carry no owner at V125");

        // The three illegal shapes the V90 CHECKs refused — asserted here so the removal below is
        // measured against a real database constraint, not against a comment in the migration.
        assertThrows(SQLException.class, () -> insertTierPrincipal(UUID.randomUUID(), "probe-personal-ownerless",
                        "PERSONAL", null, null, null, null),
                "precondition: PERSONAL without an owner violates ck_agent_principals_owner");
        assertThrows(SQLException.class, () -> insertTierPrincipal(UUID.randomUUID(), "probe-workspace-owned",
                        "WORKSPACE", LEGACY_USER_ID, null, null, null),
                "precondition: a non-personal tier with an owner violates ck_agent_principals_owner");
        assertThrows(SQLException.class, () -> insertTierPrincipal(UUID.randomUUID(), "probe-shared-tier",
                        "SHARED", null, null, null, null),
                "precondition: an unknown tier violates ck_agent_principals_scope");
    }

    private static void capturePreRemovalState() throws SQLException {
        principalsBefore = countTierPrincipals();
        workspaceAgentsBefore = scalarInt(connection,
                "SELECT count(*) FROM workspace_agents WHERE principal_id IN (" + TIER_PRINCIPALS + ")");
        roleBindingsBefore = scalarInt(connection,
                "SELECT count(*) FROM role_bindings WHERE subject_id IN (" + TIER_PRINCIPALS + ")");
        grantsBefore = scalarInt(connection,
                "SELECT count(*) FROM grants WHERE subject_id IN (" + TIER_PRINCIPALS + ")");
        workspaceBindingsBefore = tierWorkspaceBindingSnapshot();
        roleBindingSnapshotBefore = tierRoleBindingSnapshot();
        grantSnapshotBefore = tierGrantSnapshot();
    }

    // ------------------------------------------------------------------ assertions on the fixture

    private static void assertPrincipalSurvives(UUID id, String name, String owner, String provider,
            String model, String allowedModel) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT name, created_by_user_id, owner_user_id,"
                     + " default_model_provider, default_model_name, allowed_models -> 0 ->> 'model' AS allowed,"
                     + " origin FROM agent_principals WHERE id = '" + id + "'")) {
            assertTrue(rows.next(), "the legacy tier principal survives V126: " + name);
            assertEquals(name, rows.getString("name"));
            assertEquals(LEGACY_USER_ID.toString(), rows.getString("created_by_user_id"));
            assertEquals(owner, rows.getString("owner_user_id"),
                    "the owner relation is kept verbatim for " + name);
            assertEquals(provider, rows.getString("default_model_provider"));
            assertEquals(model, rows.getString("default_model_name"));
            assertEquals(allowedModel, rows.getString("allowed"));
            assertEquals("USER", rows.getString("origin"));
            assertFalse(rows.next(), "exactly one row per principal id: " + name);
        }
    }

    private static void assertRoleBindingSurvives(UUID id, UUID roleId, String scopeType, UUID scopeId)
            throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT role_id::text, scope_type, scope_id,"
                     + " granted_by::text, is_seed FROM role_bindings WHERE id = '" + id + "'")) {
            assertTrue(rows.next(), "the role binding survives V126: " + id);
            assertEquals(roleId.toString(), rows.getString("role_id"));
            assertEquals(scopeType, rows.getString("scope_type"),
                    "role_bindings.scope_type is not part of the tier removal");
            assertEquals(scopeId == null ? null : scopeId.toString(), rows.getString("scope_id"));
            assertEquals(LEGACY_USER_ID.toString(), rows.getString("granted_by"));
            assertFalse(rows.getBoolean("is_seed"), "the fixture binding was never a seed");
            assertFalse(rows.next(), "exactly one binding row: " + id);
        }
    }

    private static void assertGrantSurvives(UUID id, String atom, String scopeType, UUID scopeId)
            throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT source, scope_type, scope_id,"
                     + " permissions -> 0 ->> 'actionClass' AS atom FROM grants WHERE id = '" + id + "'")) {
            assertTrue(rows.next(), "the grant survives V126: " + id);
            assertEquals("template", rows.getString("source"));
            assertEquals(scopeType, rows.getString("scope_type"));
            assertEquals(scopeId == null ? null : scopeId.toString(), rows.getString("scope_id"));
            assertEquals(atom, rows.getString("atom"));
            assertFalse(rows.next(), "exactly one grant row: " + id);
        }
    }

    private static String workspaceBindingAtom(UUID principalId) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT permissions_snapshot -> 0 ->> 'actionClass'"
                     + " AS atom FROM workspace_agents WHERE principal_id = '" + principalId + "'")) {
            assertTrue(rows.next(), "workspace binding exists for " + principalId);
            return rows.getString("atom");
        }
    }

    private static int countTierPrincipals() throws SQLException {
        return scalarInt(connection,
                "SELECT count(*) FROM agent_principals WHERE id IN (" + TIER_PRINCIPALS + ")");
    }

    private static String tierWorkspaceBindingSnapshot() throws SQLException {
        return snapshot(connection, "SELECT principal_id::text || '|' || workspace_id::text || '|'"
                + " || permissions_snapshot::text FROM workspace_agents WHERE principal_id IN ("
                + TIER_PRINCIPALS + ") ORDER BY principal_id");
    }

    private static String tierRoleBindingSnapshot() throws SQLException {
        return snapshot(connection, "SELECT id::text || '|' || role_id::text || '|' || scope_type || '|'"
                + " || COALESCE(scope_id::text, '-') || '|' || COALESCE(granted_by::text, '-') || '|'"
                + " || is_seed::text FROM role_bindings WHERE subject_id IN (" + TIER_PRINCIPALS
                + ") ORDER BY id");
    }

    private static String tierGrantSnapshot() throws SQLException {
        return snapshot(connection, "SELECT id::text || '|' || subject_id::text || '|' || source || '|'"
                + " || scope_type || '|' || COALESCE(scope_id::text, '-') || '|' || permissions::text || '|'"
                + " || read_state FROM grants WHERE subject_id IN (" + TIER_PRINCIPALS + ") ORDER BY id");
    }

    // ------------------------------------------------------------------ fixture writers

    private static void insertTierPrincipal(UUID id, String name, String scope, UUID owner,
            String provider, String model, String allowedModel) throws SQLException {
        execute(connection, "INSERT INTO agent_principals (id, name, created_by_user_id, scope,"
                + " owner_user_id, default_model_provider, default_model_name, allowed_models) VALUES ('"
                + id + "', '" + name + "', '" + LEGACY_USER_ID + "', " + literal(scope) + ", "
                + literal(owner == null ? null : owner.toString()) + ", " + literal(provider) + ", "
                + literal(model) + ", "
                + (allowedModel == null ? "NULL" : "'[{\"model\": \"" + allowedModel + "\"}]'::jsonb") + ")");
    }

    private static void insertWorkspaceBinding(UUID principalId, String permissions) throws SQLException {
        execute(connection, "INSERT INTO workspace_agents (principal_id, workspace_id, permissions_snapshot)"
                + " VALUES ('" + principalId + "', '" + WORKSPACE_ID + "', '" + permissions + "'::jsonb)");
    }

    private static void insertRoleBinding(UUID id, UUID principalId, UUID roleId, String scopeType,
            UUID scopeId) throws SQLException {
        execute(connection, "INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                + " scope_id, granted_by, is_seed) VALUES ('" + id + "', '" + roleId
                + "', 'agent_principal', '" + principalId + "', " + literal(scopeType) + ", "
                + literal(scopeId == null ? null : scopeId.toString()) + ", '" + LEGACY_USER_ID
                + "', FALSE)");
    }

    private static void insertGrant(UUID id, UUID principalId, String atom, String scopeType, UUID scopeId)
            throws SQLException {
        // `template` is the non-role source that survives V88's narrowed allow-list
        // ('role','spawn','template','credential_binding','agent_default') and is untouched by V127.
        execute(connection, "INSERT INTO grants (id, subject_type, subject_id, permissions, source,"
                + " scope_type, scope_id, read_state) VALUES ('" + id + "', 'agent_principal', '"
                + principalId + "', '[{\"actionClass\": \"" + atom + "\"}]'::jsonb, 'template', "
                + literal(scopeType) + ", " + literal(scopeId == null ? null : scopeId.toString())
                + ", 'unread')");
    }

    // ------------------------------------------------------------------ engine + SQL helpers

    private static void migrate(TestDatabaseProvider.DatabaseRef database, String target) {
        var configuration = Flyway.configure()
                .dataSource(database.jdbcUrl(), database.username(), database.password())
                .locations("classpath:db/migration");
        if (target != null) {
            configuration = configuration.target(MigrationVersion.fromVersion(target));
        }
        configuration.load().migrate();
    }

    private static Connection open(TestDatabaseProvider.DatabaseRef database) throws SQLException {
        return DriverManager.getConnection(database.jdbcUrl(), database.username(), database.password());
    }

    private static String literal(String value) {
        return value == null ? "NULL" : "'" + value + "'";
    }

    private static void execute(Connection target, String sql) throws SQLException {
        try (Statement statement = target.createStatement()) {
            statement.execute(sql);
        }
    }

    /** Single-column concatenated rows, used for the before/after "unchanged" comparisons. */
    private static String snapshot(Connection target, String sql) throws SQLException {
        StringBuilder rows = new StringBuilder();
        try (Statement statement = target.createStatement();
             ResultSet result = statement.executeQuery(sql)) {
            while (result.next()) {
                rows.append(result.getString(1)).append('\n');
            }
        }
        return rows.toString();
    }

    private static int scalarInt(Connection target, String sql) throws SQLException {
        try (Statement statement = target.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            assertTrue(rows.next(), "scalar query returns a row: " + sql);
            return rows.getInt(1);
        }
    }

    private static int roleAtomCount(Connection target, UUID roleId) throws SQLException {
        return scalarInt(target, "SELECT count(*) FROM role_permissions WHERE role_id = '" + roleId + "'::uuid");
    }

    /** All atoms of one seeded system role, per the code-side catalog (V91 mirrors it). */
    private static long seedAtomCount(String roleName) {
        return SystemAccessRoleCatalog.roleSeeds().stream()
                .filter(seed -> roleName.equals(seed.name()))
                .findFirst()
                .orElseThrow()
                .atoms().size();
    }

    private static boolean columnExists(Connection target, String table, String column) throws SQLException {
        return columnInfo(target, table, column, "column_name") != null;
    }

    private static boolean isNullable(Connection target, String table, String column) throws SQLException {
        return "YES".equals(columnInfo(target, table, column, "is_nullable"));
    }

    private static String columnDefault(Connection target, String table, String column) throws SQLException {
        String value = columnInfo(target, table, column, "column_default");
        return value == null ? null : value.replace("'", "").replace("::character varying", "");
    }

    private static String columnInfo(Connection target, String table, String column, String field)
            throws SQLException {
        String sql = "SELECT " + field + " FROM information_schema.columns WHERE table_name = '" + table
                + "' AND column_name = '" + column + "'";
        try (Statement statement = target.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            return rows.next() ? rows.getString(1) : null;
        }
    }

    private static boolean constraintExists(Connection target, String table, String constraint)
            throws SQLException {
        return scalarInt(target, "SELECT count(*) FROM pg_constraint WHERE conrelid = '" + table
                + "'::regclass AND conname = '" + constraint + "'") > 0;
    }

    private static boolean indexExists(Connection target, String table, String index) throws SQLException {
        return scalarInt(target, "SELECT count(*) FROM pg_indexes WHERE tablename = '" + table
                + "' AND indexname = '" + index + "'") > 0;
    }
}
