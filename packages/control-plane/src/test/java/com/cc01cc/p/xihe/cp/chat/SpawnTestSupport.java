package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

import org.awaitility.core.ConditionTimeoutException;
import org.springframework.jdbc.core.JdbcTemplate;

import static org.awaitility.Awaitility.await;

/**
 * PLAN-0464 T2.1: shared spawn-test seeding for the execution-domain invocation
 * row that the spawn path now reads (the MCP gate creates it in production).
 */
final class SpawnTestSupport {

    /**
     * task-27 (task-221): upper bound for a chat run to reach a terminal status before
     * the fixtures are deleted. Aligned with the profile-wide 10s await budget used by
     * ChatIntegrationTest; a run that needs longer is a real defect, not slowness.
     */
    private static final Duration TERMINAL_WAIT = Duration.ofSeconds(10);

    /** task-27: sampling step for the post-terminal quiescence check. */
    private static final Duration QUIESCENCE_SAMPLE = Duration.ofMillis(250);

    /** task-27: upper bound for the quiescence check (after the terminal wait). */
    private static final Duration QUIESCENCE_BUDGET = Duration.ofSeconds(5);

    private SpawnTestSupport() {
    }

    static void seedAgentInvocation(McpInvocationRepository invocations, String sessionId, String runId,
                                    String workspaceId, String userId, String toolCallId, String toolName,
                                    String argumentsPreview) {
        McpInvocation invocation = new McpInvocation();
        invocation.setId(UUID.randomUUID());
        invocation.setSessionId(sessionId);
        invocation.setRunId(runId);
        invocation.setWorkspaceId(workspaceId);
        invocation.setUserId(userId);
        invocation.setToolCallId(toolCallId);
        invocation.setToolName(toolName);
        invocation.setSource(McpInvocation.SOURCE_AGENT);
        invocation.setStatus(McpInvocation.STATUS_ACTIVE);
        invocation.setArgumentsPreview(argumentsPreview);
        invocations.saveAndFlush(invocation);
    }

    /**
     * task-27 (task-221): delete the execution-domain rows of one workspace.
     *
     * <p>The three DELETEs below run as three autocommit statements, and
     * {@code mcp_dispatch_history.invocation_id} is a RESTRICT foreign key into
     * {@code mcp_invocations}. A chat run that is still converging writes its last
     * history transitions from the terminal path (and from the {@code afterCommit}
     * stranded-invocation sweep, {@code ChatRunTerminalService.settleStrandedInvocationsAfterCommit}),
     * so deleting without waiting re-created a row between statement 1 and statement 3:
     *
     * <pre>
     * DELETE FROM mcp_invocations ... violates foreign key constraint
     * "mcp_dispatch_history_invocation_id_fkey"
     * </pre>
     *
     * <p>The fix is to wait for the state that makes the delete safe, not to weaken the
     * constraint: {@code ON DELETE CASCADE}, {@code session_replication_role}, dropping the
     * FK or a retry loop would all hide a genuine "the run had not settled" race and let the
     * next test inherit the mess.
     *
     * <ol>
     *   <li>primary gate: no run of this workspace is in a non-terminal status
     *       (terminal set owned by {@link ChatRunRepository#TERMINAL_STATUSES});</li>
     *   <li>secondary gate: the three table counts for this workspace are identical across
     *       two consecutive {@link #QUIESCENCE_SAMPLE} samples, which covers the post-terminal
     *       asynchronous writers that do not update {@code chat_runs}.</li>
     * </ol>
     *
     * <p>Both gates fail loudly with a snapshot (run ids/statuses, table counts, newest
     * history rows) instead of retrying silently.
     */
    static void clearForWorkspace(McpInvocationRepository invocations, JdbcTemplate jdbc,
                                  String workspaceId) {
        awaitRunsSettled(jdbc, workspaceId);
        jdbc.update(
                "DELETE FROM mcp_dispatch_history WHERE invocation_id IN "
                        + "(SELECT id FROM mcp_invocations WHERE CAST(workspace_id AS VARCHAR) = ?)",
                workspaceId);
        jdbc.update(
                "DELETE FROM mcp_attempts WHERE invocation_id IN "
                        + "(SELECT id FROM mcp_invocations WHERE CAST(workspace_id AS VARCHAR) = ?)",
                workspaceId);
        jdbc.update("DELETE FROM mcp_invocations WHERE CAST(workspace_id AS VARCHAR) = ?", workspaceId);
    }

    private static void awaitRunsSettled(JdbcTemplate jdbc, String workspaceId) {
        String activeRunsSql = "SELECT COUNT(*) FROM chat_runs WHERE CAST(workspace_id AS VARCHAR) = ?"
                + " AND status NOT IN (" + placeholders(ChatRunRepository.TERMINAL_STATUSES) + ")";
        List<Object> args = new ArrayList<>();
        args.add(workspaceId);
        args.addAll(ChatRunRepository.TERMINAL_STATUSES);
        try {
            await().atMost(TERMINAL_WAIT).pollInterval(Duration.ofMillis(50))
                    .until(() -> count(jdbc, activeRunsSql, args) == 0);
        } catch (ConditionTimeoutException e) {
            throw new AssertionError("chat run did not reach a terminal status within " + TERMINAL_WAIT
                    + " before fixture cleanup; refusing to delete invocation rows that a live run may still "
                    + "reference (snapshot: " + snapshot(jdbc, workspaceId) + ")", e);
        }

        List<Long> previous = tableCounts(jdbc, workspaceId);
        long deadline = System.nanoTime() + QUIESCENCE_BUDGET.toNanos();
        while (System.nanoTime() < deadline) {
            try {
                Thread.sleep(QUIESCENCE_SAMPLE.toMillis());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AssertionError("interrupted while waiting for fixture quiescence", e);
            }
            List<Long> current = tableCounts(jdbc, workspaceId);
            if (current.equals(previous)) {
                return;
            }
            previous = current;
        }
        throw new AssertionError("execution-domain rows for workspace " + workspaceId
                + " never went quiet within " + QUIESCENCE_BUDGET
                + "; something is still writing after the run reached a terminal status"
                + " (snapshot: " + snapshot(jdbc, workspaceId) + ")");
    }

    private static String placeholders(List<String> values) {
        return String.join(", ", Collections.nCopies(values.size(), "?"));
    }

    private static long count(JdbcTemplate jdbc, String sql, List<Object> args) {
        Long value = jdbc.queryForObject(sql, Long.class, args.toArray());
        return value == null ? 0L : value;
    }

    /** history rows / attempts rows / invocations rows, in that order. */
    private static List<Long> tableCounts(JdbcTemplate jdbc, String workspaceId) {
        return List.of(
                count(jdbc, "SELECT COUNT(*) FROM mcp_dispatch_history WHERE invocation_id IN "
                        + "(SELECT id FROM mcp_invocations WHERE CAST(workspace_id AS VARCHAR) = ?)",
                        List.of(workspaceId)),
                count(jdbc, "SELECT COUNT(*) FROM mcp_attempts WHERE invocation_id IN "
                        + "(SELECT id FROM mcp_invocations WHERE CAST(workspace_id AS VARCHAR) = ?)",
                        List.of(workspaceId)),
                count(jdbc, "SELECT COUNT(*) FROM mcp_invocations WHERE CAST(workspace_id AS VARCHAR) = ?",
                        List.of(workspaceId)));
    }

    private static String snapshot(JdbcTemplate jdbc, String workspaceId) {
        List<String> runs = jdbc.query(
                "SELECT CAST(id AS VARCHAR) || '=' || status FROM chat_runs WHERE CAST(workspace_id AS VARCHAR) = ?"
                        + " ORDER BY created_at",
                (rs, rowNum) -> rs.getString(1), workspaceId);
        List<String> newestHistory = jdbc.query(
                "SELECT CAST(h.id AS VARCHAR) || ' event=' || h.event_type || ' to=' || COALESCE(h.to_status, '-')"
                        + " || ' at=' || h.created_at FROM mcp_dispatch_history h"
                        + " JOIN mcp_invocations i ON i.id = h.invocation_id"
                        + " WHERE CAST(i.workspace_id AS VARCHAR) = ? ORDER BY h.created_at DESC LIMIT 3",
                (rs, rowNum) -> rs.getString(1), workspaceId);
        return "runs=" + runs + ", counts(history,attempts,invocations)=" + tableCounts(jdbc, workspaceId)
                + ", newestHistory=" + newestHistory;
    }
}
