package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
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
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0610 W1a: V87 (dynamic access roles + scoped grants) on an empty database.
 *
 * <p>Covers T1.1 (three tables, scope columns, source allow-list, per-source partial uniqueness),
 * T1.2 (built-in role catalog) and the round-2 corrections: the widened source allow-list (P0),
 * {@code agent_default} (P1-1), the scope CHECK + workspace cascade + per-source uniqueness
 * (P1-2) and the 18/9/5/6/4/1 atom counts of the seeded catalog (P1-3).</p>
 */
class DynamicAccessRoleMigrationTest {
    /** PLAN-eff/task-13 M1（A1）：空库由 JVM 单例容器下发；本类仍自行 Flyway 到目标版本。 */
    static TestDatabaseProvider.DatabaseRef postgres = TestDatabaseProvider.emptyDatabase("dynamic_access");

    private static Connection connection;

    @BeforeAll
    static void applyMigrationsOnFreshDatabase() throws SQLException {
        // PLAN-0610 W2: V87 is the intermediate shape of the one-shot window; its guarantees
        // (legacy sources still writable, V38/V65 fences still present) only hold before V88.
        // Pin this class to the V87 target; V88's end-state is asserted by
        // AccessRoleDataBackfillMigrationTest.
        Flyway.configure()
                .dataSource(postgres.jdbcUrl(), postgres.username(), postgres.password())
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("87"))
                .load()
                .migrate();
        connection = DriverManager.getConnection(
                postgres.jdbcUrl(), postgres.username(), postgres.password());
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

    private static Set<String> codeAtomsOf(SystemAccessRoleCatalog.RoleSeed seed) {
        Set<String> atoms = new HashSet<>();
        for (SystemAccessRoleCatalog.AtomRef atom : seed.atoms()) {
            atoms.add(atom.actionClass() + "@" + atom.resourcePattern());
        }
        return atoms;
    }

    private static Set<String> v87AtomsOf(UUID roleId) throws SQLException {
        Set<String> atoms = new HashSet<>();
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery("SELECT action_class, resource_pattern"
                     + " FROM role_permissions WHERE role_id = '" + roleId + "'::uuid")) {
            while (rs.next()) {
                atoms.add(rs.getString(1) + "@" + rs.getString(2));
            }
        }
        return atoms;
    }

    /**
     * A V87 seed row that a later migration withdrew on purpose. V87 is history and cannot be edited
     * (Flyway checksums the whole file), so the one-directional guard below has to be told which
     * rows a later migration deleted — with the migration name, the commit and the reason, so the
     * entry can be re-checked instead of silently outliving its justification.
     */
    private record RetiredSeed(UUID roleId, String roleName, String atom, String withdrawnBy,
            String commit, String reason) {
    }

    /**
     * task-201: the only entries here are V87 rows that a later migration removes at head. Every
     * entry must still describe a real V87 row ({@code everyRetiredSeedEntryStillDescribesAV87Row})
     * and must not widen into a blanket exemption ({@code retiredSeedsDoNotSwallowUnknownAtoms}).
     */
    private static final List<RetiredSeed> RETIRED_V87_SEEDS = List.of(
            new RetiredSeed(SystemAccessRoleCatalog.WS_EDITOR_ID, SystemAccessRoleCatalog.WS_EDITOR,
                    "exec@*",
                    "V179__dsd1500_agent_exec_retirement_and_presets.sql",
                    "bf5cb083d",
                    "DSD-1500 (Q-93) R2 withdrew exec from the editor default; V179 deletes the"
                            + " V87 seed row at head"));

    private static Set<String> allowedAtoms(UUID roleId, Set<String> codeAtoms) {
        Set<String> allowed = new HashSet<>(codeAtoms);
        for (RetiredSeed retired : RETIRED_V87_SEEDS) {
            if (retired.roleId().equals(roleId)) {
                allowed.add(retired.atom());
            }
        }
        return allowed;
    }

    /**
     * V87 rows the head code catalog no longer knows, minus the ones a later migration withdrew on
     * purpose. A non-empty result is a real regression: V87 seeded an atom nobody ever retired.
     */
    private static Set<String> unexplainedAtoms(UUID roleId, Set<String> codeAtoms,
            Set<String> dbAtoms) {
        Set<String> unexplained = new HashSet<>(dbAtoms);
        unexplained.removeAll(allowedAtoms(roleId, codeAtoms));
        return unexplained;
    }

    private static UUID createUser() throws SQLException {
        UUID userId = UUID.randomUUID();
        executeUpdate("INSERT INTO users (id, email, password_hash, username) VALUES ('" + userId
                + "'::uuid, 'v87-" + userId + "@test.local', 'hash', 'x' || left(md5(random()::text), 31))");
        return userId;
    }

    private static void insertGrant(String source, String subjectType, UUID subjectId,
                                    String actionClass, String scopeType, UUID scopeId) throws SQLException {
        String resource = ("credential_use".equals(actionClass)) ? ",\"resource\":\"credential:*\"" : "";
        String atom = "{\"actionClass\":\"" + actionClass + "\"" + resource + "}";
        executeUpdate("INSERT INTO grants (id, subject_type, subject_id, permissions, source, "
                + "scope_type, scope_id) VALUES ('" + UUID.randomUUID() + "'::uuid, '" + subjectType
                + "', '" + subjectId + "'::uuid, CAST('[" + atom + "]' AS JSONB), '" + source + "', '"
                + scopeType + "', " + (scopeId == null ? "NULL" : "'" + scopeId + "'::uuid") + ")");
    }

    // ---------------------------------------------------------------------
    // T1.1 schema
    // ---------------------------------------------------------------------

    @Test
    void v87CreatesTheThreeAccessRoleTables() throws SQLException {
        assertEquals(1, scalarInt("SELECT count(*) FROM flyway_schema_history "
                + "WHERE version = '87' AND success = true"), "V87 must be recorded as applied");
        for (String table : new String[]{"roles", "role_permissions", "role_bindings"}) {
            assertNotNull(scalarString("SELECT to_regclass('public." + table + "')"),
                    "missing table: " + table);
        }
        assertEquals("uuid", scalarString("SELECT data_type FROM information_schema.columns "
                + "WHERE table_schema = 'public' AND table_name = 'roles' AND column_name = 'id'"));
        assertEquals("boolean", scalarString("SELECT data_type FROM information_schema.columns "
                + "WHERE table_schema = 'public' AND table_name = 'roles' AND column_name = 'is_system'"));
        assertEquals("NO", scalarString("SELECT is_nullable FROM information_schema.columns "
                + "WHERE table_schema = 'public' AND table_name = 'roles' AND column_name = 'name'"));
        assertEquals(1, scalarInt("SELECT count(*) FROM pg_constraint "
                + "WHERE conname = 'ck_roles_name_format' AND contype = 'c'"),
                "role names are upper snake case (design §3.1)");
    }

    @Test
    void v87AddsScopedColumnsAndScopeGuardsToGrants() throws SQLException {
        assertEquals("character varying", scalarString("SELECT data_type FROM information_schema.columns "
                + "WHERE table_schema = 'public' AND table_name = 'grants' AND column_name = 'scope_type'"));
        assertEquals(24, scalarInt("SELECT character_maximum_length FROM information_schema.columns "
                + "WHERE table_schema = 'public' AND table_name = 'grants' AND column_name = 'source'"),
                "the longest new source is credential_binding (18)");
        assertEquals("NO", scalarString("SELECT is_nullable FROM information_schema.columns "
                + "WHERE table_schema = 'public' AND table_name = 'grants' AND column_name = 'scope_type'"));
        assertEquals("'instance'::character varying", scalarString(
                "SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' "
                        + "AND table_name = 'grants' AND column_name = 'scope_type'"));
        assertEquals(1, scalarInt("SELECT count(*) FROM pg_constraint "
                + "WHERE conname = 'ck_grants_scope' AND contype = 'c'"),
                "scope_type/scope_id must be consistent");
        assertEquals("c", scalarString("SELECT confdeltype FROM pg_constraint "
                + "WHERE conname = 'fk_grants_scope_workspace' AND contype = 'f'"),
                "deleting a workspace must cascade to its scoped materialized rows");

        UUID userId = createUser();
        UUID workspaceId = UUID.randomUUID();
        executeUpdate("INSERT INTO workspaces (id, name, owner_id) VALUES ('" + workspaceId
                + "'::uuid, 'v87-ws', '" + userId + "'::uuid)");

        assertThrows(SQLException.class, () -> insertGrant("role", "user", userId, "read", "workspace", null),
                "a workspace scope without a scope id must be rejected");

        insertGrant("role", "user", userId, "read", "workspace", workspaceId);
        assertEquals(1, scalarInt("SELECT count(*) FROM grants WHERE scope_id = '"
                + workspaceId + "'::uuid"));
        executeUpdate("DELETE FROM workspaces WHERE id = '" + workspaceId + "'::uuid");
        assertEquals(0, scalarInt("SELECT count(*) FROM grants WHERE subject_id = '"
                + userId + "'::uuid"), "workspace-scoped materialized rows cascade with the workspace");
    }

    @Test
    void v87KeepsLegacySourcesAndAddsTheNewOnesRound2P0() throws SQLException {
        String definition = scalarString("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                + "WHERE conname = 'ck_grants_source'");
        for (String source : new String[]{"default", "direct", "role", "spawn", "template",
                "credential_binding", "agent_default"}) {
            assertTrue(definition.contains("'" + source + "'"),
                    "V87 must keep the source allowed (round-2 P0): " + source + " in " + definition);
        }

        UUID userId = createUser();
        for (String source : new String[]{"default", "direct", "role", "spawn", "template",
                "credential_binding", "agent_default"}) {
            UUID subjectId = UUID.randomUUID();
            insertGrant(source, "user", subjectId, "read", "instance", null);
            assertEquals(1, scalarInt("SELECT count(*) FROM grants WHERE subject_id = '"
                    + subjectId + "'::uuid AND source = '" + source + "'"),
                    "legacy/new source must still be writable in the V87 window: " + source);
        }
        assertThrows(SQLException.class, () -> insertGrant("bogus", "user", userId, "read", "instance", null),
                "unknown sources stay rejected");
    }

    @Test
    void v87CreatesOnePartialUniqueIndexPerSourceRound2P12() throws SQLException {
        // The legacy fences stay in place until V88 converts their rows.
        assertEquals(2, scalarInt("SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' "
                + "AND indexname IN ('uq_grants_default_subject', 'uq_grants_direct_subject')"),
                "V87 must not drop the V38/V65 fences before V88 converts them");

        assertEquals(1, scalarInt("SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' "
                + "AND indexname = 'uq_grants_role_atom'"));
        assertEquals(1, scalarInt("SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' "
                + "AND indexname = 'uq_grants_credential_binding_subject'"));
        assertEquals(1, scalarInt("SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' "
                + "AND indexname = 'uq_grants_agent_default_subject'"));
        assertEquals(1, scalarInt("SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' "
                + "AND indexname = 'idx_grants_subject_scope'"));

        String roleIndex = scalarString("SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' "
                + "AND indexname = 'uq_grants_role_atom'");
        assertTrue(roleIndex.contains("NULLS NOT DISTINCT"),
                "instance-scope rows (scope_id NULL) must collide: " + roleIndex);
        assertTrue(roleIndex.contains("actionClass") && roleIndex.contains("resource"),
                "the role key carries per-atom identity: " + roleIndex);

        UUID subjectId = UUID.randomUUID();
        insertGrant("role", "user", subjectId, "read", "instance", null);
        assertThrows(SQLException.class, () -> insertGrant("role", "user", subjectId, "read", "instance", null),
                "one row per (subject, scope, atom)");
        insertGrant("role", "user", subjectId, "write", "instance", null);
        UUID workspaceId = UUID.randomUUID();
        UUID userId = createUser();
        executeUpdate("INSERT INTO workspaces (id, name, owner_id) VALUES ('" + workspaceId
                + "'::uuid, 'v87-ws-atom', '" + userId + "'::uuid)");
        insertGrant("role", "user", subjectId, "read", "workspace", workspaceId);
        assertEquals(3, scalarInt("SELECT count(*) FROM grants WHERE subject_id = '"
                + subjectId + "'::uuid"), "different atoms/scopes coexist");

        UUID principalId = UUID.randomUUID();
        insertGrant("credential_binding", "agent_principal", principalId, "credential_use", "instance", null);
        assertThrows(SQLException.class, () -> insertGrant("credential_binding", "agent_principal",
                principalId, "credential_use", "instance", null),
                "V65 semantics preserved: one credential binding row per subject");

        UUID sessionId = UUID.randomUUID();
        insertGrant("agent_default", "agent", sessionId, "read", "instance", null);
        assertThrows(SQLException.class, () -> insertGrant("agent_default", "agent", sessionId,
                "write", "instance", null),
                "the frozen agent snapshot stays one row per subject");
    }

    @Test
    void v87RoleBindingsEnforceScopeSubjectAndUniqueness() throws SQLException {
        UUID userId = createUser();
        UUID roleId = UUID.fromString("00000000-0000-4000-8000-000000000003");
        executeUpdate("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type) "
                + "VALUES ('" + UUID.randomUUID() + "'::uuid, '" + roleId + "'::uuid, 'user', '"
                + userId + "'::uuid, 'instance')");
        assertThrows(SQLException.class, () -> executeUpdate(
                "INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type) VALUES ('"
                        + UUID.randomUUID() + "'::uuid, '" + roleId + "'::uuid, 'user', '"
                        + userId + "'::uuid, 'instance')"),
                "NULLS NOT DISTINCT: one instance binding per (role, subject)");
        assertThrows(SQLException.class, () -> executeUpdate(
                "INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type, scope_id) "
                        + "VALUES ('" + UUID.randomUUID() + "'::uuid, '" + roleId + "'::uuid, 'user', '"
                        + userId + "'::uuid, 'workspace', NULL)"),
                "a workspace binding requires a scope id");
        assertThrows(SQLException.class, () -> executeUpdate(
                "INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type) VALUES ('"
                        + UUID.randomUUID() + "'::uuid, '" + roleId + "'::uuid, 'group', '"
                        + userId + "'::uuid, 'instance')"),
                "only user/agent_principal subjects exist");

        // Deleting the workspace cascades to its bindings; the role itself is RESTRICT-protected.
        UUID workspaceId = UUID.randomUUID();
        executeUpdate("INSERT INTO workspaces (id, name, owner_id) VALUES ('" + workspaceId
                + "'::uuid, 'v87-ws-bind', '" + userId + "'::uuid)");
        executeUpdate("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type, scope_id) "
                + "VALUES ('" + UUID.randomUUID() + "'::uuid, '" + roleId + "'::uuid, 'user', '"
                + userId + "'::uuid, 'workspace', '" + workspaceId + "'::uuid)");
        executeUpdate("DELETE FROM workspaces WHERE id = '" + workspaceId + "'::uuid");
        assertEquals(1, scalarInt("SELECT count(*) FROM role_bindings WHERE subject_id = '"
                + userId + "'::uuid"), "workspace-scoped bindings cascade with the workspace");

        assertThrows(SQLException.class, () -> executeUpdate(
                "DELETE FROM roles WHERE id = '" + SystemAccessRoleCatalog.USER_ID + "'::uuid"),
                "a role with bindings cannot be deleted (ON DELETE RESTRICT)");
    }

    // ---------------------------------------------------------------------
    // T1.2 seeds / round-2 P1-3
    // ---------------------------------------------------------------------

    @Test
    void v87SeedsTheSixSystemRolesWithTheP13AtomCounts() throws SQLException {
        assertEquals(6, scalarInt("SELECT count(*) FROM roles WHERE is_system = true"));
        Map<String, Integer> expectedAtoms = Map.of(
                SystemAccessRoleCatalog.SUPER_ADMIN, 18,
                SystemAccessRoleCatalog.ADMIN, 9,
                SystemAccessRoleCatalog.USER, 5,
                SystemAccessRoleCatalog.WS_OWNER, 6,
                SystemAccessRoleCatalog.WS_EDITOR, 4,
                SystemAccessRoleCatalog.WS_VIEWER, 1);
        for (Map.Entry<String, Integer> entry : expectedAtoms.entrySet()) {
            assertEquals(entry.getValue(), scalarInt("SELECT count(*) FROM role_permissions rp "
                            + "JOIN roles r ON r.id = rp.role_id WHERE r.name = '" + entry.getKey() + "'"),
                    "atom count of " + entry.getKey() + " (round-2 P1-3)");
        }
        // Capability atoms live in the role definition ...
        assertEquals(3, scalarInt("SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id "
                + "WHERE r.name = 'SUPER_ADMIN' AND rp.action_class LIKE '%:%'"),
                "SUPER_ADMIN carries the three capability atoms");
        // ... but ADMIN only carries instance:admin, and USER none.
        assertEquals(1, scalarInt("SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id "
                + "WHERE r.name = 'ADMIN' AND rp.action_class LIKE '%:%'"));
        assertEquals(0, scalarInt("SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id "
                + "WHERE r.name = 'USER' AND rp.action_class LIKE '%:%'"));
        // Workspace roles exist exactly as the three OpenAPI WorkspaceRole values that carry grants.
        assertEquals(0, scalarInt("SELECT count(*) FROM roles WHERE name IN ('WS_MANAGER', 'WS_MEMBER')"),
                "round-2 P1-3 removes WS_MANAGER/WS_MEMBER; ADMIN/MEMBER canonicalize to WS_EDITOR");
    }

    @Test
    void v87SeedsMatchTheCodeSideCatalog() throws SQLException {
        // This class pins the V87 target, but the code-side catalog keeps moving with later
        // migrations (PLAN-0651 V127 adds AGENT_USER; BL-312's V147 removed CREATE_OWN_AGENT). The
        // V87-shape assertion is therefore
        // one-directional here: every row V87 seeds must still be described by the code catalog
        // (same id <-> name, and no atom the code no longer knows). The reverse direction — the code
        // catalog being fully seeded — belongs to the head target and is asserted by
        // AgentPrincipalScopeMigrationTest#headSeedsMatchTheCodeSideCatalog.
        Map<UUID, String> namesById = new HashMap<>();
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery("SELECT id, name FROM roles WHERE is_system = true")) {
            while (rs.next()) {
                namesById.put(UUID.fromString(rs.getString(1)), rs.getString(2));
            }
        }
        // task-25: the code catalog also ships AGENT_DELEGATOR (V109). This class pins the V87
        // target, so only the V87-era roles participate here; the reverse direction (every code seed
        // is seeded at head) is asserted by
        // AgentPrincipalScopeMigrationTest#headSeedsMatchTheCodeSideCatalog.
        List<SystemAccessRoleCatalog.RoleSeed> v87Seeds = SystemAccessRoleCatalog.roleSeeds().stream()
                .filter(seed -> namesById.containsKey(seed.id()))
                .toList();
        assertEquals(6, namesById.size(), "V87 seeds exactly six built-in roles");
        assertEquals(v87Seeds.size(), namesById.size(),
                "every V87-seeded role must be described by the code catalog");
        for (SystemAccessRoleCatalog.RoleSeed seed : v87Seeds) {
            assertEquals(seed.name(), namesById.get(seed.id()),
                    "fixed id must map to the same role name on both sides: " + seed.name());
            Set<String> unexplained = unexplainedAtoms(seed.id(), codeAtomsOf(seed),
                    v87AtomsOf(seed.id()));
            assertTrue(unexplained.isEmpty(),
                    "V87 seeds atoms the code catalog does not know and no later migration"
                            + " withdrew: " + seed.name() + " -> " + unexplained
                            + " (a withdrawn atom needs a RETIRED_V87_SEEDS entry naming the"
                            + " migration, its commit and the reason)");
        }
    }

    @Test
    void v87LeavesWorkflowsThatDependOnLegacyShapeIntact() throws SQLException {
        // The legacy V38/V65 fences are still the constraint of record during the V87 window.
        UUID subjectId = UUID.randomUUID();
        insertGrant("default", "user", subjectId, "read", "instance", null);
        assertThrows(SQLException.class, () -> insertGrant("default", "user", subjectId, "write",
                "instance", null), "uq_grants_default_subject still applies");
        assertNull(scalarString("SELECT to_regclass('public.workspace_members')"),
                "PLAN-0610 does not create a second membership table");
    }

    @Test
    void retiredSeedsDoNotSwallowUnknownAtoms() {
        // task-201: the exemption is per (role, atom). It must not turn into "WS_EDITOR may seed
        // anything", and it must not leak to another role that happens to ship no exec atom.
        Map<String, Set<String>> dbRows = Map.of(
                "editor", Set.of("read@*", "exec@*", "network@*", "exec@x"),
                "viewer", Set.of("exec@*"));
        Set<String> editorKnown = Set.of("read@*");
        Set<String> editorUnexplained = unexplainedAtoms(
                SystemAccessRoleCatalog.WS_EDITOR_ID, editorKnown, dbRows.get("editor"));
        assertEquals(Set.of("network@*", "exec@x"), editorUnexplained,
                "only the exact retired atom is explained; a different action class or a scoped"
                        + " pattern is still a regression");
        Set<String> viewerUnexplained = unexplainedAtoms(
                SystemAccessRoleCatalog.WS_VIEWER_ID, Set.of(), dbRows.get("viewer"));
        assertEquals(Set.of("exec@*"), viewerUnexplained,
                "the exemption belongs to WS_EDITOR only; WS_VIEWER seeding exec is still a"
                        + " regression");
        assertTrue(unexplainedAtoms(SystemAccessRoleCatalog.WS_EDITOR_ID, editorKnown,
                Set.of("read@*", "exec@*")).isEmpty(),
                "the retired editor atom is explained when nothing else is off");
    }

    @Test
    void everyRetiredSeedEntryStillDescribesAV87Row() throws SQLException {
        // The exemption list is only honest while each entry names a row V87 actually seeded.
        // A future V88-style rewrite that stops seeding the row must delete the entry instead of
        // leaving an explanation for a row nobody wrote.
        for (RetiredSeed retired : RETIRED_V87_SEEDS) {
            int rows = scalarInt("SELECT count(*) FROM role_permissions WHERE role_id = '"
                    + retired.roleId() + "'::uuid AND action_class = '"
                    + retired.atom().substring(0, retired.atom().indexOf('@'))
                    + "' AND resource_pattern = '"
                    + retired.atom().substring(retired.atom().indexOf('@') + 1) + "'");
            assertEquals(1, rows, "RETIRED_V87_SEEDS entry no longer describes a V87 row: "
                    + retired.roleName() + " -> " + retired.atom() + " (drop the entry)");
            String catalogName = SystemAccessRoleCatalog.roleSeeds().stream()
                    .filter(seed -> seed.id().equals(retired.roleId()))
                    .map(SystemAccessRoleCatalog.RoleSeed::name)
                    .findFirst()
                    .orElse(null);
            assertEquals(catalogName, retired.roleName(),
                    "the entry names the role the same way the code catalog does: "
                            + retired.roleId());
            assertTrue(retired.withdrawnBy().matches("V\\d+__[A-Za-z0-9_]+\\.sql"),
                    "the withdrawing migration is named for the reader: " + retired.withdrawnBy());
            assertTrue(retired.commit().matches("[0-9a-f]{7,40}"),
                    "the withdrawing commit is recorded so the reason can be re-checked: "
                            + retired.commit());
            assertTrue(!retired.reason().isBlank(), "every exemption carries a reason");
        }
    }

    @Test
    void anUnexplainedSeedRowTurnsTheGuardRed() throws SQLException {
        // The guard must still fail on a seed row nobody retired: prove it by adding one, reading
        // it back through the same helper the main assertion uses, then removing it in finally.
        String probe = "sabotage_probe";
        executeUpdate("INSERT INTO role_permissions (role_id, action_class, resource_pattern)"
                + " VALUES ('" + SystemAccessRoleCatalog.WS_VIEWER_ID + "'::uuid, '" + probe
                + "', '*')");
        try {
            Set<String> unexplained = unexplainedAtoms(SystemAccessRoleCatalog.WS_VIEWER_ID,
                    Set.of("read@*"), v87AtomsOf(SystemAccessRoleCatalog.WS_VIEWER_ID));
            assertEquals(Set.of(probe + "@*"), unexplained,
                    "a seed row with no retirement keeps the guard red");
        } finally {
            executeUpdate("DELETE FROM role_permissions WHERE role_id = '"
                    + SystemAccessRoleCatalog.WS_VIEWER_ID + "'::uuid AND action_class = '" + probe
                    + "'");
        }
        assertTrue(unexplainedAtoms(SystemAccessRoleCatalog.WS_VIEWER_ID, Set.of("read@*"),
                v87AtomsOf(SystemAccessRoleCatalog.WS_VIEWER_ID)).isEmpty(),
                "removing the probe restores green");
    }
}

