package com.cc01cc.p.xihe.cp.support;

import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.SQLException;
import java.util.List;

/**
 * PLAN-0710: deterministic, deadlock-tolerant cleanup for workspace-scoped CP test fixtures.
 *
 * <p><b>Why:</b> integration classes run async chat/spawn threads whose cascades touch
 * {@code sessions}/{@code chat_runs} while {@code @AfterEach} deletes the same workspace. Two
 * different lock orders (and the stale {@code CAST(workspace_id AS VARCHAR)} predicates) make
 * PostgreSQL pick a deadlock victim in full-suite runs even though a single class is green.</p>
 *
 * <p><b>Contract:</b> children before parents in a fixed order; the UUID column is compared with
 * {@code IS NOT DISTINCT FROM CAST(? AS UUID)} (index-friendly, no VARCHAR cast); a
 * {@code 40P01 deadlock_detected} victim is retried at most twice with 50/150 ms backoff. This is
 * test infrastructure only — no production code depends on it.</p>
 */
public final class TestWorkspaceCleanup {

    private static final int MAX_RETRIES = 2;
    private static final long[] BACKOFF_MS = {50L, 150L};

    /** Child tables first: chat_runs points at sessions, never the other way around. */
    private static final List<String> TABLES_IN_ORDER = List.of("chat_runs", "sessions");

    private TestWorkspaceCleanup() {
    }

    /**
     * Deletes the workspace's chat runs and sessions (in that fixed order) using the deadlock retry
     * policy. Rethrows the last failure when the retries are exhausted.
     */
    public static void deleteWorkspaceData(JdbcTemplate jdbc, String workspaceId) {
        if (workspaceId == null || workspaceId.isBlank()) {
            return;
        }
        for (String table : TABLES_IN_ORDER) {
            executeWithDeadlockRetry(jdbc,
                    "DELETE FROM " + table
                            + " WHERE workspace_id IS NOT DISTINCT FROM CAST(? AS UUID)",
                    workspaceId);
        }
    }

    /** Deadlock retry for any workspace-cleanup statement (same policy as above). */
    public static void executeWithDeadlockRetry(JdbcTemplate jdbc, String sql, Object... args) {
        DataAccessException last = null;
        for (int attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                jdbc.update(sql, args);
                return;
            } catch (DataAccessException failure) {
                last = failure;
                if (!isDeadlock(failure) || attempt == MAX_RETRIES) {
                    throw failure;
                }
                backoff(attempt, failure);
            }
        }
        throw last;
    }

    private static boolean isDeadlock(DataAccessException failure) {
        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
            if (cause instanceof SQLException sql && "40P01".equals(sql.getSQLState())) {
                return true;
            }
        }
        return false;
    }

    private static void backoff(int attempt, DataAccessException failure) {
        long millis = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw failure;
        }
    }
}
