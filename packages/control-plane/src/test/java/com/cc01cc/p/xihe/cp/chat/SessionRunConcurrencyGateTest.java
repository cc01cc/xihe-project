package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.UserQuestionRepository;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

/**
 * PLAN-0645 D45-01: the per-Session run cap is a config-driven resource valve with a strict
 * fallback ladder (default 2, valid 1–4) and a Session-locked, count-based admission gate.
 *
 * <p>task-161 / D-1786 面 A rewrote what the count counts: waiting-for-human Runs (pending user
 * question or live approval) hold no execution slot, while parked (queued-for-resume) Runs do
 * count as virtual slots so a queued resume cannot be jumped. See evidence
 * {@code 2026-11-17-candidate-a-admission-cost/README.md §7} for the formal model.</p>
 */
class SessionRunConcurrencyGateTest {

    private static final String SESSION_ID = "11111111-1111-1111-1111-111111111111";
    private static final String RUN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    private static final String RUN_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    private static final String RUN_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

    private final ChatRunRepository runs = Mockito.mock(ChatRunRepository.class);
    private final UserQuestionRepository questions = Mockito.mock(UserQuestionRepository.class);
    private final ChatApprovalRepository approvals = Mockito.mock(ChatApprovalRepository.class);
    private final ConfigService config = Mockito.mock(ConfigService.class);
    private final RunDispatchQueue dispatchQueue = new RunDispatchQueue();

    private SessionRunConcurrencyGate gate() {
        return new SessionRunConcurrencyGate(runs, questions, approvals, dispatchQueue, config);
    }

    private void configuredCap(String value) {
        when(config.resolve(eq(SessionRunConcurrencyGate.CONFIG_DOMAIN),
                eq(SessionRunConcurrencyGate.CONFIG_KEY), any(), any())).thenReturn(value);
    }

    private ChatRun run(String runId, String status) {
        return new ChatRun(runId, SESSION_ID, "user-1", "ws-1", "idem-" + runId, "hash",
                "openai", "model", "workspace", status);
    }

    /** Stubs the non-terminal set the gate counts; waiting-ness comes from the two side tables. */
    private void nonTerminalRuns(ChatRun... runsOfSession) {
        when(this.runs.findBySessionIdAndStatusIn(eq(SESSION_ID), any()))
                .thenReturn(List.of(runsOfSession));
    }

    private void waitingOnQuestion(String runId) {
        when(questions.existsByRunIdAndState(UUID.fromString(runId), "pending")).thenReturn(true);
    }

    private void waitingOnApproval(String runId) {
        ChatApproval live = new ChatApproval();
        when(approvals.findByRunIdAndStateIn(eq(runId), any())).thenReturn(List.of(live));
    }

    // ---------------------------------------------------------------------------------------
    // The cap NUMBER is untouched by this card (D-1798).
    // ---------------------------------------------------------------------------------------

    @Test
    void defaultsToTwoWhenTheKeyIsUnset() {
        configuredCap(null);
        assertEquals(2, gate().maxConcurrentRuns());
    }

    @Test
    void acceptsEveryValueInsideTheSchemaRange() {
        for (String value : List.of("1", "2", "3", "4")) {
            configuredCap(value);
            assertEquals(Integer.parseInt(value), gate().maxConcurrentRuns(), "value " + value);
        }
    }

    @Test
    void invalidOrOutOfRangeValuesFallBackToTheDefault() {
        for (String value : List.of("0", "5", "-1", "abc", "  ")) {
            configuredCap(value);
            assertEquals(2, gate().maxConcurrentRuns(), "value " + value);
        }
    }

    @Test
    void unreadableConfigFallsBackToTheDefault() {
        when(config.resolve(eq(SessionRunConcurrencyGate.CONFIG_DOMAIN),
                eq(SessionRunConcurrencyGate.CONFIG_KEY), any(), any()))
                .thenThrow(new IllegalStateException("config store unavailable"));
        assertEquals(2, gate().maxConcurrentRuns());
    }

    // ---------------------------------------------------------------------------------------
    // 面 A：等待中的 run 不再占准入槽
    // ---------------------------------------------------------------------------------------

    @Test
    void waitingRunsDoNotConsumeAdmissionSlots() {
        configuredCap("2");
        nonTerminalRuns(run(RUN_A, "running"), run(RUN_B, "running"), run(RUN_C, "running"));
        // 两个在等答案、一个在等审批：都不是「在执行」。
        waitingOnQuestion(RUN_B);
        waitingOnApproval(RUN_C);

        assertEquals(1, gate().admissionOccupancy(SESSION_ID));
        assertDoesNotThrow(() -> gate().requireSlot(SESSION_ID),
                "a session with 1 executing + 2 waiting runs must still admit");
    }

    @Test
    void awaitingApprovalStatusItselfCountsAsWaiting() {
        configuredCap("2");
        nonTerminalRuns(run(RUN_A, "running"), run(RUN_B, "awaiting_approval"));

        assertEquals(1, gate().admissionOccupancy(SESSION_ID));
        assertTrue(gate().hasSlot(SESSION_ID));
    }

    @Test
    void executingRunsStillHitTheCap() {
        configuredCap("2");
        nonTerminalRuns(run(RUN_A, "running"), run(RUN_B, "streaming"));

        assertEquals(2, gate().admissionOccupancy(SESSION_ID));
        CpApiException error = assertThrows(CpApiException.class,
                () -> gate().requireSlot(SESSION_ID));
        assertEquals("CHAT_IN_PROGRESS", error.getCode());
        assertTrue(error.getMessage().contains("2"), "the refusal names the cap: " + error.getMessage());
        assertFalse(gate().hasSlot(SESSION_ID));
    }

    // ---------------------------------------------------------------------------------------
    // 面 B：parked 是虚拟槽（不可插队），恢复闸只看执行数
    // ---------------------------------------------------------------------------------------

    @Test
    void parkedRunsBlockAdmissionSoTheQueueCannotBeJumped() {
        configuredCap("2");
        nonTerminalRuns(run(RUN_A, "running"), run(RUN_B, "queued"));
        dispatchQueue.park(new RunDispatchQueue.Entry(RUN_B, SESSION_ID, java.time.Instant.now(),
                new RunDispatchQueue.QuestionResume(RUN_B, SESSION_ID, "q-1", "answer")));

        // 1 executing + 1 parked = 2 = cap ⇒ 新消息被拒（parked 项占了虚拟槽）。
        assertEquals(2, gate().admissionOccupancy(SESSION_ID));
        assertThrows(CpApiException.class, () -> gate().requireSlot(SESSION_ID));
        // 但执行预算只被 1 占用：parked 不执行。
        assertEquals(1, gate().executingCount(SESSION_ID));
    }

    @Test
    void aQueuedRunWithoutQueueMembershipIsNotParked() {
        configuredCap("2");
        // 'queued' 也可能是「已准入、未派发」的新 run（ChatController.persistRunStatus），
        // 那种 run 不是 parked，仍计入准入占用但不计入执行数。
        nonTerminalRuns(run(RUN_A, "queued"));

        assertEquals(1, gate().admissionOccupancy(SESSION_ID));
        assertEquals(1, gate().executingCount(SESSION_ID), "not parked ⇒ counted as executing");
    }

    @Test
    void canResumeExcludesTheResumingRunItself() {
        configuredCap("2");
        nonTerminalRuns(run(RUN_A, "running"), run(RUN_B, "running"), run(RUN_C, "running"));
        // 三个都在执行：C 想恢复，除它之外还有 2 个 ⇒ 到 cap，不许。
        assertFalse(gate().canResume(SESSION_ID, RUN_C));

        // B 变成等待态后，C 之外只剩 1 个执行 ⇒ 可以恢复。
        waitingOnApproval(RUN_B);
        assertTrue(gate().canResume(SESSION_ID, RUN_C));
    }

    @Test
    void canResumeIgnoresParkedRuns() {
        configuredCap("1");
        nonTerminalRuns(run(RUN_A, "running"), run(RUN_B, "queued"));
        dispatchQueue.park(new RunDispatchQueue.Entry(RUN_B, SESSION_ID, java.time.Instant.now(),
                new RunDispatchQueue.QuestionResume(RUN_B, SESSION_ID, "q-1", "answer")));

        // parked 不执行 ⇒ A 之外执行者为 0：A 本身可恢复判定为真（它就是被闸的那个 run）。
        assertTrue(gate().canResume(SESSION_ID, RUN_A));
        // B 若在队列里想恢复：除它之外 A 在执行，cap=1 ⇒ 不许。
        assertFalse(gate().canResume(SESSION_ID, RUN_B));
    }

    @Test
    void capOneRejectsTheSecondInFlightRun() {
        configuredCap("1");
        nonTerminalRuns(run(RUN_A, "running"));

        CpApiException error = assertThrows(CpApiException.class,
                () -> gate().requireSlot(SESSION_ID));

        assertEquals("CHAT_IN_PROGRESS", error.getCode());
    }
}
