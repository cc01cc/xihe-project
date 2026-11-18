package com.cc01cc.p.xihe.cp.chat;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;

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
 * 恢复抛错 ⇒ 回队首等下一次排水（G3-a：终态事件 <b>或</b> 一次有界定时重试 —— 重启窗口内
 * agent 尚未恢复时，下一个 terminal 事件可能永远不会来；定时重试保证 respond 有第二次机会，
 * 每次失败都会再排一次，直到 parked lease 到期由对账兜底清扫，不留永久楔死）。</p>
 */
@Service
public class ChatRunDispatchDrainService {

    private static final Logger logger = LoggerFactory.getLogger(ChatRunDispatchDrainService.class);

    /** G3-a C2/C3：resume 失败后的定时重试间隔（每次失败重排，有界由 lease 兜底）。 */
    private static final Duration RESUME_RETRY_DELAY = Duration.ofSeconds(60);

    private final SessionRunConcurrencyGate gate;
    private final RunDispatchQueue queue;
    private final ChatRunDispatchQueueService dispatchQueueService;
    private final ApprovalService approvalService;
    private final TaskScheduler taskScheduler;

    public ChatRunDispatchDrainService(SessionRunConcurrencyGate gate,
                                       RunDispatchQueue queue,
                                       ChatRunDispatchQueueService dispatchQueueService,
                                       ApprovalService approvalService,
                                       TaskScheduler taskScheduler) {
        this.gate = gate;
        this.queue = queue;
        this.dispatchQueueService = dispatchQueueService;
        this.approvalService = approvalService;
        this.taskScheduler = taskScheduler;
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
                scheduleResumeRetry(sessionId);
                // G3-a：队首失败即本轮收手（head-of-line）。继续弹只会让同一项被
                // 立刻重试 —— respond 持续失败时是单轮死循环。失败的队首留在原地，
                // 重放由上面的定时重试或下一个终态事件驱动。
                return;
            }
        }
    }

    /** G3-a：终态事件之外的有界重试来源。失败重排、异常不向外抛（对账 lease 是兜底）。 */
    private void scheduleResumeRetry(String sessionId) {
        try {
            taskScheduler.schedule(() -> {
                try {
                    drain(sessionId);
                } catch (RuntimeException retryFailed) {
                    logger.warn("[LIFECYCLE] service=cp event=chat_run_queue_retry_failed sessionId={} failureType={}",
                            sessionId, retryFailed.getClass().getSimpleName());
                }
            }, Instant.now().plus(RESUME_RETRY_DELAY));
        } catch (RuntimeException scheduleFailed) {
            logger.warn("[LIFECYCLE] service=cp event=chat_run_queue_retry_schedule_failed sessionId={} failureType={}",
                    sessionId, scheduleFailed.getClass().getSimpleName());
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
