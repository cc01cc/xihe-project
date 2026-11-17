package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-161 / D-1786 面 B：恢复投放队列的机制用例（FIFO、位置、摘除、回队首）。
 *
 * <p>这些断言钉的是 D-1801 的三条用户裁定：③ 队头纯 FIFO、② 可取消不可插队、
 * D-1785 位置可见。队列是内存纯函数，无需 Spring 上下文。</p>
 */
class RunDispatchQueueTest {

    private static final String SESSION = "11111111-1111-1111-1111-111111111111";

    private final RunDispatchQueue queue = new RunDispatchQueue();

    private RunDispatchQueue.Entry entry(String runId) {
        return new RunDispatchQueue.Entry(runId, SESSION, Instant.now(),
                new RunDispatchQueue.QuestionResume(runId, SESSION, "q-" + runId, "answer"));
    }

    @Test
    void parkedRunsArePolledInPureFifoOrder() {
        List<String> ids = List.of("a", "b", "c");
        ids.forEach(id -> queue.park(entry(id)));

        assertEquals("a", queue.pollFirst(SESSION).runId());
        assertEquals("b", queue.pollFirst(SESSION).runId());
        assertEquals("c", queue.pollFirst(SESSION).runId());
        assertNull(queue.pollFirst(SESSION), "empty queue yields null, not a phantom head");
    }

    @Test
    void positionIsZeroBasedAndCountsTheRunsAhead() {
        queue.park(entry("a"));
        queue.park(entry("b"));
        queue.park(entry("c"));

        // 「前面还有 N 个」= position（D-1785 最低形态的读数来源）。
        assertEquals(0, queue.position(SESSION, "a"));
        assertEquals(1, queue.position(SESSION, "b"));
        assertEquals(2, queue.position(SESSION, "c"));
        assertEquals(-1, queue.position(SESSION, "absent"), "not queued ⇒ -1 (no claim of membership)");
        assertEquals(3, queue.parkedCount(SESSION));
    }

    @Test
    void queueIsPerSession() {
        queue.park(entry("a"));
        queue.park(new RunDispatchQueue.Entry("z", "other-session", Instant.now(),
                new RunDispatchQueue.QuestionResume("z", "other-session", "q-z", "answer")));

        assertEquals(1, queue.parkedCount(SESSION));
        assertEquals(-1, queue.position(SESSION, "z"), "another session's run is not in this queue");
        assertEquals(0, queue.position("other-session", "z"));
    }

    @Test
    void removalTakesTheRunOutOfTheMiddleWithoutReorderingTheRest() {
        List.of("a", "b", "c").forEach(id -> queue.park(entry(id)));

        assertTrue(queue.remove("b"), "cancel must find the run wherever it sits");
        assertFalse(queue.isParked(SESSION, "b"));
        assertEquals("a", queue.pollFirst(SESSION).runId());
        assertEquals("c", queue.pollFirst(SESSION).runId(), "the rest keep their order");
        assertFalse(queue.remove("b"), "removing twice is a no-op, not a success");
    }

    @Test
    void reparkFirstPutsAFailedResumeBackAtTheHead() {
        List.of("a", "b").forEach(id -> queue.park(entry(id)));
        RunDispatchQueue.Entry head = queue.pollFirst(SESSION);

        // 排水恢复失败 ⇒ 回队首（不能回队尾：那会让它被后来的项插队，破坏 FIFO）。
        queue.reparkFirst(head);

        assertEquals(0, queue.position(SESSION, "a"), "the failed run keeps its head position");
        assertEquals(1, queue.position(SESSION, "b"));
        assertEquals("a", queue.pollFirst(SESSION).runId());
    }

    @Test
    void emptySessionLeavesNoShellBehind() {
        queue.park(entry("a"));
        queue.pollFirst(SESSION);
        assertEquals(0, queue.parkedCount(SESSION));
        assertEquals(-1, queue.position(SESSION, "a"));
    }
}
