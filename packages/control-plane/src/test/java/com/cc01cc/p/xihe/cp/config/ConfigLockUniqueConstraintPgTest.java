package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-375: the "(domain, config_key) is unique" rule behind
 * {@link ConfigLockService#upsert}'s {@code catch (DataIntegrityViolationException)} lives in
 * PostgreSQL (V81 {@code uq_config_locks_key}), never in Java.
 *
 * <p>The H2 lane runs {@code create-drop} with Flyway off, so {@code ConfigLockServiceTest} can only
 * reach the <em>revision CAS</em> conflict in {@code ConfigLockAdminService}; the constraint-backed
 * branch had no coverage in any lane. This class pins the constraint itself: it exists, it rejects a
 * second row, it rejects the loser of a real two-connection race, and Spring surfaces that rejection
 * as exactly the exception type the service catch handles.
 *
 * <p>Mutation check (local only, never committed as a schema change): run with
 * {@code -Dxihe.task375.dropUnique=true} to drop the constraint in this class's own cloned database
 * before each test. The four constraint-side tests must then go red; the advisory-lock test stays
 * green because it exercises the application path, not the constraint.
 *
 * <p>Extends {@link AbstractIntegrationTest} rather than the reusable-context pilot base on purpose:
 * that base excludes classes with concurrency (its javadoc §4), and two of these tests race threads.
 */
class ConfigLockUniqueConstraintPgTest extends AbstractIntegrationTest {

    private static final String DOMAIN = "rag";
    private static final String CONSTRAINT = "uq_config_locks_key";
    private static final String INSERT =
            "INSERT INTO config_locks (id, domain, config_key, mode, reason, updated_by) "
                    + "VALUES (gen_random_uuid(), ?, ?, 'write_guard', 'task-375 probe', 'probe')";

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private DataSource dataSource;

    @Autowired
    private ConfigLockService lockService;

    @BeforeEach
    void optionallyDropTheConstraintForTheMutationRun() {
        if (Boolean.getBoolean("xihe.task375.dropUnique")) {
            jdbc.execute("ALTER TABLE config_locks DROP CONSTRAINT IF EXISTS " + CONSTRAINT);
            System.out.println("[P375-mutation] dropped " + CONSTRAINT + " in this class's database");
        }
    }

    @Test
    void theUniqueConstraintExistsOnDomainAndConfigKey() {
        Integer constraints = jdbc.queryForObject("""
                SELECT count(*) FROM pg_constraint
                WHERE conname = 'uq_config_locks_key' AND contype = 'u'
                  AND conrelid = 'config_locks'::regclass
                """, Integer.class);
        assertEquals(1, constraints, "V81 must leave a UNIQUE constraint named uq_config_locks_key");

        List<String> columns = jdbc.queryForList("""
                SELECT a.attname FROM pg_index i
                JOIN pg_class idx ON idx.oid = i.indexrelid
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                WHERE idx.relname = 'uq_config_locks_key'
                ORDER BY a.attnum
                """, String.class);
        assertEquals(List.of("domain", "config_key"), columns,
                "the uniqueness must cover exactly (domain, config_key)");
    }

    @Test
    void aSecondRowWithTheSameDomainAndKeyIsRejectedByTheConstraint() throws SQLException {
        String key = "t375-sequential";
        try (Connection connection = dataSource.getConnection()) {
            insert(connection, key);
            SQLException rejected = assertThrows(SQLException.class, () -> insert(connection, key));
            assertEquals("23505", rejected.getSQLState(), "unique_violation, not some other failure");
            assertTrue(rejected.getMessage().contains(CONSTRAINT),
                    "the rejection must name the constraint, got: " + rejected.getMessage());
        }
        assertEquals(1L, rowCount(key), "the second write must not have landed");
    }

    @Test
    void twoConcurrentInsertsLeaveOneRowAndTheLoserGetsAUniqueViolation() throws Exception {
        String key = "t375-race";
        CyclicBarrier start = new CyclicBarrier(2);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        List<Future<String>> outcomes = new ArrayList<>();
        try {
            for (int racer = 0; racer < 2; racer++) {
                outcomes.add(pool.submit(() -> {
                    try (Connection connection = dataSource.getConnection()) {
                        connection.setAutoCommit(false);
                        start.await(30, TimeUnit.SECONDS);
                        try {
                            insert(connection, key);
                            connection.commit();
                            return "committed";
                        } catch (SQLException failure) {
                            connection.rollback();
                            return failure.getSQLState();
                        }
                    }
                }));
            }
            List<String> results = new ArrayList<>();
            for (Future<String> outcome : outcomes) {
                results.add(outcome.get(60, TimeUnit.SECONDS));
            }
            System.out.println("[P375-race] outcomes=" + results);
            assertEquals(1, results.stream().filter("committed"::equals).count(),
                    "exactly one racer may commit, got " + results);
            assertEquals(1, results.stream().filter("23505"::equals).count(),
                    "the loser must be stopped by the unique constraint, got " + results);
        } finally {
            pool.shutdownNow();
        }
        assertEquals(1L, rowCount(key), "the race must leave exactly one row");
    }

    @Test
    void theRejectionSurfacesAsTheExceptionTypeTheServiceCatchHandles() throws SQLException {
        String key = "t375-translation";
        try (Connection connection = dataSource.getConnection()) {
            insert(connection, key);
        }
        DataIntegrityViolationException translated = assertThrows(DataIntegrityViolationException.class,
                () -> jdbc.update(INSERT, DOMAIN, key));
        Throwable root = translated.getMostSpecificCause();
        assertTrue(root instanceof SQLException, "expected a JDBC cause, got " + root);
        assertEquals("23505", ((SQLException) root).getSQLState());
        assertTrue(root.getMessage().contains(CONSTRAINT),
                "the translated failure must still name the constraint, got: " + root.getMessage());
    }

    @Test
    void concurrentServiceUpsertsKeepOneRowAndNeverEscapeAsAServerError() throws Exception {
        String key = "t375-service";
        int racers = 4;
        CyclicBarrier start = new CyclicBarrier(racers);
        ExecutorService pool = Executors.newFixedThreadPool(racers);
        List<Future<String>> outcomes = new ArrayList<>();
        try {
            for (int racer = 0; racer < racers; racer++) {
                String reason = "racer-" + racer;
                outcomes.add(pool.submit(() -> {
                    start.await(30, TimeUnit.SECONDS);
                    try {
                        ConfigLockService.LockView view =
                                lockService.upsert(DOMAIN, key, "write_guard", reason, "probe");
                        assertNotNull(view.id());
                        return "upserted";
                    } catch (CpApiException conflict) {
                        return conflict.getCode();
                    }
                }));
            }
            List<String> results = new ArrayList<>();
            for (Future<String> outcome : outcomes) {
                results.add(outcome.get(60, TimeUnit.SECONDS));
            }
            long conflicts = results.stream().filter("CONFIG_LOCK_CONFLICT"::equals).count();
            System.out.println("[P375-service] outcomes=" + results + " catchBranchHits=" + conflicts);
            for (String result : results) {
                assertTrue("upserted".equals(result) || "CONFIG_LOCK_CONFLICT".equals(result),
                        "a racing admin must get a lock or a 409, never a 500: " + result);
            }
        } finally {
            pool.shutdownNow();
        }
        assertEquals(1L, rowCount(key), "the advisory lock plus upsert must keep a single row");
    }

    private long rowCount(String key) {
        Long rows = jdbc.queryForObject(
                "SELECT count(*) FROM config_locks WHERE domain = ? AND config_key = ?",
                Long.class, DOMAIN, key);
        return rows == null ? 0L : rows;
    }

    private static void insert(Connection connection, String key) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.executeUpdate("INSERT INTO config_locks (id, domain, config_key, mode, reason, updated_by) "
                    + "VALUES (gen_random_uuid(), '" + DOMAIN + "', '" + key
                    + "', 'write_guard', 'task-375 probe', 'probe')");
        }
    }
}
