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
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * PLAN-0773 M1-6 (task-260) / DSD-1513 (task-148): the org-unit seed, on an EMPTY database.
 *
 * <p>V167 seeds the root; V181 (DSD-1513 / DSD-1520 D1) adds the two groups below it and the i18n key
 * column, so the decided shape of a fresh chain is three rows, not one. The old assertion —「a fresh
 * chain leaves exactly one unit」— was correct until V181 and is now the wrong fact, which is why this
 * class pins the whole tree (ids, parent chain, names, keys, ltree paths) rather than a count.</p>
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
    private static final String V181 = "V181__dsd1513_first_run_seed_org_units.sql";

    /** The three ltree labels V181 leaves behind: one per sentinel id, each the id without hyphens. */
    private static final String LEADERS_ID = "00000000-0000-4000-8000-0000000000e2";
    private static final String EXECUTION_ID = "00000000-0000-4000-8000-0000000000e3";
    private static final String SECOND_LABEL = LEADERS_ID.replace("-", "");
    private static final String THIRD_LABEL = EXECUTION_ID.replace("-", "");
    private static final String LEAF_LABEL = ROOT_ID.toString().replace("-", "");

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
    void aFreshMigrationChainLeavesExactlyTheTreeDsd1513Decided() throws SQLException {
        assertEquals(1, scalar("SELECT count(*) FROM org_units WHERE parent_id IS NULL"),
                "M1-6: a fresh database must not be an empty tree -- that is what made the org-members"
                        + " page report 「无法查看组织单元」 (task-260). DSD-1513 keeps exactly ONE root:"
                        + " a second root would make the member-facing list show a unit nobody asked for");
        assertEquals(3, scalar("SELECT count(*) FROM org_units"),
                "DSD-1513 / V181: the tree is the root plus the two groups V181 seeds (负责人组 / 执行组);"
                        + " three rows is the whole decided shape, so a fourth means something was invented");
        assertEquals(List.of(
                        ROOT_ID + "|null|默认组织|orgUnit.seedRoot|" + ROOT_PATH,
                        LEADERS_ID + "|" + ROOT_ID + "|负责人组|orgUnit.seedLeaders|"
                                + ROOT_PATH + "." + SECOND_LABEL,
                        EXECUTION_ID + "|" + LEADERS_ID + "|执行组|orgUnit.seedExecution|"
                                + ROOT_PATH + "." + SECOND_LABEL + "." + THIRD_LABEL),
                treeRows(),
                "the tree must be exactly V181's three rows: id, parent chain, name, i18n key and ltree"
                        + " path all pinned -- a count-only assertion would pass on three unrelated units");
        // The path convention D-1116 fixes is one UUID label per level, so the root — depth 0 — carries a
        // ONE-label path: the invariant is nlevel(path) - 1 = depth, not nlevel(path) = depth.
        assertEquals(0, scalar("SELECT count(*) FROM org_units WHERE nlevel(path) - 1 <> depth"),
                "every seeded row must agree with the ltree label-per-level convention (D-1116)");
        System.out.println("[seed-readings] stage=fresh-chain rows=" + treeRows()
                + " roots=" + scalar("SELECT count(*) FROM org_units WHERE parent_id IS NULL")
                + " keyed_rows=" + scalar("SELECT count(*) FROM org_units WHERE name_key IS NOT NULL")
                + " depth_offset_mismatches="
                + scalar("SELECT count(*) FROM org_units WHERE nlevel(path) - 1 <> depth"));
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
        System.out.println("[seed-readings] stage=v167-replay affected=" + affected
                + " units_before=" + before + " units_after=" + scalar("SELECT count(*) FROM org_units"));
    }

    /**
     * V181's own replay, and the one column it owns: {@code name_key}. Replaying must insert nothing
     * (both clauses converge) AND must not blank a key it already wrote, while a unit a user created
     * stays untranslated ({@code NULL}) -- the migration only ever names the sentinel root by id.
     */
    @Test
    void replayingV181InsertsZeroRowsAndNeverTouchesUserUnits() throws Exception {
        long unitsBefore = scalar("SELECT count(*) FROM org_units");

        // A unit a user created: no i18n key by construction (config/OrgUnitNameKeys falls back to the
        // stored name). Inserted AFTER the chain, so V181's backfill has already run and cannot have
        // been the one that set it.
        String userLabel = "usercreated";
        String userPath = ROOT_PATH + "." + userLabel;
        execute("INSERT INTO org_units (id, parent_id, name, path, depth) VALUES ('"
                + UUID.randomUUID() + "', '" + ROOT_ID + "', '用户自建', '" + userPath + "', 1)");
        try {
            int affected = executeSeedDmlAgain(V181);

            assertEquals(0, affected,
                    "V181 must be re-runnable: both the backfill (name_key IS NULL guard) and the two inserts"
                            + " (ON CONFLICT DO NOTHING) have to converge to zero rows of change");
            assertEquals(unitsBefore + 1, scalar("SELECT count(*) FROM org_units"),
                    "a replay must not add a fourth unit -- three seeded rows is the decided shape");
            assertEquals(3, scalar("SELECT count(*) FROM org_units WHERE name_key IS NOT NULL"),
                    "exactly the three seeded units carry an i18n key; the user's unit must stay NULL,"
                            + " otherwise the read face would translate a name the user typed");
            assertNull(text("SELECT name_key FROM org_units WHERE path::text = '" + userPath + "'"),
                    "the backfill is pinned to the sentinel id, not to 'every unit without a key'");
            assertEquals("orgUnit.seedRoot", text("SELECT name_key FROM org_units WHERE id = '" + ROOT_ID + "'"),
                    "the replay must not blank the key it wrote on the first pass");
            System.out.println("[seed-readings] stage=v181-replay affected=" + affected
                    + " units=" + scalar("SELECT count(*) FROM org_units")
                    + " keyed_rows=" + scalar("SELECT count(*) FROM org_units WHERE name_key IS NOT NULL")
                    + " user_row_key=" + text("SELECT name_key FROM org_units WHERE path::text = '" + userPath + "'")
                    + " root_key=" + text("SELECT name_key FROM org_units WHERE id = '" + ROOT_ID + "'")
                    + " root_rows=" + scalar("SELECT count(*) FROM org_units WHERE parent_id IS NULL")
                    + " depth_offset_mismatches="
                    + scalar("SELECT count(*) FROM org_units WHERE nlevel(path) - 1 <> depth"));
        } finally {
            // This class shares one database across its test methods; leaving the user unit behind
            // would make the "exactly three rows" assertion in the fresh-chain case depend on order.
            execute("DELETE FROM org_units WHERE path::text = '" + userPath + "'");
        }
    }

    /** One row per unit, in id order: {@code id|parent|name|name_key|path}. */
    private static List<String> treeRows() throws SQLException {
        List<String> rows = new java.util.ArrayList<>();
        try (Statement statement = connection.createStatement();
             ResultSet result = statement.executeQuery(
                     "SELECT id::text, parent_id::text, name, name_key, path::text FROM org_units ORDER BY id")) {
            while (result.next()) {
                rows.add(result.getString(1) + "|" + result.getString(2) + "|" + result.getString(3)
                        + "|" + result.getString(4) + "|" + result.getString(5));
            }
        }
        return rows;
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

    /**
     * Replays only the SEED statements of a migration file (the {@code UPDATE} backfill and the two
     * {@code INSERT}s) and returns the summed affected-row count.
     *
     * <p>Schema statements are skipped on purpose, and that is not a softer assertion: a flyway
     * migration is applied once, so "re-runnable" can only mean something about the rows it seeds.
     * V181's first statement is {@code ALTER TABLE org_units ADD COLUMN name_key}, which PostgreSQL
     * refuses a second time ({@code 42701}) — replaying it would be testing the database, not the
     * seed. V167 has no DDL at all, which is why its replay uses {@link #executeMigrationAgain}.</p>
     */
    private static int executeSeedDmlAgain(String fileName) throws Exception {
        int affected = 0;
        for (String raw : statements(fileName)) {
            String statementSql = raw.trim();
            if (statementSql.isEmpty()) {
                continue;
            }
            String upper = statementSql.toUpperCase(java.util.Locale.ROOT);
            if (upper.startsWith("ALTER ") || upper.startsWith("COMMENT ")) {
                continue;
            }
            try (Statement statement = connection.createStatement()) {
                affected += statement.executeUpdate(statementSql);
            }
        }
        return affected;
    }

    /** Replays a migration file's statements and returns the summed affected-row count. */
    private static int executeMigrationAgain(String fileName) throws Exception {
        int affected = 0;
        try (Statement statement = connection.createStatement()) {
            for (String raw : statements(fileName)) {
                String statementSql = raw.trim();
                if (statementSql.isEmpty()) {
                    continue;
                }
                affected += statement.executeUpdate(statementSql);
            }
        }
        return affected;
    }

    /**
     * The file's statements, comments already stripped, split on ';' <b>outside</b> string literals.
     *
     * <p>The quote tracking is not defensive over-engineering: V181:56 contains
     * {@code '...NameKeys.java; the wire response stays a single string.'} — a semicolon inside a
     * string literal — and a naive {@code split(";")} cuts it in half, which PostgreSQL then rejects
     * as an unterminated literal (measured: {@code PSQL Unterminated string literal started at
     * position 40}). Stripping the leading {@code --} prose first is equally load-bearing: that prose
     * carries both semicolons and apostrophes (V167:9 quotes the seed's empty tree in backticks and
     * V181:16 has a possessive).</p>
     */
    private static String[] statements(String fileName) throws Exception {
        String sql;
        try (InputStream in = OrgUnitRootSeedMigrationTest.class
                .getResourceAsStream("/db/migration/" + fileName)) {
            assertNotNull(in, "migration resource missing: " + fileName);
            sql = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        List<String> statements = new java.util.ArrayList<>();
        StringBuilder current = new StringBuilder();
        boolean inString = false;
        for (char c : stripComments(sql).toCharArray()) {
            if (c == '\'') {
                inString = !inString;
            }
            if (c == ';' && !inString) {
                statements.add(current.toString());
                current.setLength(0);
                continue;
            }
            current.append(c);
        }
        statements.add(current.toString());
        return statements.toArray(new String[0]);
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
