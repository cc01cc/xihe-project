package com.cc01cc.p.xihe.cp.chat;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

/**
 * task-161 / D-1786 面 B：排水。监听 {@link ChatRunTerminalizedEvent}（既有终态收口事件，
 * {@code ChatRunTerminalService} 提交后发布；先例消费者 {@code WakeFanOutService}）——
 * 一个 run 终态 ⇒ 会话可能腾出执行槽 ⇒ 按 FIFO 弹出队首并恢复，直到 {@code E ≥ cap} 或队列空。
 *
 * <p>恢复动作本身（respond + 状态转移 + lease）在各自的执行器里：
 * 问题答案 → {@link ChatRunDispatchQueueService#resumeQuestionNow}；
 * 审批决定 → {@code ApprovalService.replayQueuedDecision}（它内部做 queued→running）。
 * 本类只负责「何时弹、弹给谁」。</p>
 *
 * <p>事件在提交后发布，监听线程即提交线程：排水里的 DB 写各自短事务，不持有终态路径的锁。
 * 恢复抛错 ⇒ 回队首等下一个 terminal 事件（parked lease 到期后由对账兜底清扫，不留永久楔死）。</p>
 */
@Service
public class ChatRunDispatchDrainService {

    private static final Logger logger = LoggerFactory.getLogger(ChatRunDispatchDrainService.class);

    private final SessionRunConcurrencyGate gate;
    private final RunDispatchQueue queue;
    private final ChatRunDispatchQueueService dispatchQueueService;
    private final ApprovalService approvalService;

    public ChatRunDispatchDrainService(SessionRunConcurrencyGate gate,
                                       RunDispatchQueue queue,
                                       ChatRunDispatchQueueService dispatchQueueService,
                                       ApprovalService approvalService) {
        this.gate = gate;
        this.queue = queue;
        this.dispatchQueueService = dispatchQueueService;
        this.approvalService = approvalService;
    }

    @EventListener
    public void onRunTerminalized(ChatRunTerminalizedEvent event) {
        drain(event.sessionId());
    }

    /** 弹出并恢复，直到执行数回到 cap 或队列空。 */
    void drain(String sessionId) {
        while (gate.executingCount(sessionId) < gate.maxConcurrentRuns()) {
            RunDispatchQueue.Entry entry = queue.pollFirst(sessionId);
            if (entry == null) {
                return;
            }
            try {
                resume(entry);
            } catch (RuntimeException resumeFailed) {
                queue.reparkFirst(entry);
                logger.warn("[LIFECYCLE] service=cp event=chat_run_queue_resume_failed sessionId={} "
                                + "runId={} failureType={} requeued=true",
                        sessionId, entry.runId(), resumeFailed.getClass().getSimpleName());
            }
        }
    }

    private void resume(RunDispatchQueue.Entry entry) {
        switch (entry.payload()) {
            case RunDispatchQueue.QuestionResume payload ->
                    dispatchQueueService.resumeQuestionNow(payload);
            case RunDispatchQueue.ApprovalResume payload ->
                    approvalService.replayQueuedDecision(payload.requestId(), payload.userId(),
                            payload.workspaceId(), payload.decision());
            default -> logger.warn("[LIFECYCLE] service=cp event=chat_run_queue_unknown_payload "
                    + "runId={} payloadType={}", entry.runId(), entry.payload().getClass().getSimpleName());
        }
    }
}
