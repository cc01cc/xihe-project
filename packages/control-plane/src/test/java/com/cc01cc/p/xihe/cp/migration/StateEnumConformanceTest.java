package com.cc01cc.p.xihe.cp.migration;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.chat.ChatRunCancellationService;
import com.cc01cc.p.xihe.cp.chat.ChatRunTerminalService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

import java.lang.reflect.Method;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Zero additions to the active domain state enumerations — every state set must
 * equal the list frozen in the migration chain or, for the run state machine without a DB
 * CHECK, the code-owned vocabulary.
 *
 * <p>The current state machines:</p>
 * <ol>
 *   <li>{@code workspace_jobs.status} — CHECK {@code ck_workspace_jobs_status} (V53)</li>
 *   <li>{@code mcp_invocations.status} — CHECK {@code ck_mcp_invocations_status} (V50)</li>
 *   <li>{@code mcp_attempts.status} — CHECK {@code ck_mcp_attempts_status} (V50)</li>
 *   <li>{@code approval_requests.state} — CHECK {@code ck_approval_requests_state} (V1)</li>
 *   <li>{@code chat_runs.status} — no DB CHECK exists; the vocabulary is code-owned.</li>
 * </ol>
 *
 * <p>{@code grants.source}, {@code sessions.kind} and {@code chat_runs.origin} enumerations are
 * already asserted as exact sets by {@code SpecFieldConformanceTest}, and this class deliberately
 * does not duplicate them.</p>
 */
class StateEnumConformanceTest extends AbstractIntegrationTest {

    private static final Pattern QUOTED_VALUE = Pattern.compile("'([^']+)'");

    private static final Set<String> WORKSPACE_JOB_STATUSES = Set.of(
            "pending", "running", "succeeded", "cancelled", "timeout", "orphaned", "interrupted");
    private static final Set<String> MCP_INVOCATION_STATUSES = Set.of(
            "active", "completed", "failed", "unknown", "cancelled");
    private static final Set<String> MCP_ATTEMPT_STATUSES = Set.of(
            "started", "succeeded", "failed", "timed_out", "cancelled", "unknown", "late_confirmed");

    /** V1 {@code ck_approval_requests_state}. */
    private static final Set<String> APPROVAL_STATES = Set.of(
            "pending", "dispatching", "approved", "rejected", "expired", "dispatch_unknown");

    /** Code-owned {@code chat_runs.status} vocabulary (design #6: no new run state was added). */
    private static final List<String> RUN_TERMINAL_STATUSES =
            List.of("succeeded", "partial", "failed", "cancelled", "ambiguous");

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void workspaceJobStatusSetEqualsTheFrozenMigrationVocabulary() {
        assertEquals(WORKSPACE_JOB_STATUSES, checkAllowedValues("ck_workspace_jobs_status"),
                "workspace_jobs.status must keep exactly the V53 value set");
    }

    @Test
    void mcpInvocationStatusSetEqualsTheFrozenMigrationVocabulary() {
        assertEquals(MCP_INVOCATION_STATUSES, checkAllowedValues("ck_mcp_invocations_status"),
                "mcp_invocations.status must keep exactly the V50 value set");
    }

    @Test
    void mcpAttemptStatusSetEqualsTheFrozenMigrationVocabulary() {
        assertEquals(MCP_ATTEMPT_STATUSES, checkAllowedValues("ck_mcp_attempts_status"),
                "mcp_attempts.status must keep exactly the V50 value set");
    }

    @Test
    void approvalStateSetEqualsTheFrozenMigrationVocabulary() {
        assertEquals(APPROVAL_STATES, checkAllowedValues("ck_approval_requests_state"),
                "approval_requests.state must keep exactly the V1 value set");
    }

    @Test
    @SuppressWarnings("unchecked")
    void chatRunStatusVocabularyIsUnchangedInCodeAndCarriesNoDbCheck() {
        Integer statusChecks = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM pg_constraint WHERE conrelid = 'chat_runs'::regclass "
                        + "AND pg_get_constraintdef(oid) LIKE '%status%'",
                Integer.class);
        assertEquals(0, statusChecks == null ? 0 : statusChecks,
                "chat_runs.status has no DB CHECK — the vocabulary is enforced in code only");

        assertEquals(List.of("accepted", "queued", "running", "streaming", "awaiting_approval",
                        "dispatching"),
                ChatRunRepository.ACTIVE_LEASE_STATUSES,
                "the lease-active run status set must not gain a value");

        List<String> nonTerminal = (List<String>) ReflectionTestUtils.getField(
                ChatRunCancellationService.class, "NON_TERMINAL_STATUSES");
        assertEquals(List.of("accepted", "queued", "running", "streaming", "awaiting_approval",
                        "dispatching", "cancelling"),
                nonTerminal,
                "the non-terminal run status set must not gain a value");

        Method isTerminal;
        try {
            isTerminal = ChatRunTerminalService.class.getDeclaredMethod("isTerminal", String.class);
            isTerminal.setAccessible(true);
        } catch (NoSuchMethodException e) {
            throw new AssertionError("ChatRunTerminalService.isTerminal(String) no longer exists", e);
        }
        for (String status : RUN_TERMINAL_STATUSES) {
            assertTrue(invokeBoolean(isTerminal, status), status + " must stay terminal");
        }
        for (String status : nonTerminal) {
            assertFalse(invokeBoolean(isTerminal, status), status + " must stay non-terminal");
        }
    }

    private static Boolean invokeBoolean(Method method, String status) {
        try {
            return (Boolean) method.invoke(null, status);
        } catch (ReflectiveOperationException e) {
            throw new AssertionError("isTerminal(" + status + ") could not be evaluated", e);
        }
    }

    /** The exact value set of a CHECK constraint, parsed from {@code pg_get_constraintdef}. */
    private Set<String> checkAllowedValues(String constraintName) {
        List<String> definitions = jdbcTemplate.queryForList(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = ?",
                String.class, constraintName);
        if (definitions.isEmpty()) {
            throw new AssertionError("missing CHECK constraint: " + constraintName);
        }
        Set<String> values = new LinkedHashSet<>();
        Matcher matcher = QUOTED_VALUE.matcher(definitions.get(0));
        while (matcher.find()) {
            values.add(matcher.group(1));
        }
        return values;
    }
}
