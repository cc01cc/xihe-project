package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;

/**
 * V19 evidence support: one isolated PostgreSQL database replayed through the real migration path
 * up to the V125 three-tier shape, then to head (V126).
 *
 * <p>The behaviour test needs a database where <b>legacy rows physically predate V126</b> — the
 * normal {@code AbstractIntegrationTest} template is already at head and has no legacy tier data.
 * This fixture is deliberately test-only and mirrors the upgrade half of
 * {@link AgentPrincipalScopeMigrationTest}; it does not duplicate that class's assertions, it makes
 * the same pre-migration state reusable by an HTTP/Spring test.</p>
 *
 * <p>Sequence (must stay in this order):
 * empty DB → Flyway V89 → seed V89 shape → Flyway V125 → seed three legacy tier principals and their
 * surviving rows → assert the V125 contract is really in force → <b>clean those pre-V170 rows</b> →
 * Flyway head → re-create the same subjects at head. The Spring context then starts against this
 * database.</p>
 *
 * <p>task-173 (V170, user ruling 40C / D-1533): the clean-then-re-create step is new. V170 refuses to
 * classify rows written before it (both creation doors wrote origin='USER' with owner NULL, so their
 * ownership cannot be determined and the ruling forbids guessing), which means a V125-shaped database
 * is no longer migratable to head. The fixture follows the documented upgrade route (DEV-002 §8.3) and
 * re-establishes the same rows with the ownership the ruling assigns, so the behaviour tests keep
 * exercising owner-less, tier-less subjects with their legacy bindings.</p>
 */
public final class AgentPrincipalScopeUpgradeFixture {

    /** The V89-shaped user; it owns the PERSONAL-tier principal below. */
    public static final UUID LEGACY_USER_ID = UUID.randomUUID();
    /** A pre-tier principal created before the scope column existed. */
    public static final UUID LEGACY_PRINCIPAL_ID = UUID.randomUUID();
    /** The legacy workspace all three tier principals were bound to. */
    public static final UUID WORKSPACE_ID = UUID.randomUUID();
    /** Three principals whose {@code scope} values were PERSONAL / WORKSPACE / INSTANCE at V125. */
    public static final UUID PERSONAL_PRINCIPAL_ID = UUID.randomUUID();
    public static final UUID WORKSPACE_PRINCIPAL_ID = UUID.randomUUID();
    public static final UUID INSTANCE_PRINCIPAL_ID = UUID.randomUUID();

    /**
     * The legacy workspace principal's pre-upgrade role. It deliberately contains the seven atoms
     * the old workspace snapshot carried: the materializer re-runs on the first cap write, and a
     * role whose atoms do not cover that snapshot would make the cap depend on test order.
     */
    private static final UUID LEGACY_WORKSPACE_ROLE_ID = UUID.randomUUID();

    private static final Object LOCK = new Object();
    private static TestDatabaseProvider.DatabaseRef database;

    private AgentPrincipalScopeUpgradeFixture() {
    }

    /** Bootstraps once per JVM and returns the database the Spring context should use. */
    public static TestDatabaseProvider.DatabaseRef database() {
        synchronized (LOCK) {
            if (database == null) {
                database = replay();
            }
            return database;
        }
    }

    private static TestDatabaseProvider.DatabaseRef replay() {
        TestDatabaseProvider.DatabaseRef target = TestDatabaseProvider.emptyDatabase("agent_principa_v19");
        migrate(target, "89");
        try (Connection connection = open(target)) {
            seedV89Shape(connection);
            migrate(target, "125");
            seedLegacyTierFixture(connection);
            assertV125Contract(connection);
            // task-173 (V170, user ruling 40C / D-1533): a V125-shaped database is no longer migratable
            // to head. The ownership of rows written before V170 cannot be determined (both doors wrote
            // origin='USER' with owner NULL), and the ruling forbids guessing, so V170 refuses. The
            // fixture therefore takes the documented upgrade route itself — clean first, then migrate
            // (DEV-002 §8.3) — and re-creates the same subjects at head with the ownership the ruling
            // assigns (USER: these are user/workspace rows, never platform agents). What the behaviour
            // tests exercise is unchanged: owner-less, tier-less rows with their legacy bindings.
            cleanLegacyPrincipals(connection);
        } catch (SQLException failure) {
            throw new IllegalStateException("V19 upgrade fixture failed to seed the V125 shape", failure);
        }
        migrate(target, null);
        try (Connection connection = open(target)) {
            seedLegacyTierFixtureAtHead(connection);
        } catch (SQLException failure) {
            throw new IllegalStateException("V19 upgrade fixture failed to re-seed the head shape", failure);
        }
        return target;
    }

    private static void seedV89Shape(Connection connection) throws SQLException {
        execute(connection, "INSERT INTO users (id, email, password_hash, username) VALUES ('"
                + LEGACY_USER_ID + "', 'v19-legacy-" + LEGACY_USER_ID + "@test.local', 'x', 'v19legacy"
                + LEGACY_USER_ID.toString().substring(0, 8) + "')");
        execute(connection, "INSERT INTO agent_principals (id, name, created_by_user_id) VALUES ('"
                + LEGACY_PRINCIPAL_ID + "', 'v19 legacy principal', '" + LEGACY_USER_ID + "')");
        // A pre-existing instance role for the legacy user: the same V89 seed shape the migration
        // test uses, so the account is a real actor after the replay.
        execute(connection, "INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                + " scope_id, granted_by) VALUES ('" + UUID.randomUUID() + "', '"
                + SystemAccessRoleCatalog.USER_ID + "', 'user', '" + LEGACY_USER_ID
                + "', 'instance', NULL, '" + LEGACY_USER_ID + "')");
    }

    private static void seedLegacyTierFixture(Connection connection) throws SQLException {
        execute(connection, "INSERT INTO workspaces (id, name, storage_mode, host_path, execution_mode)"
                + " VALUES ('" + WORKSPACE_ID + "', 'v19 legacy workspace', 'direct_attach',"
                + " 'C:/v19-legacy-workspace', 'windows-host')");
        insertTierPrincipal(connection, PERSONAL_PRINCIPAL_ID, "v19 personal-tier-agent", "PERSONAL",
                LEGACY_USER_ID);
        insertTierPrincipal(connection, WORKSPACE_PRINCIPAL_ID, "v19 workspace-tier-agent", "WORKSPACE", null);
        insertTierPrincipal(connection, INSTANCE_PRINCIPAL_ID, "v19 instance-tier-agent", "INSTANCE", null);
        // The legacy role is schema-independent (V170 does not touch roles), so it is seeded once here
        // and reused by the head-side re-seed; creating it twice would be a primary-key collision.
        seedLegacyWorkspaceRole(connection);
        insertTierBindingsAndGrants(connection);
    }

    /**
     * task-173 (V170): the same subjects re-created at head, after the documented clean-then-migrate
     * route. Only the ownership column is new; every behaviour those tests exercise (owner-less rows,
     * legacy bindings, the frozen cap snapshot) is identical — the app cannot tell the rows were
     * re-created, which is exactly why the fixture may do it (D-1533 only forbids *guessing* the
     * ownership of old rows, not re-establishing a test fixture).
     */
    private static void seedLegacyTierFixtureAtHead(Connection connection) throws SQLException {
        execute(connection, "INSERT INTO agent_principals (id, name, created_by_user_id, ownership)"
                + " VALUES ('" + LEGACY_PRINCIPAL_ID + "', 'v19 legacy principal', '"
                + LEGACY_USER_ID + "', 'USER')");
        insertTierPrincipalAtHead(connection, PERSONAL_PRINCIPAL_ID, "v19 personal-tier-agent", LEGACY_USER_ID);
        insertTierPrincipalAtHead(connection, WORKSPACE_PRINCIPAL_ID, "v19 workspace-tier-agent", null);
        insertTierPrincipalAtHead(connection, INSTANCE_PRINCIPAL_ID, "v19 instance-tier-agent", null);
        insertTierBindingsAndGrants(connection);
    }

    private static void insertTierBindingsAndGrants(Connection connection) throws SQLException {
        insertWorkspaceBinding(connection, PERSONAL_PRINCIPAL_ID, "[]");
        // PLAN-0691 T1.3 (V137) added PLUGIN_INVOKE to the base set of every non-viewer role and
        // deliberately did NOT backfill existing grants ("existing bindings keep the atoms they were
        // materialized with until they are re-bound"). The fixture therefore seeds the workspace
        // agent's cap snapshot and role set from the *current* base set: the upgrade-behaviour tests
        // assert what a re-bound agent may do, and an agent still holding the pre-V137 snapshot is
        // (correctly) refused by the cap gate — that refusal has its own coverage elsewhere.
        // task-229 / PLAN-0773 (V157) added the two workspace write faces to WS_OWNER + WS_EDITOR,
        // so the "current set" this cap mirrors grew by exactly those two atoms. Without them the
        // WS_EDITOR binding below would answer 409 ROLE_BINDING_EXCEEDS_CAP and the behaviour tests
        // would be asserting the upgrade path through a cap nobody could satisfy.
        insertWorkspaceBinding(connection, WORKSPACE_PRINCIPAL_ID,
                "[{\"actionClass\": \"read\"}, {\"actionClass\": \"write\"},"
                        + " {\"actionClass\": \"delete\"}, {\"actionClass\": \"exec\"},"
                        + " {\"actionClass\": \"MANAGE_PROVIDER_CONNECTIONS\"},"
                        + " {\"actionClass\": \"MANAGE_WORKSPACE_POLICY\"},"
                        + " {\"actionClass\": \"USE_WORKSPACE_RUNTIME\"},"
                        + " {\"actionClass\": \"PLUGIN_INVOKE\"},"
                        + " {\"actionClass\": \"WRITE_WORKSPACE_CONTENT\"},"
                        + " {\"actionClass\": \"MANAGE_WORKSPACE_MCP\"}]");
        insertWorkspaceBinding(connection, INSTANCE_PRINCIPAL_ID, "[{\"actionClass\": \"write\"}]");

        insertRoleBinding(connection, PERSONAL_PRINCIPAL_ID, SystemAccessRoleCatalog.AGENT_DELEGATOR_ID,
                "instance", null);
        insertRoleBinding(connection, WORKSPACE_PRINCIPAL_ID, LEGACY_WORKSPACE_ROLE_ID,
                "workspace", WORKSPACE_ID);
        insertRoleBinding(connection, INSTANCE_PRINCIPAL_ID, SystemAccessRoleCatalog.USER_ID,
                "instance", null);

        insertGrant(connection, PERSONAL_PRINCIPAL_ID, "read", "instance", null, "template");
        // The two task-229 atoms are part of this set as well, and that is not the cap snapshot
        // leaking into the grants: resolveCapFor() returns retainCovered(snapshot, principal atoms)
        // (AgentPrincipalService.java:739), so an atom the principal does not hold is dropped
        // from its own cap — a snapshot alone would still answer 409. On a real upgrade database
        // V157 backfilled exactly these rows onto every existing WS_OWNER/WS_EDITOR binding, which
        // is the state this loop mirrors.
        for (String atom : new String[]{"read", "write", "delete", "exec", "MANAGE_PROVIDER_CONNECTIONS",
                "MANAGE_WORKSPACE_POLICY", "USE_WORKSPACE_RUNTIME", "PLUGIN_INVOKE",
                "WRITE_WORKSPACE_CONTENT", "MANAGE_WORKSPACE_MCP"}) {
            // `role` is the authoritative source (2026-11-04 ruling). Seeding it keeps the fixture
            // deterministic even after another test triggers the role materializer: a principal with
            // role rows no longer falls back to its legacy template snapshot.
            insertGrant(connection, WORKSPACE_PRINCIPAL_ID, atom, "workspace", WORKSPACE_ID, "role");
        }
        insertGrant(connection, INSTANCE_PRINCIPAL_ID, "exec", "instance", null, "template");
    }

    /**
     * A pre-upgrade role whose action set equals the legacy workspace snapshot. Seeding only the
     * snapshot is not enough: a later cap write re-materializes role grants, and with an
     * unrelated role (e.g. AGENT_DELEGATOR's SPAWN_AGENT) the materializer would delete them and
     * leave the cap empty. This role keeps the fixture order-independent.
     *
     * <p>Its set must stay equal to the snapshot above, which is why it carries the two task-229
     * atoms too: the role is a stand-in for "the workspace role the agent currently holds", and
     * V157 backfilled both atoms onto existing WS_OWNER/WS_EDITOR bindings (V157:62-80). A role
     * without them would make a cap write silently shrink the cap by two atoms.</p>
     */
    private static void seedLegacyWorkspaceRole(Connection connection) throws SQLException {
        execute(connection, "INSERT INTO roles (id, name, display_name, description, is_system)"
                + " VALUES ('" + LEGACY_WORKSPACE_ROLE_ID + "', 'V19_LEGACY_WORKSPACE',"
                + " 'V19 legacy workspace', 'fixture-only pre-upgrade workspace role', FALSE)");
        for (String atom : new String[]{"read", "write", "delete", "exec", "MANAGE_PROVIDER_CONNECTIONS",
                "MANAGE_WORKSPACE_POLICY", "USE_WORKSPACE_RUNTIME", "PLUGIN_INVOKE",
                "WRITE_WORKSPACE_CONTENT", "MANAGE_WORKSPACE_MCP"}) {
            execute(connection, "INSERT INTO role_permissions (role_id, action_class, resource_pattern)"
                    + " VALUES ('" + LEGACY_WORKSPACE_ROLE_ID + "', '" + atom + "', '*')");
        }
    }

    /**
     * Without this the post-V126 assertions would be vacuous: it proves the column/default/CHECKs
     * existed at V125 and therefore that V126 really removed them.
     */
    private static void assertV125Contract(Connection connection) throws SQLException {
        if (!columnExists(connection, "scope")) {
            throw new IllegalStateException("precondition: scope column missing at V125");
        }
        if (!constraintExists(connection, "ck_agent_principals_scope")
                || !constraintExists(connection, "ck_agent_principals_owner")) {
            throw new IllegalStateException("precondition: V125 tier CHECKs missing");
        }
        if (scalarInt(connection, "SELECT count(*) FROM agent_principals WHERE id IN ('"
                + PERSONAL_PRINCIPAL_ID + "', '" + WORKSPACE_PRINCIPAL_ID + "', '"
                + INSTANCE_PRINCIPAL_ID + "')") != 3) {
            throw new IllegalStateException("precondition: three legacy tier principals were not seeded");
        }
    }

    private static void insertTierPrincipal(Connection connection, UUID id, String name, String scope,
            UUID owner) throws SQLException {
        execute(connection, "INSERT INTO agent_principals (id, name, created_by_user_id, scope,"
                + " owner_user_id) VALUES ('" + id + "', '" + name + "', '" + LEGACY_USER_ID + "', '"
                + scope + "', " + literal(owner) + ")");
    }

    /**
     * The head-shaped row: no {@code scope} (V126 dropped it) but the V170 ownership column, which has
     * no default precisely so a forgotten write fails instead of silently picking a side.
     */
    private static void insertTierPrincipalAtHead(Connection connection, UUID id, String name, UUID owner)
            throws SQLException {
        execute(connection, "INSERT INTO agent_principals (id, name, created_by_user_id, owner_user_id,"
                + " ownership) VALUES ('" + id + "', '" + name + "', '" + LEGACY_USER_ID + "', "
                + literal(owner) + ", 'USER')");
    }

    /**
     * The cleanup V170's refusal message prescribes (FK order: binding rows first, then the subjects).
     * Keeping it in the fixture — rather than special-casing the migration — is what makes the fixture
     * follow the documented upgrade route instead of pretending old rows were classifiable.
     */
    private static void cleanLegacyPrincipals(Connection connection) throws SQLException {
        String ids = "'" + LEGACY_PRINCIPAL_ID + "', '" + PERSONAL_PRINCIPAL_ID + "', '"
                + WORKSPACE_PRINCIPAL_ID + "', '" + INSTANCE_PRINCIPAL_ID + "'";
        execute(connection, "DELETE FROM workspace_agents WHERE principal_id IN (" + ids + ")");
        execute(connection, "DELETE FROM role_bindings WHERE subject_type = 'agent_principal'"
                + " AND subject_id IN (" + ids + ")");
        execute(connection, "DELETE FROM grants WHERE subject_type = 'agent_principal'"
                + " AND subject_id IN (" + ids + ")");
        execute(connection, "DELETE FROM agent_principals WHERE id IN (" + ids + ")");
    }

    private static void insertWorkspaceBinding(Connection connection, UUID principalId, String permissions)
            throws SQLException {
        execute(connection, "INSERT INTO workspace_agents (principal_id, workspace_id, permissions_snapshot)"
                + " VALUES ('" + principalId + "', '" + WORKSPACE_ID + "', '" + permissions + "'::jsonb)");
    }

    private static void insertRoleBinding(Connection connection, UUID principalId, UUID roleId,
            String scopeType, UUID scopeId) throws SQLException {
        execute(connection, "INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                + " scope_id, granted_by, is_seed) VALUES ('" + UUID.randomUUID() + "', '" + roleId
                + "', 'agent_principal', '" + principalId + "', '" + scopeType + "', "
                + literal(scopeId) + ", '" + LEGACY_USER_ID + "', FALSE)");
    }

    private static void insertGrant(Connection connection, UUID principalId, String atom, String scopeType,
            UUID scopeId, String source) throws SQLException {
        execute(connection, "INSERT INTO grants (id, subject_type, subject_id, permissions, source,"
                + " scope_type, scope_id, read_state) VALUES ('" + UUID.randomUUID() + "',"
                + " 'agent_principal', '" + principalId + "', '[{\"actionClass\": \"" + atom
                + "\"}]'::jsonb, '" + source + "', '" + scopeType + "', " + literal(scopeId)
                + ", 'unread')");
    }

    private static void migrate(TestDatabaseProvider.DatabaseRef target, String version) {
        var configuration = Flyway.configure()
                .dataSource(target.jdbcUrl(), target.username(), target.password())
                .locations("classpath:db/migration");
        if (version != null) {
            configuration = configuration.target(MigrationVersion.fromVersion(version));
        }
        configuration.load().migrate();
    }

    private static Connection open(TestDatabaseProvider.DatabaseRef target) throws SQLException {
        return DriverManager.getConnection(target.jdbcUrl(), target.username(), target.password());
    }

    private static String literal(UUID value) {
        return value == null ? "NULL" : "'" + value + "'";
    }

    private static void execute(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    private static boolean columnExists(Connection connection, String column) throws SQLException {
        return scalarInt(connection, "SELECT count(*) FROM information_schema.columns WHERE table_name ="
                + " 'agent_principals' AND column_name = '" + column + "'") > 0;
    }

    private static boolean constraintExists(Connection connection, String constraint) throws SQLException {
        return scalarInt(connection, "SELECT count(*) FROM pg_constraint WHERE conrelid ="
                + " 'agent_principals'::regclass AND conname = '" + constraint + "'") > 0;
    }

    private static int scalarInt(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             var rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getInt(1);
        }
    }
}
