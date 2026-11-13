package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0773 M1-1 (task-169 / D-1116): V163 creates org_units on an EMPTY database.
 *
 * <p>Why an empty database instead of the migrated template: the two properties that break in
 * production are exactly the ones a template hides. (1) CREATE EXTENSION ltree must live inside
 * the migration — M0-1 installed it by hand in the dev database, and an empty database never saw
 * that, so a migration relying on it is green here and red in M1-8. (2) A check written against
 * the wrong premise stays invisible until something tries to violate it, so the hyphen rule is
 * exercised in both directions below.</p>
 *
 * <p><b>Measured correction carried by this test</b>: design.md 3.1 and tasks.md:18 justify the
 * de-hyphenated path segment with "ltree labels cannot contain -". On PostgreSQL 17.10 that is
 * FALSE — SELECT 'a-b'::ltree succeeds as a single label. The rule is therefore ours, enforced
 * only by ck_org_units_path_no_hyphen; the test asserts BOTH halves (the database accepts the
 * scalar, the table rejects the row) so nobody can mistake the CHECK for decoration.</p>
 */
class OrgUnitsMigrationTest {

    private static TestDatabaseProvider.DatabaseRef postgres;
    private static Connection connection;

    @BeforeAll
    static void migrateToHeadOnAnEmptyDatabase() throws SQLException {
        postgres = TestDatabaseProvider.emptyDatabase("plan0773_m1_1");
        Flyway.configure()
                .dataSource(postgres.jdbcUrl(), postgres.username(), postgres.password())
                .locations("classpath:db/migration")
                .load()
                .migrate();
        connection = DriverManager.getConnection(
                postgres.jdbcUrl(), postgres.username(), postgres.password());
    }

    @AfterAll
    static void close() throws SQLException {
        if (connection != null) {
            connection.close();
        }
    }

    /**
     * The whole class shares one database, and V163 deliberately forbids two roots with one name
     * (uq_org_units_sibling_name), so a leftover row from the previous test would fail the next one
     * for the wrong reason. Every test therefore starts on an empty table.
     */
    @BeforeEach
    void startFromAnEmptyTable() throws SQLException {
        execute("DELETE FROM org_units");
    }

    @Test
    void ltreeIsInstalledByThisMigrationOnAnEmptyDatabase() throws SQLException {
        String version = text("SELECT extversion FROM pg_extension WHERE extname = 'ltree'");
        assertNotNull(version, "V163 must create the ltree extension itself (tasks.md:21)");
        assertFalse(version.isBlank(), "extversion must not be empty");
    }

    @Test
    void theTableHasTheShapeTheDesignFroze() throws SQLException {
        assertEquals("uuid", text("SELECT data_type FROM information_schema.columns"
                + " WHERE table_name = 'org_units' AND column_name = 'id'"));
        assertEquals("USER-DEFINED", text("SELECT data_type FROM information_schema.columns"
                + " WHERE table_name = 'org_units' AND column_name = 'path'"));
        assertEquals("integer", text("SELECT data_type FROM information_schema.columns"
                + " WHERE table_name = 'org_units' AND column_name = 'depth'"));
        assertEquals("YES", text("SELECT is_nullable FROM information_schema.columns"
                + " WHERE table_name = 'org_units' AND column_name = 'parent_id'"),
                "parent_id must be nullable: a root has no parent");

        for (String constraint : List.of("uq_org_units_path", "uq_org_units_sibling_name",
                "ck_org_units_root", "ck_org_units_path_no_hyphen")) {
            assertEquals(1, scalar("SELECT count(*) FROM pg_constraint"
                    + " WHERE conrelid = 'org_units'::regclass AND conname = '" + constraint + "'"),
                    constraint + " must exist");
        }
        assertEquals(1, scalar("SELECT count(*) FROM pg_constraint"
                + " WHERE conrelid = 'org_units'::regclass AND contype = 'f'"),
                "the self-referencing parent_id foreign key must exist");

        assertEquals(1, scalar("SELECT count(*) FROM pg_indexes"
                + " WHERE tablename = 'org_units' AND indexname = 'idx_org_units_parent'"),
                "the parent index (child list / FK check) must exist");
        assertTrue(text("SELECT indexdef FROM pg_indexes"
                + " WHERE tablename = 'org_units' AND indexname = 'idx_org_units_path'")
                .toLowerCase().contains("using gist"),
                "subtree queries walk path <@, so the path index must be GIST");
    }

    @Test
    void theHyphenRuleIsOursBecauseTheDatabaseAcceptsHyphens() throws SQLException {
        // Half of the correction: ltree itself has no problem with a hyphen on PG 17, so the
        // CHECK is not redundant and "ltree forbids it" cannot be the reason we keep the rule.
        assertEquals(1, scalar("SELECT nlevel('aaa-bbb'::ltree)"),
                "PG 17 keeps a hyphenated segment as ONE label: the old premise is false here");

        UUID id = UUID.randomUUID();
        SQLException rejected = assertThrows(SQLException.class, () -> execute(
                "INSERT INTO org_units (id, parent_id, name, path, depth) VALUES ('" + id
                        + "', NULL, 'hyphen', '" + id + "', 0)"));
        assertEquals("23514", rejected.getSQLState(),
                "the row must be refused by ck_org_units_path_no_hyphen (a raw uuid path)");
    }

    @Test
    void everyStoredPathIsHyphenFreeAndExtendsItsParent() throws SQLException {
        UUID rootId = insertUnit(null, "root", 0);
        UUID childId = insertUnit(rootId, "child", 1);

        List<String> paths = new ArrayList<>();
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT path::text FROM org_units")) {
            while (rows.next()) {
                paths.add(rows.getString(1));
            }
        }
        assertEquals(2, paths.size());
        for (String path : paths) {
            assertFalse(path.contains("-"), "a stored path must not contain a hyphen: " + path);
        }
        String rootPath = text("SELECT path::text FROM org_units WHERE id = '" + rootId + "'");
        String childPath = text("SELECT path::text FROM org_units WHERE id = '" + childId + "'");
        assertTrue(childPath.startsWith(rootPath + "."),
                "a child path must extend its parent: " + childPath + " vs " + rootPath);
        assertEquals(2, scalar("SELECT nlevel(path) FROM org_units WHERE id = '" + childId + "'"),
                "each unit contributes exactly one label");
    }

    @Test
    void twoRootsCannotShareANameButDifferentParentsMayReuseOne() throws SQLException {
        insertUnit(null, "engineering", 0);
        // Negative control for NULLS NOT DISTINCT: both rows have parent_id NULL, and plain
        // UNIQUE (parent_id, name) treats NULLs as distinct => this insert would succeed.
        SQLException duplicated = assertThrows(SQLException.class,
                () -> insertUnit(null, "engineering", 0));
        assertEquals("23505", duplicated.getSQLState(),
                "two roots sharing a name must collide (uq_org_units_sibling_name)");

        UUID secondRoot = insertUnit(null, "operations", 0);
        insertUnit(secondRoot, "engineering", 1);
        assertEquals(3, scalar("SELECT count(*) FROM org_units"),
                "the same name under a different parent must be allowed");
    }

    @Test
    void parentAndDepthCannotDisagree() throws SQLException {
        UUID rootId = insertUnit(null, "root", 0);
        SQLException rootWithDepth = assertThrows(SQLException.class,
                () -> insertUnit(null, "second-root", 1));
        assertEquals("23514", rootWithDepth.getSQLState(),
                "a parentless unit with depth > 0 is refused");

        SQLException childWithoutDepth = assertThrows(SQLException.class,
                () -> insertUnit(rootId, "flat-child", 0));
        assertEquals("23514", childWithoutDepth.getSQLState(),
                "a unit with a parent and depth 0 is refused");
    }

    @Test
    void duplicatePathAndOrphanDeletionAreRefused() throws SQLException {
        UUID rootId = insertUnit(null, "root", 0);
        UUID childId = insertUnit(rootId, "child", 1);
        String childPath = text("SELECT path::text FROM org_units WHERE id = '" + childId + "'");

        SQLException duplicatedPath = assertThrows(SQLException.class, () -> execute(
                "INSERT INTO org_units (id, parent_id, name, path, depth) VALUES ('"
                        + UUID.randomUUID() + "', NULL, 'other', '" + childPath + "', 0)"));
        assertEquals("23505", duplicatedPath.getSQLState(), "uq_org_units_path must hold");

        SQLException orphan = assertThrows(SQLException.class,
                () -> execute("DELETE FROM org_units WHERE id = '" + rootId + "'"));
        assertEquals("23503", orphan.getSQLState(), "ON DELETE RESTRICT must keep the subtree");
        assertEquals(1, scalar("SELECT count(*) FROM org_units WHERE parent_id = '" + rootId + "'"),
                "the child must still be there after the refused delete");
    }

    /** Inserts one unit, building the path exactly the way a writer must (D-1116). */
    private static UUID insertUnit(UUID parentId, String name, int depth) throws SQLException {
        UUID id = UUID.randomUUID();
        String path = parentId == null
                ? id.toString().replace("-", "")
                : text("SELECT path::text FROM org_units WHERE id = '" + parentId + "'")
                        + "." + id.toString().replace("-", "");
        execute("INSERT INTO org_units (id, parent_id, name, path, depth) VALUES ('" + id + "', "
                + (parentId == null ? "NULL" : "'" + parentId + "'") + ", '" + name + "', "
                + "'" + path + "', " + depth + ")");
        return id;
    }

    private static int scalar(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getInt(1);
        }
    }

    private static String text(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getString(1);
        }
    }

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }
}
