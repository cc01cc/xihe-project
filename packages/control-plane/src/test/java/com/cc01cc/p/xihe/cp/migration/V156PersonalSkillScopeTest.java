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
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * V156 (task-221 / D-1019 A2): the personal skill layer is <b>DDL, so the DDL is the contract</b> —
 * every arm of the new CHECK, the four-column unique key and the untouched workspace foreign key are
 * asserted against a real PostgreSQL (Testcontainers, fresh database, Flyway from scratch), never
 * against the SQL text.
 *
 * <p>Why a fresh container rather than the dev stack: the migration is verified by definition on a
 * database that has only ever seen migrations, so this test does not depend on `task-198` or on any
 * running stack. A green run here means "V156 applies to a clean database and enforces what it
 * claims"; the pre-flight SELECTs against a populated database are a separate manual step (they
 * decide smooth-vs-cleanup, not correctness).</p>
 *
 * <p>The fourth column is the point of the whole card: with three columns + NULLS NOT DISTINCT, two
 * users' same-named personal rows would be one key. {@link #twoUsersMayHoldTheSameName()} is
 * therefore the case that would have failed under the old key.</p>
 */
@Testcontainers
class V156PersonalSkillScopeTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("pgvector/pgvector:pg17")
            .withDatabaseName("xihe_cp_v156")
            .withUsername("test")
            .withPassword("test")
            .withLabels(TestContainerLabels.runId());

    private static final UUID USER_A = UUID.randomUUID();
    private static final UUID USER_B = UUID.randomUUID();
    private static final UUID WORKSPACE_1 = UUID.randomUUID();
    private static final UUID WORKSPACE_2 = UUID.randomUUID();
    private static final String HASH = "d".repeat(64);

    private static Connection connection;

    @BeforeAll
    static void migrateAndSeedFixtures() throws SQLException {
        String url = postgres.getJdbcUrl();
        Flyway.configure().dataSource(url, postgres.getUsername(), postgres.getPassword()).load().migrate();
        connection = DriverManager.getConnection(url, postgres.getUsername(), postgres.getPassword());
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + USER_A
                + "', 'v156-a@test.local', 'x', 'v156a')");
        execute("INSERT INTO users (id, email, password_hash, username) VALUES ('" + USER_B
                + "', 'v156-b@test.local', 'x', 'v156b')");
        execute("INSERT INTO workspaces (id, name) VALUES ('" + WORKSPACE_1 + "', 'v156-ws1')");
        execute("INSERT INTO workspaces (id, name) VALUES ('" + WORKSPACE_2 + "', 'v156-ws2')");
    }

    @BeforeEach
    void clearSkills() throws SQLException {
        execute("DELETE FROM skill_bindings");
        execute("DELETE FROM skills");
    }

    // ------------------------------------------------------------------ the four-column key

    @Test
    void twoUsersMayHoldTheSameName() throws SQLException {
        // The case the fourth column exists for: under (name, type, definition_scope_id) with NULLS
        // NOT DISTINCT both rows are (name,'user',NULL) and the second insert is a 23505.
        insertPersonal(USER_A, "writing");
        insertPersonal(USER_B, "writing");

        assertEquals(2, count("SELECT count(*) FROM skills WHERE name = 'writing'"),
                "two owners' same-named personal definitions must coexist");
    }

    @Test
    void oneUserMayNotHoldTheSameNameTwice() throws SQLException {
        insertPersonal(USER_A, "writing");
        SQLException duplicate = assertSqlState("23505", () -> insertPersonal(USER_A, "writing"));
        assertTrue(duplicate.getMessage().contains("uq_skills_qualified_name"),
                "the duplicate must be refused by the qualified-name key: " + duplicate.getMessage());
    }

    @Test
    void instanceWorkspaceAndPersonalRowsCoexist() throws SQLException {
        insertInstance("writing");
        insertWorkspace(WORKSPACE_1, "writing");
        insertPersonal(USER_A, "writing");

        assertEquals(3, count("SELECT count(*) FROM skills WHERE name = 'writing'"),
                "instance + workspace + personal must be three distinct qualified rows");
    }

    @Test
    void twoWorkspacesStillCollideOnlyInsideTheirOwnWorkspace() throws SQLException {
        insertWorkspace(WORKSPACE_1, "daily");
        insertWorkspace(WORKSPACE_2, "daily");

        assertEquals(2, count("SELECT count(*) FROM skills WHERE name = 'daily'"));
    }

    // ------------------------------------------------------------------ the three-arm CHECK

    @Test
    void personalRowMustNotCarryAWorkspaceId() throws SQLException {
        assertSqlState("23514", () -> insert("user", WORKSPACE_1.toString(), USER_A.toString()));
    }

    @Test
    void personalRowMustCarryAnOwner() throws SQLException {
        assertSqlState("23514", () -> insert("user", null, null));
    }

    @Test
    void workspaceRowMustNotCarryAnOwner() throws SQLException {
        assertSqlState("23514", () -> insert("workspace", WORKSPACE_1.toString(), USER_A.toString()));
    }

    @Test
    void instanceRowMustNotCarryAnOwner() throws SQLException {
        assertSqlState("23514", () -> insert("instance", null, USER_A.toString()));
    }

    // ------------------------------------------------------------------ the untouched V101 FK

    @Test
    void theWorkspaceForeignKeyIsStillEnforced() throws SQLException {
        // A2 never touches V101:27's constraint (and never needs its generated name); this proves the
        // FK still applies after the column/key rebuild — a workspace row naming a non-existent
        // workspace is a 23503, not an accepted orphan.
        SQLException violation = assertSqlState("23503",
                () -> insert("workspace", UUID.randomUUID().toString(), null));
        assertTrue(violation.getMessage().contains("definition_scope_id"),
                "the refusal must come from the definition_scope_id foreign key: " + violation.getMessage());
    }

    @Test
    void exactlyOneForeignKeyPointsAtEachParentTable() throws SQLException {
        // Regression proof instead of a name lookup: the rebuild must not have added or removed
        // another FK (we never guess the generated constraint name — we count them).
        assertEquals(1, count("SELECT count(*) FROM pg_constraint "
                + "WHERE conrelid = 'skills'::regclass AND contype = 'f' "
                + "AND confrelid = 'workspaces'::regclass"), "skills → workspaces must stay exactly one");
        assertEquals(2, count("SELECT count(*) FROM pg_constraint "
                + "WHERE conrelid = 'skills'::regclass AND contype = 'f' "
                + "AND confrelid = 'users'::regclass"),
                "skills → users: the V101:58 creator FK plus V156's owner column (and nothing else)");
    }

    // ------------------------------------------------------------------ atom seeds

    @Test
    void thePersonalSkillAtomIsSeededForTheThreeInstanceRoles() throws SQLException {
        assertEquals(3, count("SELECT count(*) FROM role_permissions "
                + "WHERE action_class = 'MANAGE_PERSONAL_SKILLS'"),
                "SUPER_ADMIN + ADMIN + USER must each carry the atom (D-1019)");
        assertEquals(1, count("SELECT count(*) FROM role_permissions WHERE action_class = "
                + "'MANAGE_PERSONAL_SKILLS' AND role_id = '00000000-0000-4000-8000-000000000003'"),
                "the USER role (…0003) is what makes the atom a registration default");
    }

    @Test
    void noWorkspaceRoleCarriesThePersonalSkillAtom() throws SQLException {
        assertEquals(0, count("SELECT count(*) FROM role_permissions rp JOIN roles r "
                + "ON r.id = rp.role_id WHERE rp.action_class = 'MANAGE_PERSONAL_SKILLS' "
                + "AND r.is_system = true AND r.name LIKE 'WS_%'"),
                "the atom is instance-bindable only (decision #27): no workspace role may hold it");
    }

    // ------------------------------------------------------------------ helpers

    private static void insertPersonal(UUID owner, String name) throws SQLException {
        insert("user", null, owner.toString(), name);
    }

    private static void insertInstance(String name) throws SQLException {
        insert("instance", null, null, name);
    }

    private static void insertWorkspace(UUID workspaceId, String name) throws SQLException {
        insert("workspace", workspaceId.toString(), null, name);
    }

    private static void insert(String type, String workspaceScopeId, String userScopeId)
            throws SQLException {
        insert(type, workspaceScopeId, userScopeId, "writing");
    }

    private static void insert(String type, String workspaceScopeId, String userScopeId, String name)
            throws SQLException {
        String scopeId = workspaceScopeId == null ? "NULL" : "'" + workspaceScopeId + "'";
        String userId = userScopeId == null ? "NULL" : "'" + userScopeId + "'";
        execute("INSERT INTO skills (id, name, definition_scope_type, definition_scope_id, "
                + "definition_scope_user_id, description, body, body_tokens_est, oversize, attachments, "
                + "trusted, source_path, content_hash, version, created_by_user_id) VALUES ("
                + "'" + UUID.randomUUID() + "', '" + name + "', '" + type + "', " + scopeId + ", "
                + userId + ", 'd', 'b', 1, false, '[]'::jsonb, false, "
                + "'.agents/skills/" + name + "/SKILL.md', '" + HASH + "', 1, '" + USER_A + "')");
    }

    /**
     * Asserts the SQLSTATE (the constraint class), not the message text: the migration must make
     * PostgreSQL refuse the row, whatever wording the server chooses.
     */
    private static SQLException assertSqlState(String expected, ThrowingSql action) {
        try {
            action.run();
        } catch (SQLException failure) {
            assertEquals(expected, failure.getSQLState(),
                    "expected SQLSTATE " + expected + " but got " + failure.getSQLState()
                            + ": " + failure.getMessage());
            return failure;
        }
        return fail("the statement was accepted, expected SQLSTATE " + expected);
    }

    @FunctionalInterface
    private interface ThrowingSql {
        void run() throws SQLException;
    }

    private static int count(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery(sql)) {
            assertNotNull(result, "count query returned nothing: " + sql);
            assertTrue(result.next(), "count query returned no row: " + sql);
            return result.getInt(1);
        }
    }

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }
}
