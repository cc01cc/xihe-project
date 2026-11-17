package com.cc01cc.p.xihe.cp.chat;

import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedDeque;

/**
 * task-161 / D-1786 面 B：恢复投放队列（内存态，按会话 FIFO）。
 *
 * <p>存的是「恢复动作」而不是 run：一个 run 等答案/等审批，人答复后 CP 要先申请执行槽才能唤醒
 * Agent；申请不到就 park 在此，等 {@code ChatRunTerminalizedEvent} 排水（见
 * {@code ChatRunDispatchQueueService}）。</p>
 *
 * <p>为什么内存就够（D-215 范围内）：XH 未上线、dev 单实例。队列的 durable 事实由
 * {@code chat_runs.status='queued'} 承担（UI 事实标记 + 对账/取消语义都走既有词汇）；
 * CP 重启时既有 {@code ChatRunRecoveryService}/{@code ChatRunReconciliationService} 会把
 * parked run 终态化，内存队列随之失去对应项 —— 排水时对 run 状态做校验，死项丢弃并记日志。
 * 多实例持久队列是后续卡，不在本卡范围（证据 README §7.5）。</p>
 *
 * <p>线程模型：park/poll/remove 由请求线程与事件监听线程并发触碰，一律
 * {@link ConcurrentHashMap} + {@link ConcurrentLinkedDeque}；position 读面允许瞬时近似，
 * 权威顺序以 pollFirst 弹出为准。</p>
 */
@Component
public class RunDispatchQueue {

    /** 一个问题答案的恢复动作：答案已 durable，只剩唤醒 Agent。 */
    public record QuestionResume(String runId, String sessionId, String questionId, String answer)
            implements ResumePayload {
    }

    /**
     * 一个审批决定的恢复动作：decide 已 {@code markDispatching}（行保持 live = 事实标记），
     * 排水时由 {@code ApprovalService.replayQueuedDecision} 重放 decide continuation。
     * 整个 {@link ApprovalDecision} 原样入列（内存态，无需序列化）。
     */
    public record ApprovalResume(String runId, String sessionId, String requestId,
                                 String userId, String workspaceId, ApprovalDecision decision)
            implements ResumePayload {
    }

    /** 恢复动作的两型并集；排水时按型分派。 */
    public sealed interface ResumePayload permits QuestionResume, ApprovalResume {
    }

    /** 一个排队项。position 不入对象 —— 顺序以 deque 位置为准。 */
    public record Entry(String runId, String sessionId, Instant parkedAt, ResumePayload payload) {
    }

    private final ConcurrentHashMap<String, ConcurrentLinkedDeque<Entry>> bySession =
            new ConcurrentHashMap<>();

    /** 队尾入列（FIFO）。 */
    public void park(Entry entry) {
        bySession.computeIfAbsent(entry.sessionId(), ignored -> new ConcurrentLinkedDeque<>()).addLast(entry);
    }

    /** 弹出队头；空队列返回 {@code null}。 */
    public Entry pollFirst(String sessionId) {
        ConcurrentLinkedDeque<Entry> deque = bySession.get(sessionId);
        if (deque == null) {
            return null;
        }
        Entry head = deque.pollFirst();
        if (deque.isEmpty()) {
            // 不留空壳：position/parkedCount 读到空壳与 null 等价，但干净些。
            bySession.remove(sessionId, deque);
        }
        return head;
    }

    /** 恢复失败时回队首（下一个 terminal 事件重试）；不入新队列，沿用原 session。 */
    public void reparkFirst(Entry entry) {
        bySession.computeIfAbsent(entry.sessionId(), ignored -> new ConcurrentLinkedDeque<>()).offerFirst(entry);
    }

    /** 按 runId 摘除（取消/会话删除路径）；摘除成功返回 true。 */
    public boolean remove(String runId) {
        for (ConcurrentLinkedDeque<Entry> deque : bySession.values()) {
            if (deque.removeIf(entry -> entry.runId().equals(runId))) {
                return true;
            }
        }
        return false;
    }

    /** 0 起的队头位置；-1 = 不在队列（不在本会话排队）。 */
    public int position(String sessionId, String runId) {
        ConcurrentLinkedDeque<Entry> deque = bySession.get(sessionId);
        if (deque == null) {
            return -1;
        }
        int index = 0;
        for (Entry entry : deque) {
            if (entry.runId().equals(runId)) {
                return index;
            }
            index++;
        }
        return -1;
    }

    /** 是否在本会话队列中（parked 判定的权威来源：status='queued' 也可能是「准入未派发」的新 run）。 */
    public boolean isParked(String sessionId, String runId) {
        return position(sessionId, runId) >= 0;
    }

    /** 本会话 parked 数（准入计数 E+Q 的 Q）。 */
    public int parkedCount(String sessionId) {
        ConcurrentLinkedDeque<Entry> deque = bySession.get(sessionId);
        return deque == null ? 0 : deque.size();
    }

    /** 快照（读面 API 与 lease 续期用）；返回值是拷贝，迭代安全。 */
    public List<Entry> parkedEntries(String sessionId) {
        ConcurrentLinkedDeque<Entry> deque = bySession.get(sessionId);
        return deque == null ? List.of() : new ArrayList<>(deque);
    }
}
