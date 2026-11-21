package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-85: the tree-wide row-lock order is <b>every Session row before every chat_runs row</b>.
 *
 * <p>Why this test exists: {@code DelegationChainWalkIntegrationTest} used to deadlock
 * ({@code SQLSTATE 40P01}, statement {@code select ... from sessions ... for no key update}) on the
 * spawn path. The cause was two transactions with opposite orders over the same two rows:
 * <ul>
 *   <li><b>wake path</b> — {@code WakeDispatchService#refuseBrokenChain} locked the parent
 *       {@code chat_runs} row and only later asked for the child {@code sessions} row (through the
 *       context-event sequence lock in {@code EventStoreService#lockSessionForSequence});</li>
 *   <li><b>terminal path</b> — {@code ChatRunTerminalService#terminalize} locks the Session row
 *       first and the {@code chat_runs} row second (and its spawn branch even locked the parent Run
 *       before the child Session).</li>
 * </ul>
 * Both sides now take Session rows first. The SQL-level cases below are the deterministic
 * demonstration; the source-order case is the tripwire that fails if either production method is
 * reordered back.
 *
 * <p>Deterministic by construction: two independent connections, a {@link CyclicBarrier} so each
 * side provably holds its first lock before either sends its second statement. No load generation,
 * no sleep, no retry — a deadlock here is PostgreSQL's own detector, not a timing guess.
 */
class ChatRunSessionLockOrderIntegrationTest {

    private static final String CHAT_RUN_LOCK =
            "select id from chat_runs where id = ? for no key update";
    private static final String SESSION_LOCK =
            "select id from sessions where id = ? for update";

    private static String url;
    private static String user;
    private static String password;
    private static UUID sessionId;
    private static UUID runId;

    @BeforeAll
    static void fixture() throws Exception {
        TestDatabaseProvider.DatabaseRef db = TestDatabaseProvider.migratedDatabase("lockorder2");
        url = db.jdbcUrl();
        user = db.username();
        password = db.password();
        UUID userId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        sessionId = UUID.randomUUID();
        runId = UUID.randomUUID();
        UUID branchId = UUID.randomUUID();
        try (Connection c = open(); Statement s = c.createStatement()) {
            s.execute("insert into users (id, email, password_hash, username) values ('" + userId
                    + "', 'lockorder2@example.test', 'x', 'lockorder2')");
            s.execute("insert into workspaces (id, name) values ('" + workspaceId + "', 'lock order 2')");
            s.execute("insert into sessions (id, workspace_id, user_id) values ('" + sessionId
                    + "', '" + workspaceId + "', '" + userId + "')");
            s.execute("insert into session_branches (id, session_id) values ('" + branchId
                    + "', '" + sessionId + "')");
            s.execute("insert into chat_runs (id, session_id, user_id, workspace_id, idempotency_key,"
                    + " request_hash, status, origin, branch_id) values ('" + runId + "', '" + sessionId + "', '"
                    + userId + "', '" + workspaceId + "', 'lock-order-2', 'hash', 'running', 'user_submission', '"
                    + branchId + "')");
        }
    }

    /**
     * The <b>historical</b> orders (run → session vs session → run) still deadlock. This case
     * documents the mechanism the fix removes: if PostgreSQL ever stopped detecting it, the
     * demonstration below would stop proving anything, so it asserts 40P01 rather than silence.
     */
    @Test
    void historicalOrderStillDeadlocks() throws Exception {
        List<String> outcomes = race(
                ChatRunSessionLockOrderIntegrationTest::lockChatRun,
                ChatRunSessionLockOrderIntegrationTest::lockSession,
                ChatRunSessionLockOrderIntegrationTest::lockSession,
                ChatRunSessionLockOrderIntegrationTest::lockChatRun,
                true);
        System.out.println("[lock-order] historical order outcomes = " + outcomes);
        assertTrue(outcomes.stream().anyMatch(o -> o.startsWith("40P01")),
                "expected PostgreSQL deadlock (SQLSTATE 40P01) for the historical orders, got: " + outcomes);
    }

    /**
     * The shipped order — Session row, then {@code chat_runs} row, on both sides — serializes: each
     * side holds only the row it was granted and waits for the other, so no cycle can form.
     */
    @Test
    void shippedOrderSerializesWithoutDeadlock() throws Exception {
        List<String> outcomes = race(
                ChatRunSessionLockOrderIntegrationTest::lockSession,
                ChatRunSessionLockOrderIntegrationTest::lockSession,
                ChatRunSessionLockOrderIntegrationTest::lockChatRun,
                ChatRunSessionLockOrderIntegrationTest::lockChatRun,
                false);
        System.out.println("[lock-order] shipped order outcomes = " + outcomes);
        assertFalse(outcomes.stream().anyMatch(o -> o.startsWith("40P01")),
                "shipped lock order must not deadlock, got: " + outcomes);
        assertTrue(outcomes.stream().allMatch("OK"::equals),
                "both halves must finish, got: " + outcomes);
    }

    /**
     * Source-order tripwire: the two production methods that form the cycle must keep Session rows
     * ahead of {@code chat_runs} rows. Fails with the offending file when someone reorders them —
     * the SQL cases above cannot see that, because they only model the order this test writes down.
     */
    @Test
    void productionLocksSessionRowsBeforeRunRows() throws IOException {
        String wake = source("service/WakeDispatchService.java");
        int wakeSession = wake.indexOf("sessionRepository.findByIdForUpdate(sessionId)");
        int wakeRun = wake.indexOf("chatRunRepository.findByIdForUpdate(parentRunId)");
        assertTrue(wakeSession >= 0 && wakeRun >= 0,
                "WakeDispatchService must lock the Session row before the parent chat_runs row");
        assertTrue(wakeSession < wakeRun,
                "WakeDispatchService#refuseBrokenChain must lock sessions before chat_runs (task-85)");

        String terminal = source("chat/ChatRunTerminalService.java");
        int spawnChildSession = terminal.indexOf("sessions.findByIdForUpdate(childSessionLocator.getId())");
        int parentRun = terminal.indexOf("chatRuns.findByIdForUpdate(parentRunId)");
        int mainChildSession = terminal.indexOf("sessions.findByIdForUpdate(sessionId)");
        int mainChildRun = terminal.indexOf("chatRuns.findByIdForUpdate(runId)");
        assertTrue(spawnChildSession >= 0 && parentRun >= 0 && mainChildSession >= 0 && mainChildRun >= 0,
                "ChatRunTerminalService must keep both Session locks and both chat_runs locks");
        assertTrue(spawnChildSession < parentRun,
                "spawn branch must lock the child Session before the parent Run (task-85)");
        assertTrue(mainChildSession < mainChildRun,
                "main branch must lock the Session before the Run (task-85)");
    }

    private static String source(String relativePath) throws IOException {
        Path path = Path.of("src/main/java/com/cc01cc/p/xihe/cp", relativePath);
        assertTrue(Files.exists(path),
                "source file not found from the module directory: " + path.toAbsolutePath());
        return Files.readString(path, StandardCharsets.UTF_8);
    }

    private static void lockChatRun(Connection c) throws SQLException {
        try (var ps = c.prepareStatement(CHAT_RUN_LOCK)) {
            ps.setObject(1, runId);
            ps.executeQuery().close();
        }
    }

    private static void lockSession(Connection c) throws SQLException {
        try (var ps = c.prepareStatement(SESSION_LOCK)) {
            ps.setObject(1, sessionId);
            ps.executeQuery().close();
        }
    }

    private interface SqlStep {
        void run(Connection c) throws SQLException;
    }

    /**
     * Each side runs in its own transaction: both execute their {@code first} step, meet on the
     * barrier (only when the two first steps touch different rows — otherwise the second caller
     * would simply queue and the barrier could never complete), then run the second step.
     */
    private static List<String> race(SqlStep firstA, SqlStep firstB, SqlStep secondA, SqlStep secondB,
                                     boolean barrierBeforeSecond) throws Exception {
        List<String> outcomes = Collections.synchronizedList(new ArrayList<>());
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CyclicBarrier bothHoldFirstLock = new CyclicBarrier(2);
        List<Future<?>> halves = new ArrayList<>();
        for (boolean sideA : new boolean[] {true, false}) {
            halves.add(pool.submit(() -> {
                try (Connection c = open()) {
                    c.setAutoCommit(false);
                    (sideA ? firstA : firstB).run(c);
                    if (barrierBeforeSecond) {
                        bothHoldFirstLock.await(30, TimeUnit.SECONDS);
                    }
                    (sideA ? secondA : secondB).run(c);
                    c.commit();
                    outcomes.add("OK");
                } catch (SQLException failure) {
                    outcomes.add(failure.getSQLState() + " " + String.valueOf(failure.getMessage()).split("\n")[0]);
                } catch (Exception other) {
                    outcomes.add("ERR " + other);
                }
                return null;
            }));
        }
        for (Future<?> half : halves) {
            half.get(120, TimeUnit.SECONDS);
        }
        pool.shutdownNow();
        return outcomes;
    }

    private static Connection open() throws SQLException {
        return DriverManager.getConnection(url, user, password);
    }
}
