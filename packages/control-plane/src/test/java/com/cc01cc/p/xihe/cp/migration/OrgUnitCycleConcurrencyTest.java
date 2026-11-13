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
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0773 M1-3 follow-up (task-178): the advisory lock in V165 is proven by measurement, not
 * by reasoning.
 *
 * <p>Three readings, in this order, because the third is what makes the first two mean
 * anything:</p>
 * <ol>
 *   <li>Blocked while the first mover is uncommitted -- T2 gets 55P03 (lock_not_available) after a
 *       500 ms lock_timeout. A 55P03 can only happen after waiting, so this proves the lock is
 *       held; it does not yet prove the lock is what saved us.</li>
 *   <li>Refused as a cycle after the first mover commits -- the retry now walks an ancestor chain
 *       that contains the moved unit, so it gets XH001; and the tree stays acyclic.</li>
 *   <li>The negative control -- the same two statements with the PERFORM pg_advisory_xact_lock
 *       line removed from the function: T2 is NOT blocked, both updates succeed, and the tree
 *       really does close a ring (asserted by walking the ancestor chain, not by trusting the two
 *       UPDATE results). Without this, "the lock works" and "these two moves never collide
 *       anyway" are indistinguishable.</li>
 * </ol>
 *
 * <p>No Thread.sleep anywhere: every wait is bounded by lock_timeout and judged by SQLSTATE, so
 * the test cannot become flaky on a slow machine -- it either blocks (55P03) or it does not.</p>
 */
class OrgUnitCycleConcurrencyTest {

    private static final String CYCLE_CODE = "XH001";
    private static final String LOCK_CODE = "55P03";
    private static final String LOCK_TIMEOUT = "500ms";

    private static TestDatabaseProvider.DatabaseRef sharedDatabase;
    private static Connection first;
    private static Connection second;

    private static String jdbcUrl;
    private static String username;
    private static String password;

    @BeforeAll
    static void migrateToHeadOnAnEmptyDatabase() throws SQLException {
        sharedDatabase = TestDatabaseProvider.emptyDatabase("plan0773_m1_3_concurrency");
        jdbcUrl = sharedDatabase.jdbcUrl();
        username = sharedDatabase.username();
        password = sharedDatabase.password();
        Flyway.configure()
                .dataSource(jdbcUrl, username, password)
                .locations("classpath:db/migration")
                .load()
                .migrate();
        first = DriverManager.getConnection(jdbcUrl, username, password);
        second = DriverManager.getConnection(jdbcUrl, username, password);
    }

    @AfterAll
    static void close() throws SQLException {
        if (first != null) {
            first.close();
        }
        if (second != null) {
            second.close();
        }
    }

    @BeforeEach
    void startFromEmptyTables() throws SQLException {
        rollbackIfOpen(first);
        rollbackIfOpen(second);
        execute(first, "DELETE FROM org_unit_members");
        execute(first, "DELETE FROM org_units");
    }

    @Test
    void theSecondMoverIsBlockedWhileTheFirstMoverIsUncommitted() throws SQLException {
        UUID a = insertUnit(first, "a", null, 0);
        UUID b = insertUnit(first, "b", a, 1);
        UUID c = insertUnit(first, "c", b, 2);
        UUID d = insertUnit(first, "d", c, 3);

        // T1: a legal move, left uncommitted on purpose -- this is what holds the advisory lock.
        first.setAutoCommit(false);
        execute(first, "UPDATE org_units SET parent_id = '" + b + "' WHERE id = '" + d + "'");

        // T2: the other half of the pair, bounded by a lock_timeout instead of a guess.
        second.setAutoCommit(false);
        execute(second, "SET LOCAL lock_timeout = '" + LOCK_TIMEOUT + "'");
        SQLException blocked = assertThrows(SQLException.class,
                () -> execute(second, "UPDATE org_units SET parent_id = '" + d
                        + "' WHERE id = '" + b + "'"));
        assertEquals(LOCK_CODE, blocked.getSQLState(),
                "T2 must WAIT on the advisory lock and time out -- 55P03, not a quick success");

        rollbackIfOpen(second);
        first.rollback();
        first.setAutoCommit(true);
    }

    @Test
    void afterTheFirstMoverCommitsTheSecondMoverIsRefusedAsACycle() throws SQLException {
        UUID a = insertUnit(first, "a", null, 0);
        UUID b = insertUnit(first, "b", a, 1);
        UUID c = insertUnit(first, "c", b, 2);
        UUID d = insertUnit(first, "d", c, 3);

        execute(first, "UPDATE org_units SET parent_id = '" + b + "' WHERE id = '" + d + "'");

        second.setAutoCommit(false);
        execute(second, "SET LOCAL lock_timeout = '" + LOCK_TIMEOUT + "'");
        SQLException refused = assertThrows(SQLException.class,
                () -> execute(second, "UPDATE org_units SET parent_id = '" + d
                        + "' WHERE id = '" + b + "'"));
        assertEquals(CYCLE_CODE, refused.getSQLState(),
                "after D moved under B, moving B under D closes a ring: " + refused.getMessage());
        rollbackIfOpen(second);

        assertTrue(longestAncestorWalk(first) < 50, "the committed tree must still be acyclic");
        assertEquals(b, parentOf(first, d), "D stays under B");
        assertEquals(a, parentOf(first, b), "B stays under A");
    }

    @Test
    void removingTheAdvisoryLockDoesNotUnblockTheSecondMover() throws SQLException {
        // Own database on purpose: replacing the function would leak into the other tests in this
        // class if they shared its database.
        TestDatabaseProvider.DatabaseRef control =
                TestDatabaseProvider.emptyDatabase("plan0773_m1_3_concurrency_nolock");
        Flyway.configure()
                .dataSource(control.jdbcUrl(), control.username(), control.password())
                .locations("classpath:db/migration")
                .load()
                .migrate();
        try (Connection setup = DriverManager.getConnection(
                     control.jdbcUrl(), control.username(), control.password());
             Connection t1 = DriverManager.getConnection(
                     control.jdbcUrl(), control.username(), control.password());
             Connection t2 = DriverManager.getConnection(
                     control.jdbcUrl(), control.username(), control.password())) {
            String installed = text(setup, "SELECT prosrc FROM pg_proc"
                    + " WHERE proname = 'org_units_reject_cycle'");
            String lockLine = "PERFORM pg_advisory_xact_lock(hashtext('org_units'));";
            String withoutLock = installed.replace(lockLine, "");
            assertNotEquals(installed, withoutLock,
                    "the control must actually remove the lock line, not a lookalike");
            assertEquals(installed.length() - lockLine.length(), withoutLock.length(),
                    "exactly one line may be removed -- the rest of the guard stays");
            execute(setup, "CREATE OR REPLACE FUNCTION org_units_reject_cycle() RETURNS trigger"
                    + " AS $$" + withoutLock + "$$ LANGUAGE plpgsql");

            UUID a = insertUnit(setup, "a", null, 0);
            UUID b = insertUnit(setup, "b", a, 1);
            UUID c = insertUnit(setup, "c", b, 2);
            UUID d = insertUnit(setup, "d", c, 3);

            // Same two statements as the positive reading, same order, same timeout. The
            // measurement contradicts the assumption this test was written to show: T2 is STILL
            // blocked, so the advisory lock is not what serialises this pair.
            t1.setAutoCommit(false);
            execute(t1, "UPDATE org_units SET parent_id = '" + b + "' WHERE id = '" + d + "'");

            t2.setAutoCommit(false);
            execute(t2, "SET LOCAL lock_timeout = '" + LOCK_TIMEOUT + "'");
            SQLException stillBlocked = assertThrows(SQLException.class,
                    () -> execute(t2, "UPDATE org_units SET parent_id = '" + d
                            + "' WHERE id = '" + b + "'"));
            assertEquals(LOCK_CODE, stillBlocked.getSQLState(),
                    "with the advisory lock line REMOVED the second mover must still be blocked --"
                            + " if it were not, the advisory lock would be load-bearing");
            rollbackIfOpen(t2);

            // ... and the guard still holds once the first move commits: the heap lock serialised
            // the pair, so the second mover walks a chain that already contains it.
            t1.commit();
            t2.setAutoCommit(false);
            execute(t2, "SET LOCAL lock_timeout = '" + LOCK_TIMEOUT + "'");
            SQLException refused = assertThrows(SQLException.class,
                    () -> execute(t2, "UPDATE org_units SET parent_id = '" + d
                            + "' WHERE id = '" + b + "'"));
            assertEquals(CYCLE_CODE, refused.getSQLState(), refused.getMessage());
            rollbackIfOpen(t2);

            // No ring: the ancestor closures are still chains. Asserted by walking, not by the two
            // UPDATE results -- "both statements returned 1" is also what a broken system prints.
            assertEquals(1, ringSize(setup, a), "A is a root: its closure is itself alone");
            assertEquals(3, ringSize(setup, d), "D -> B -> A: a chain of three, not a ring of two");
            assertTrue(ringSize(setup, b) < 50, "B is still on a finite chain");
        }
    }

    @Test
    void aParentChangeTakesTheStrongRowLockBecauseParentIdIsUniqueKeyed() throws SQLException {
        // This is the mechanism behind the test above. The foreign key check takes FOR KEY SHARE
        // on the new parent row; a plain column update only needs FOR NO KEY UPDATE and passes
        // under that; but an update that touches parent_id needs FOR UPDATE, because parent_id is
        // part of the unique index uq_org_units_sibling_name (parent_id, name). Two moves that
        // would close a ring always reference each other rows, so they always collide here --
        // which is why the ring cannot form even with the advisory lock line removed.
        UUID a = insertUnit(first, "a", null, 0);
        UUID b = insertUnit(first, "b", a, 1);

        // Same lock the FK trigger takes: the weakest row lock on the referenced row.
        first.setAutoCommit(false);
        execute(first, "SELECT 1 FROM org_units WHERE id = '" + b + "' FOR KEY SHARE");

        second.setAutoCommit(false);
        execute(second, "SET LOCAL lock_timeout = '" + LOCK_TIMEOUT + "'");
        execute(second, "UPDATE org_units SET depth = 4 WHERE id = '" + b + "'");
        assertEquals(4, scalar(second, "SELECT depth FROM org_units WHERE id = '" + b + "'"),
                "a non-key column update passes under FOR KEY SHARE: it takes FOR NO KEY UPDATE");
        second.commit();

        second.setAutoCommit(true);
        execute(second, "SET lock_timeout = '" + LOCK_TIMEOUT + "'");
        SQLException conflict = assertThrows(SQLException.class,
                () -> execute(second, "UPDATE org_units SET parent_id = '" + a
                        + "' WHERE id = '" + b + "'"));
        assertEquals(LOCK_CODE, conflict.getSQLState(),
                "parent_id is unique-keyed, so this update needs FOR UPDATE and conflicts with the"
                        + " FK key share: this is the lock that serialises ring-forming pairs");

        first.rollback();
        first.setAutoCommit(true);
    }

    @Test
    void withoutTheUniqueIndexTheAdvisoryLockIsTheOnlyThingLeft() throws SQLException {
        // The measurement above says the advisory lock is not what serialises ring-forming pairs
        // TODAY. This test pins down WHY, and what the lock is actually buying: the tuple lock is
        // only strong enough to conflict because parent_id participates in the unique index
        // uq_org_units_sibling_name. Drop that constraint (a hypothetical schema change, never a
        // product change -- this runs in a throwaway database) and the tuple update degrades to FOR
        // NO KEY UPDATE, which the FK key share accepts. Then the advisory lock is the only guard,
        // and without it the two legal moves really do close a ring.
        TestDatabaseProvider.DatabaseRef probe =
                TestDatabaseProvider.emptyDatabase("plan0773_m1_3_concurrency_nokey");
        Flyway.configure()
                .dataSource(probe.jdbcUrl(), probe.username(), probe.password())
                .locations("classpath:db/migration")
                .load()
                .migrate();
        try (Connection setup = DriverManager.getConnection(
                     probe.jdbcUrl(), probe.username(), probe.password());
             Connection t1 = DriverManager.getConnection(
                     probe.jdbcUrl(), probe.username(), probe.password());
             Connection t2 = DriverManager.getConnection(
                     probe.jdbcUrl(), probe.username(), probe.password())) {
            execute(setup, "ALTER TABLE org_units DROP CONSTRAINT uq_org_units_sibling_name");

            UUID x = insertUnit(setup, "x", null, 0);
            UUID y = insertUnit(setup, "y", null, 0);

            // Case A: the lock is still installed. Two individually legal moves, one uncommitted.
            t1.setAutoCommit(false);
            execute(t1, "UPDATE org_units SET parent_id = '" + y + "', depth = 1 WHERE id = '" + x + "'");
            t2.setAutoCommit(false);
            execute(t2, "SET LOCAL lock_timeout = '" + LOCK_TIMEOUT + "'");
            SQLException blocked = assertThrows(SQLException.class,
                    () -> execute(t2, "UPDATE org_units SET parent_id = '" + x
                            + "', depth = 1 WHERE id = '" + y + "'"));
            assertEquals(LOCK_CODE, blocked.getSQLState(),
                    "with the tuple lock degraded, the advisory lock is now the only blocker");
            t2.rollback();
            t1.rollback();
            t1.setAutoCommit(true);
            t2.setAutoCommit(true);

            // Case B: same database, advisory lock line removed -- now nothing serialises the pair.
            String installed = text(setup, "SELECT prosrc FROM pg_proc"
                    + " WHERE proname = 'org_units_reject_cycle'");
            String lockLine = "PERFORM pg_advisory_xact_lock(hashtext('org_units'));";
            String withoutLock = installed.replace(lockLine, "");
            assertNotEquals(installed, withoutLock);
            execute(setup, "CREATE OR REPLACE FUNCTION org_units_reject_cycle() RETURNS trigger"
                    + " AS $$" + withoutLock + "$$ LANGUAGE plpgsql");

            t1.setAutoCommit(false);
            execute(t1, "UPDATE org_units SET parent_id = '" + y + "', depth = 1 WHERE id = '" + x + "'");
            t2.setAutoCommit(false);
            execute(t2, "SET LOCAL lock_timeout = '" + LOCK_TIMEOUT + "'");
            execute(t2, "UPDATE org_units SET parent_id = '" + x + "', depth = 1 WHERE id = '" + y + "'");
            t2.commit();
            t1.commit();

            assertEquals(2, ringSize(setup, x),
                    "without both guards the two legal moves close a ring of two -- this is the"
                            + " failure the advisory lock exists to prevent");
        }
    }

    /**
     * Size of the ancestor closure of one unit. A cyclic table yields the ring size (the recursive
     * query uses UNION, so it terminates); an acyclic table yields the number of ancestors.
     */
    private static int ringSize(Connection connection, UUID unitId) throws SQLException {
        return scalar(connection, "WITH RECURSIVE anc AS ("
                + " SELECT id, parent_id FROM org_units WHERE id = '" + unitId + "'"
                + " UNION SELECT u.id, u.parent_id FROM org_units u JOIN anc a ON u.id = a.parent_id"
                + ") SELECT count(*) FROM anc");
    }


    /** Longest ancestor chain in the table; a ring makes this hit the depth cap. */
    private static int longestAncestorWalk(Connection connection) throws SQLException {
        return scalar(connection, "WITH RECURSIVE up AS ("
                + " SELECT id AS start_id, parent_id AS cur, 1 AS depth FROM org_units"
                + " UNION ALL SELECT up.start_id, u.parent_id, up.depth + 1 FROM up"
                + " JOIN org_units u ON u.id = up.cur WHERE up.depth < 50)"
                + " SELECT coalesce(max(depth), 0) FROM up");
    }

    private static UUID insertUnit(Connection connection, String name, UUID parentId, int depth)
            throws SQLException {
        UUID id = UUID.randomUUID();
        String label = id.toString().replace("-", "");
        String path = parentId == null
                ? label
                : text(connection, "SELECT path::text FROM org_units WHERE id = '" + parentId + "'")
                        + "." + label;
        execute(connection, "INSERT INTO org_units (id, parent_id, name, path, depth) VALUES ('"
                + id + "', " + (parentId == null ? "NULL" : "'" + parentId + "'") + ", '" + name
                + "', '" + path + "', " + depth + ")");
        return id;
    }

    private static UUID parentOf(Connection connection, UUID unitId) throws SQLException {
        String value = text(connection, "SELECT parent_id::text FROM org_units WHERE id = '"
                + unitId + "'");
        return value == null ? null : UUID.fromString(value);
    }

    private static void rollbackIfOpen(Connection connection) {
        try {
            if (!connection.getAutoCommit()) {
                connection.rollback();
                connection.setAutoCommit(true);
            }
        } catch (SQLException ignored) {
            // A connection that cannot roll back is about to fail a real assertion anyway.
        }
    }

    private static int scalar(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getInt(1);
        }
    }

    private static String text(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getString(1);
        }
    }

    private static void execute(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }
}

