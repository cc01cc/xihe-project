package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.UserQuestion;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.UserQuestionRepository;
import com.cc01cc.p.xihe.cp.service.InstanceIdentityService;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

/**
 * task-161 / D-1786 面 B：恢复闸的两个分支（立即恢复 / 排队）与**兜底**。
 *
 * <p>兜底那条是本卡唯一「宁可破不变量也不能丢事实」的路径：park 的状态期望集落空时，
 * 答案已经 durable 写入，若既不排队也不唤醒，用户会看到一个「已回答」但永远不恢复的 run。
 * 所以那里 fail-open 回到唤醒，期望「超一次 cap」而不是「答案黑洞」。</p>
 */
class ChatRunDispatchQueueServiceTest {

    private static final String SESSION = "11111111-1111-1111-1111-111111111111";
    private static final String RUN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    private static final String QUESTION_ID = "22222222-2222-2222-2222-222222222222";

    private final ChatRunRepository runs = Mockito.mock(ChatRunRepository.class);
    private final UserQuestionRepository questions = Mockito.mock(UserQuestionRepository.class);
    private final ChatApprovalRepository approvals = Mockito.mock(ChatApprovalRepository.class);
    private final ConfigService config = Mockito.mock(ConfigService.class);
    private final UserQuestionAgentClient agentClient = Mockito.mock(UserQuestionAgentClient.class);
    private final InstanceIdentityService identity = Mockito.mock(InstanceIdentityService.class);
    private final RunDispatchQueue queue = new RunDispatchQueue();

    private ChatRunDispatchQueueService service() {
        SessionRunConcurrencyGate gate = new SessionRunConcurrencyGate(
                runs, questions, approvals, queue, config);
        return new ChatRunDispatchQueueService(gate, queue, runs, agentClient, identity);
    }

    private void cap(String value) {
        when(config.resolve(eq(SessionRunConcurrencyGate.CONFIG_DOMAIN),
                eq(SessionRunConcurrencyGate.CONFIG_KEY), any(), any())).thenReturn(value);
        when(identity.instanceId()).thenReturn(UUID.randomUUID());
    }

    private void executing(String... runIds) {
        List<ChatRun> active = java.util.Arrays.stream(runIds)
                .map(id -> new ChatRun(id, SESSION, "user-1", "ws-1", "idem-" + id, "hash",
                        "openai", "model", "workspace", "running"))
                .toList();
        when(runs.findBySessionIdAndStatusIn(eq(SESSION), any())).thenReturn(active);
    }

    private UserQuestion question() {
        UserQuestion row = new UserQuestion();
        row.setId(UUID.fromString(QUESTION_ID));
        row.setSessionId(UUID.fromString(SESSION));
        row.setRunId(UUID.fromString(RUN_ID));
        return row;
    }

    @Test
    void aFreeSlotWakesTheAgentWithoutTouchingTheQueue() {
        cap("2");
        executing(); // 0 在执行 ⇒ 有空槽

        boolean resumed = service().resumeQuestionOrPark(question(), "answer");

        assertTrue(resumed);
        Mockito.verify(agentClient).respond(eq(QUESTION_ID), eq(SESSION), eq(RUN_ID), eq("answer"));
        assertEquals(0, queue.parkedCount(SESSION), "拿到槽就不该进队列");
    }

    @Test
    void aFullSessionParksTheResumeAndLeavesTheAnswerDurable() {
        cap("1");
        executing("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"); // 1 在执行，cap=1 ⇒ 无槽
        when(runs.parkRun(eq(UUID.fromString(RUN_ID)), any(), anyString(), any())).thenReturn(1);

        boolean resumed = service().resumeQuestionOrPark(question(), "answer");

        assertFalse(resumed);
        Mockito.verify(agentClient, Mockito.never()).respond(any(), any(), any(), any());
        assertEquals(1, queue.parkedCount(SESSION));
        assertEquals(0, queue.position(SESSION, RUN_ID));
        assertTrue(queue.isParked(SESSION, RUN_ID));
    }

    @Test
    void aLostParkTransitionFallsBackToWakingTheAgentInsteadOfSwallowingTheAnswer() {
        cap("1");
        executing("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"); // 无槽
        // run 已不在可 park 的状态（例如终态/并发转移）：durable 转移落空。
        when(runs.parkRun(eq(UUID.fromString(RUN_ID)), any(), anyString(), any())).thenReturn(0);

        boolean resumed = service().resumeQuestionOrPark(question(), "answer");

        // fail-open：宁可超一次 cap，也不能让「已回答」永远不恢复。
        assertTrue(resumed);
        Mockito.verify(agentClient).respond(eq(QUESTION_ID), eq(SESSION), eq(RUN_ID), eq("answer"));
        assertEquals(0, queue.parkedCount(SESSION), "兜底路径不能留下死队列项");
    }

    @Test
    void queueViewReportsZeroBasedPositionsStraightFromTheDeque() {
        cap("1");
        executing();
        ChatRunDispatchQueueService service = service();
        // 手工入列两个（本用例只验读面形状）。
        queue.park(new RunDispatchQueue.Entry("cccccccc-cccc-cccc-cccc-cccccccccccc", SESSION,
                java.time.Instant.now(), new RunDispatchQueue.QuestionResume(
                        "cccccccc-cccc-cccc-cccc-cccccccccccc", SESSION, "q-c", "a")));
        queue.park(new RunDispatchQueue.Entry(RUN_ID, SESSION, java.time.Instant.now(),
                new RunDispatchQueue.QuestionResume(RUN_ID, SESSION, "q-r", "a")));

        List<java.util.Map<String, Object>> view = service.queueView(SESSION);

        assertEquals(2, view.size());
        assertEquals("cccccccc-cccc-cccc-cccc-cccccccccccc", view.get(0).get("runId"));
        assertEquals(0, view.get(0).get("position"));
        assertEquals(1, view.get(1).get("position"), "位置是 CP 给的，UI 不推算");
    }
}
