package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunTransportAttemptRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * task-105 (D-1869 ①): the Run read face must carry BOTH budget numbers plus the limits that make
 * the budget adjustable, and it must carry the accounting value honestly.
 *
 * <p>The three claims under test are the card's criteria:
 * <ol>
 *   <li>field presence — {@code tokenCount}, {@code budgetConsumed}, {@code runMaxTokens},
 *       {@code runMaxTokensCeiling}, {@code budgetAccounting} are all on one response;</li>
 *   <li>NULL semantics — a historical Run ({@code chat_runs.budget_consumed IS NULL}) yields
 *       {@code null}, and specifically not {@code 0};</li>
 *   <li>durable equality — both numbers equal the {@code chat_runs} columns field-by-field, with
 *       {@code tokenCount} keeping its real-cumulative meaning even when it disagrees with the
 *       accounting charge.</li>
 * </ol>
 */
class ChatRunBudgetViewTest {

    private static final String RUN_ID = "33333333-3333-4333-8333-333333333333";
    private static final String SESSION_ID = "44444444-4444-4444-8444-444444444444";
    private static final String USER_ID = "55555555-5555-4555-8555-555555555555";
    private static final String WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";

    private final ChatRunRepository runs = mock(ChatRunRepository.class);
    private final ApprovalService approvals = mock(ApprovalService.class);
    private final ConfigService config = mock(ConfigService.class);
    private final ChatRunReadService service = new ChatRunReadService(
            runs,
            mock(ChatRunTransportAttemptRepository.class),
            approvals,
            mock(MessageRepository.class),
            config);

    /** A durable {@code chat_runs} row, not a hand-built response stub. */
    private ChatRun durableRow() {
        ChatRun run = new ChatRun();
        run.setId(UUID.fromString(RUN_ID));
        run.setSessionId(SESSION_ID);
        run.setUserId(USER_ID);
        run.setWorkspaceId(WORKSPACE_ID);
        run.setOrigin("user_submission");
        run.setStatus("running");
        run.setTokenCount(1234);
        run.setBudgetConsumed(900);
        return run;
    }

    private void serve(ChatRun run) {
        when(runs.findById(run.getId())).thenReturn(Optional.of(run));
        when(approvals.findActiveForRun(RUN_ID, USER_ID, WORKSPACE_ID)).thenReturn(List.of());
    }

    private void serveRuntimeConfig(Map<String, String> entries) {
        when(config.effective(ChatRunReadService.AGENT_RUNTIME_DOMAIN,
                UUID.fromString(USER_ID), UUID.fromString(WORKSPACE_ID)))
                .thenReturn(new ConfigService.EffectiveConfig(
                        ChatRunReadService.AGENT_RUNTIME_DOMAIN, "rev-1", "user", entries));
    }

    private Map<String, Object> status() {
        return service.getStatus(UUID.fromString(RUN_ID), RUN_ID, USER_ID, WORKSPACE_ID);
    }

    @Test
    void bothNumbersAndAllThreeLimitFieldsRideOnOneResponse() {
        ChatRun run = durableRow();
        serve(run);
        serveRuntimeConfig(Map.of(
                "runMaxTokens", "500000",
                "runMaxTokensCeiling", "1000000",
                "budgetAccounting", "growth"));

        Map<String, Object> body = status();

        for (String field : List.of("tokenCount", "budgetConsumed", "runMaxTokens",
                "runMaxTokensCeiling", "budgetAccounting")) {
            assertTrue(body.containsKey(field), "the run view must carry " + field + ": " + body.keySet());
        }
        assertEquals(1234, body.get("tokenCount"));
        assertEquals(900, body.get("budgetConsumed"));
        assertEquals(500000L, body.get("runMaxTokens"));
        assertEquals(1000000L, body.get("runMaxTokensCeiling"));
        assertEquals("growth", body.get("budgetAccounting"));
    }

    @Test
    void bothNumbersEqualTheDurableRowFieldByField() {
        ChatRun run = durableRow();
        // A provider that counts cache reads plus a fail-open charge make the two numbers differ
        // on purpose; the view must reproduce both columns, never reconcile them into one.
        run.setTokenCount(4096);
        run.setBudgetConsumed(2500);
        serve(run);
        serveRuntimeConfig(Map.of(
                "runMaxTokens", "500000",
                "runMaxTokensCeiling", "1000000",
                "budgetAccounting", "cumulative"));

        Map<String, Object> body = status();

        assertEquals(run.getTokenCount(), body.get("tokenCount"),
                "tokenCount must be chat_runs.token_count, unchanged in meaning");
        assertEquals(run.getBudgetConsumed(), body.get("budgetConsumed"),
                "budgetConsumed must be chat_runs.budget_consumed, the stored charge");
        assertFalse(body.get("tokenCount").equals(body.get("budgetConsumed")),
                "the two numbers are different questions and must not be collapsed");
        assertEquals("cumulative", body.get("budgetAccounting"));
    }

    @Test
    void historicalRowWithNullBudgetConsumedReturnsNullAndNeverZero() {
        ChatRun historical = durableRow();
        // The card's counter-example: budget_consumed IS NULL (V174: NULL is the honest value).
        historical.setBudgetConsumed(null);
        serve(historical);
        serveRuntimeConfig(Map.of("runMaxTokens", "500000", "runMaxTokensCeiling", "1000000"));

        Map<String, Object> body = status();

        assertTrue(body.containsKey("budgetConsumed"),
                "the field is present even when unrecorded — a missing key is not the same fact");
        assertNull(body.get("budgetConsumed"), "a historical Run reports null (not recorded)");
        assertFalse(body.get("budgetConsumed") instanceof Integer,
                "null must not be coerced into 0: 0 is a real charge of nothing");
        assertEquals(1234, body.get("tokenCount"),
                "the real token total is still reported when the accounting value is unknown");
    }

    @Test
    void limitsFollowTheEffectiveAgentRuntimeScope() {
        serve(durableRow());
        serveRuntimeConfig(Map.of(
                "runMaxTokens", "120000",
                "runMaxTokensCeiling", "1000000",
                "budgetAccounting", "cumulative"));

        Map<String, Object> body = status();

        assertEquals(120000L, body.get("runMaxTokens"), "the configured cap must be visible as-is");
        assertEquals(1000000L, body.get("runMaxTokensCeiling"), "the ceiling must be visible next to it");
        assertEquals("cumulative", body.get("budgetAccounting"), "the accounting basis must be visible");
    }

    @Test
    void unparsableLimitsAreNullAndZeroStaysARealValue() {
        ChatRun run = durableRow();
        serve(run);
        serveRuntimeConfig(Map.of(
                "runMaxTokens", "not-a-number",
                "runMaxTokensCeiling", "0",
                "budgetAccounting", "growth"));

        Map<String, Object> body = status();

        assertNull(body.get("runMaxTokens"), "an unusable configured value is unknown, not 0");
        assertEquals(0L, body.get("runMaxTokensCeiling"),
                "0 is the documented 'no ceiling' value and must survive as 0");
    }
}
