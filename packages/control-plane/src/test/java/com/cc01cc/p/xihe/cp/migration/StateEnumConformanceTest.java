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
 * V9 (PLAN-0407 G2 Q1/Q2): zero additions to the state-machine enumerations — every state set must
 * equal the list frozen in the migration chain (V1–V44) or, for the one state machine without a DB
 * CHECK, the code-owned vocabulary.
 *
 * <p>The five state machines:</p>
 * <ol>
 *   <li>{@code ledger_operations.status} — CHECK {@code ck_ledger_operations_status} (V2, renamed by V33)</li>
 *   <li>{@code operation_items.status} — CHECK {@code ck_operation_items_status} (V2)</li>
 *   <li>{@code operation_attempts.status} — CHECK {@code ck_operation_attempts_status} (V2)</li>
 *   <li>{@code approval_requests.state} — CHECK {@code ck_approval_requests_state} (V1)</li>
 *   <li>{@code chat_runs.status} — no DB CHECK exists (V1 DDL); the vocabulary is code-owned, so it
 *       is asserted from the code constants that produce it. {@code sessions} has no status column
 *       at all (only {@code archived}), so it is not one of the five.</li>
 * </ol>
 *
 * <p>{@code grants.source}, {@code sessions.kind} and {@code chat_runs.origin} enumerations are
 * already asserted as exact sets by {@code SpecFieldConformanceTest}, and this class deliberately
 * does not duplicate them.</p>
 */
class StateEnumConformanceTest extends AbstractIntegrationTest {

    private static final Pattern QUOTED_VALUE = Pattern.compile("'([^']+)'");

    /** V2 {@code ck_session_operations_status} → {@code ck_ledger_operations_status} (V33 rename). */
    private static final Set<String> LEDGER_OPERATION_STATUSES = Set.of(
            "accepted", "running", "waiting_for_approval", "completed",
            "failed", "cancelled", "interrupted", "ambiguous");

    /** V2 {@code ck_operation_items_status}. */
    private static final Set<String> OPERATION_ITEM_STATUSES = Set.of(
            "pending", "running", "waiting_for_approval", "resolving", "completed",
            "failed", "aborted", "cancelled", "ambiguous");

    /** V2 {@code ck_operation_attempts_status}. */
    private static final Set<String> OPERATION_ATTEMPT_STATUSES = Set.of(
            "started", "succeeded", "failed", "timed_out", "cancelled", "unknown");

    /** V1 {@code ck_approval_requests_state}. */
    private static final Set<String> APPROVAL_STATES = Set.of(
            "pending", "dispatching", "approved", "rejected", "expired", "dispatch_unknown");

    /** Code-owned {@code chat_runs.status} vocabulary (design #6: no new run state was added). */
    private static final List<String> RUN_TERMINAL_STATUSES =
            List.of("succeeded", "partial", "failed", "cancelled", "ambiguous");

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void ledgerOperationStatusSetEqualsTheFrozenMigrationVocabulary() {
        assertEquals(LEDGER_OPERATION_STATUSES, checkAllowedValues("ck_ledger_operations_status"),
                "ledger_operations.status must keep exactly the V2/V33 value set");
    }

    @Test
    void operationItemStatusSetEqualsTheFrozenMigrationVocabulary() {
        assertEquals(OPERATION_ITEM_STATUSES, checkAllowedValues("ck_operation_items_status"),
                "operation_items.status must keep exactly the V2 value set");
    }

    @Test
    void operationAttemptStatusSetEqualsTheFrozenMigrationVocabulary() {
        assertEquals(OPERATION_ATTEMPT_STATUSES, checkAllowedValues("ck_operation_attempts_status"),
                "operation_attempts.status must keep exactly the V2 value set");
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
