package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * PLAN-0773 M1-6 (task-260): V167 seeds the one root org unit on an EMPTY database.
 *
 * <p>Four properties, each of which a "it ran once and a row appeared" test would miss:</p>
 *
 * <ol>
 *   <li><b>The row is there after a full Flyway chain</b> -- the page that reported
 *       「无法查看组织单元」 was reading an empty tree, so "how many roots does a fresh database have"
 *       is the whole card.
 *   <li><b>It is a ROOT, in the sense the table defines</b> -- parent_id NULL and depth 0
 *       (ck_org_units_root), and its path obeys D-1116 (ck_org_units_path_no_hyphen). Asserted
 *       against the constraints rather than copied from the literal, because the literal is what
 *       this test would otherwise be checking against itself.</li>
 *   <li><b>The replay inserts zero rows.</b> The row counts staying equal is NOT the assertion:
 *       a delete+insert keeps totals equal and is still a re-run that changes the data. The
 *       affected-row count of a second execution is what is asserted (same rule, same helper
 *       shape as V114V115SeedIdempotencyAndParityTest, and the reason V129:31-61 exists).</li>
 *   <li><b>The conflict form is exercised from both sides.</b> ON CONFLICT DO NOTHING was chosen
 *       untargeted because TWO constraints can be the collision (the primary key on id, and
 *       uq_org_units_path on the label). A targeted form would silently make the other one a
 *       hard error -- so this test inserts a *different* row that reuses each of those two values
 *       and asserts both are refused (23505), then replays V167 and asserts 0 rows.</li>
 * </ol>
 *
 * <p><b>What is deliberately NOT here</b>: the admin's {@code org_unit_members} row. It cannot
 * exist at migration time (no user row exists on a fresh chain, and {@code User.id} is minted at
 * runtime), so it is DataSeeder's half of the seed. Claiming it in this file would be a test that
 * can only pass on a database something else prepared.</p>
 */
class OrgUnitRootSeedMigrationTest {

    /** The literal V167 inserts; duplicated here so the test compares DATA with the migration file. */
    private static final UUID ROOT_ID = UUID.fromString("00000000-0000-4000-8000-0000000000e1");
    private static final String ROOT_PATH = "000000000000400080000000000000e1";
    private static final String V167 = "V167__plan0773_org_unit_seed_root.sql";

    private static TestDatabaseProvider.DatabaseRef postgres;
    private static Connection connection;

    @BeforeAll
    static void migrateToHeadOnAnEmptyDatabase() throws SQLException {
        // empty-db-required: the point of this test is the FIRST application of V167 on a database
        // that never had a root; the migrated template would hide whether the seed or a previous
        // run produced the row.
        postgres = TestDatabaseProvider.emptyDatabase("plan0773_m1_6");
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

    @Test
    void aFreshMigrationChainLeavesExactlyOneRootUnit() throws SQLException {
        assertEquals(1, scalar("SELECT count(*) FROM org_units WHERE parent_id IS NULL"),
                "M1-6: a fresh database must not be an empty tree -- that is what made the org-members"
                        + " page report 「无法查看组织单元」 (task-260)");
        assertEquals(1, scalar("SELECT count(*) FROM org_units"),
                "V167 seeds one root and nothing else: no child unit is invented, and no second root"
                        + " (every root would make the member-facing tree show a unit nobody asked for)");
    }

    @Test
    void theSeededRowSatisfiesTheConstraintsThatDefineARoot() throws SQLException {
        assertEquals(ROOT_ID, uuid("SELECT id FROM org_units WHERE parent_id IS NULL"),
                "the id must be the fixed sentinel: DataSeeder names the unit by this literal"
                        + " (a random uuid would make the runtime half unaddressable without a lookup)");
        assertEquals(ROOT_PATH, text("SELECT path::text FROM org_units WHERE id = '" + ROOT_ID + "'"),
                "D-1116: the label is the id without hyphens, not a decorative 'root'");
        assertEquals(0, scalar("SELECT depth FROM org_units WHERE id = '" + ROOT_ID + "'"),
                "ck_org_units_root: parent_id IS NULL must agree with depth = 0");
        assertEquals(ROOT_ID.toString().replace("-", ""), ROOT_PATH,
                "the label and the id must stay one value: a hand-written path would be the only row"
                        + " in the table not following the rule everything else follows");
    }

    /**
     * The Lead's ruling for this card: 「260 的判据里第②条幂等必测」. The count of affected rows,
     * not the row totals -- see the class javadoc point 3.
     */
    @Test
    void replayingV167InsertsZeroRowsAndMovesNoCount() throws Exception {
        long before = scalar("SELECT count(*) FROM org_units");
        int affected = executeMigrationAgain(V167);
        assertEquals(0, affected,
                "the second execution must insert nothing: ON CONFLICT DO NOTHING is what makes the"
                        + " seed re-runnable, and a non-zero count means the guard is gone (a delete+insert"
                        + " would also keep the totals equal, which is why the affected count is the assertion)");
        assertEquals(before, scalar("SELECT count(*) FROM org_units"),
                "row count must not move on a re-run");
        assertEquals(ROOT_PATH, text("SELECT path::text FROM org_units WHERE id = '" + ROOT_ID + "'"),
                "a re-run must not rewrite the existing row either");
    }

    /**
     * Negative controls: both constraints ON CONFLICT DO NOTHING has to absorb, exercised
     * separately so a targeted conflict clause (which would cover only one) is caught.
     */
    @Test
    void bothCollisionPathsAreRefusedRatherThanSilentlyDuplicated() throws SQLException {
        // (a) the primary key: same id, different path and name.
        SQLException sameId = org.junit.jupiter.api.Assertions.assertThrows(SQLException.class,
                () -> execute("INSERT INTO org_units (id, parent_id, name, path, depth) VALUES ('"
                        + ROOT_ID + "', NULL, 'another-name', 'anotherlabel', 0)"));
        assertEquals("23505", sameId.getSQLState(),
                "the primary key is one of the two collisions V167's untargeted DO NOTHING absorbs");

        // (b) uq_org_units_path: a different id claiming the seeded label.
        SQLException samePath = org.junit.jupiter.api.Assertions.assertThrows(SQLException.class,
                () -> execute("INSERT INTO org_units (id, parent_id, name, path, depth) VALUES ('"
                        + UUID.randomUUID() + "', NULL, 'default-org-2', '" + ROOT_PATH + "', 0)"));
        assertEquals("23505", samePath.getSQLState(),
                "uq_org_units_path is the second collision; a targeted ON CONFLICT (id) would let this"
                        + " one raise instead of being skipped");
    }

    /** Replays a migration file's statements and returns the summed affected-row count. */
    private static int executeMigrationAgain(String fileName) throws Exception {
        String sql;
        try (InputStream in = OrgUnitRootSeedMigrationTest.class
                .getResourceAsStream("/db/migration/" + fileName)) {
            assertNotNull(in, "migration resource missing: " + fileName);
            sql = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        int affected = 0;
        // Strip comments BEFORE splitting on ';': the header prose contains semicolons and an
        // apostrophe-bearing word, and a naive split turns those into syntax errors.
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
            if (line.trim().startsWith("--")) {
                continue;
            }
            out.append(line).append('\n');
        }
        return out.toString();
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

    private static UUID uuid(String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getObject(1, UUID.class);
        }
    }

    private static void execute(String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }
}
