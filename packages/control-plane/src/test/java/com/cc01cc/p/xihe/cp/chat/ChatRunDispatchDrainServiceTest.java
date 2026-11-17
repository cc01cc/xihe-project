package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.UserQuestionRepository;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

/**
 * task-161 / D-1786 面 B：排水机制用例 —— 不变量 {@code E ≤ cap}（证据 README §7.2）。
 *
 * <p>钉的是「求解而非禁令」这条：插队不是被拒出来的，而是 {@code E + Q} 计数 +
 * 排水只在 {@code E < cap} 时弹队首算出来的。所以这里的断言是**数值**：排水弹了几个、
 * 弹了谁、什么情况必须停手。</p>
 *
 * <p>{@code ChatRunDispatchQueueService} 与 {@code ApprovalService} 都 mock 掉：本类只验
 * 「何时弹、弹给谁、弹完是否收敛」，各自的执行器由各自单测覆盖。</p>
 */
class ChatRunDispatchDrainServiceTest {

    private static final String SESSION = "11111111-1111-1111-1111-111111111111";
    private static final String RUN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    private static final String RUN_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    private static final String RUN_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

    private final ChatRunRepository runs = Mockito.mock(ChatRunRepository.class);
    private final UserQuestionRepository questions = Mockito.mock(UserQuestionRepository.class);
    private final ChatApprovalRepository approvals = Mockito.mock(ChatApprovalRepository.class);
    private final ConfigService config = Mockito.mock(ConfigService.class);
    private final RunDispatchQueue queue = new RunDispatchQueue();
    private final ChatRunDispatchQueueService queueService =
            Mockito.mock(ChatRunDispatchQueueService.class);
    private final ApprovalService approvalService = Mockito.mock(ApprovalService.class);

    private ChatRunDispatchDrainService drain() {
        SessionRunConcurrencyGate gate = new SessionRunConcurrencyGate(
                runs, questions, approvals, queue, config);
        return new ChatRunDispatchDrainService(gate, queue, queueService, approvalService);
    }

    private void cap(String value) {
        when(config.resolve(eq(SessionRunConcurrencyGate.CONFIG_DOMAIN),
                eq(SessionRunConcurrencyGate.CONFIG_KEY), any(), any())).thenReturn(value);
    }

    private ChatRun run(String runId, String status) {
        return new ChatRun(runId, SESSION, "user-1", "ws-1", "idem-" + runId, "hash",
                "openai", "model", "workspace", status);
    }

    private void nonTerminal(ChatRun... runsOfSession) {
        when(runs.findBySessionIdAndStatusIn(eq(SESSION), any())).thenReturn(List.of(runsOfSession));
    }

    private RunDispatchQueue.Entry questionEntry(String runId) {
        return new RunDispatchQueue.Entry(runId, SESSION, Instant.now(),
                new RunDispatchQueue.QuestionResume(runId, SESSION, "q-" + runId, "answer"));
    }

    private void parked(String runId) {
        // parked run 的 durable 事实是 status='queued'，队列成员资格在内存。
        queue.park(questionEntry(runId));
        when(queueService.removeParked(runId)).thenReturn(true);
    }

    // ---------------------------------------------------------------------------------------
    // E ≤ cap：排水只在有空槽时弹
    // ---------------------------------------------------------------------------------------

    @Test
    void drainDoesNothingWhileTheSessionIsAtItsCap() {
        cap("2");
        nonTerminal(run(RUN_A, "running"), run(RUN_B, "running"), run(RUN_C, "queued"));
        parked(RUN_C);

        drain().drain(SESSION);

        assertEquals(1, queue.parkedCount(SESSION), "no slot ⇒ the entry stays parked, nothing resumed");
        assertEquals(0, queue.position(SESSION, RUN_C), "the head stays parked, still in position 0");
        Mockito.verifyNoInteractions(queueService);
    }

    @Test
    void drainResumesExactlyAsManyQueuedRunsAsTheFreeSlotsAllow() {
        cap("2");
        // 1 个在执行 ⇒ 空 1 槽 ⇒ 只许弹 1 个（不许把 2 个都弹：那会破 E ≤ cap）。
        nonTerminal(run(RUN_A, "running"), run(RUN_B, "queued"), run(RUN_C, "queued"));
        parked(RUN_B);
        parked(RUN_C);

        drain().drain(SESSION);

        // 弹 B 之后 B 不再在队列里 ⇒ 它按 'queued-without-membership' 计入执行数 ⇒ E=2=cap
        // ⇒ 循环停手，C 只前移到队头、不被恢复。
        Mockito.verify(queueService).resumeQuestionNow(
                Mockito.argThat(payload -> RUN_B.equals(payload.runId())));
        assertEquals(0, queue.position(SESSION, RUN_C), "C moved up to the head, not resumed");
    }

    @Test
    void drainStopsAsSoonAsTheExecutingCountReachesTheCap() {
        cap("1");
        // cap=1、0 个在执行 ⇒ 弹 1 个；mock 列表不反映恢复，所以第二圈看到仍是 0，
        // 因此用「列表随恢复变化」的桩来钉住停止点。
        nonTerminal(run(RUN_B, "queued"));
        parked(RUN_B);
        // 恢复后 B 变 running：排水第二圈必须看到 1 = cap 而停手。
        when(runs.findBySessionIdAndStatusIn(eq(SESSION), any()))
                .thenReturn(List.of(run(RUN_B, "queued")), List.of(run(RUN_B, "running")));

        drain().drain(SESSION);

        assertEquals(1, Mockito.mockingDetails(queueService).getInvocations().size(),
                "cap=1 must resume exactly one run per drain");
        assertEquals(0, queue.parkedCount(SESSION));
    }

    @Test
    void drainResumesTheHeadOnlyAndNeverSkipsAhead() {
        cap("1");
        nonTerminal(run(RUN_A, "queued"), run(RUN_B, "queued"));
        parked(RUN_A);
        parked(RUN_B);

        drain().drain(SESSION);

        Mockito.verify(queueService).resumeQuestionNow(
                Mockito.argThat(payload -> RUN_A.equals(payload.runId())));
        Mockito.verify(queueService, Mockito.never()).resumeQuestionNow(
                Mockito.argThat(payload -> RUN_B.equals(payload.runId())));
    }

    @Test
    void drainDispatchesAnApprovalEntryThroughTheApprovalService() {
        cap("2");
        nonTerminal(run(RUN_A, "queued"));
        ApprovalDecision decision = new ApprovalDecision(
                ApprovalDecision.Kind.ONCE, null, null, null, null);
        queue.park(new RunDispatchQueue.Entry(RUN_A, SESSION, Instant.now(),
                new RunDispatchQueue.ApprovalResume(RUN_A, SESSION,
                        "22222222-2222-2222-2222-222222222222",
                        "33333333-3333-3333-3333-333333333333",
                        "44444444-4444-4444-4444-444444444444", decision)));

        drain().drain(SESSION);

        Mockito.verify(approvalService).replayQueuedDecision(
                eq("22222222-2222-2222-2222-222222222222"),
                eq("33333333-3333-3333-3333-333333333333"),
                eq("44444444-4444-4444-4444-444444444444"), any());
        assertEquals(0, queue.parkedCount(SESSION));
    }

    @Test
    void terminalEventTriggersTheDrain() {
        cap("2");
        nonTerminal(run(RUN_A, "queued"));
        parked(RUN_A);

        drain().onRunTerminalized(new ChatRunTerminalizedEvent(SESSION, "run-x", "succeeded", null));

        assertEquals(0, queue.parkedCount(SESSION), "the terminal event is the drain trigger");
        assertFalse(queue.isParked(SESSION, RUN_A));
        assertTrue(Mockito.mockingDetails(queueService).getInvocations().size() >= 1);
    }
}
