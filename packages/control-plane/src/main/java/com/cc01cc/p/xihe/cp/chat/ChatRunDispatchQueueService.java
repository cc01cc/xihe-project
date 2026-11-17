package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.UserQuestion;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.service.InstanceIdentityService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * task-161 / D-1786 面 B：恢复投放的「申请槽」一侧。
 *
 * <p>两个恢复路径（问题答案 {@code UserQuestionService.deliverAnswer}、审批决定
 * {@code ApprovalService.decide}）在唤醒 Agent <b>之前</b> 经这里申请执行槽：
 * {@link SessionRunConcurrencyGate#canResume} 为真 → 立即恢复；为假 → park 进
 * {@link RunDispatchQueue}（纯 FIFO，D-1801 ③），等 {@code ChatRunTerminalizedEvent}
 * 排水（{@link ChatRunDispatchDrainService}）。</p>
 *
 * <p>park 的 durable 事实 = {@code chat_runs.status='queued'}（既有词汇，见
 * {@link ChatRunRepository#parkRun}）+ 行保持其等待态语义（问题已 answered / 审批已
 * dispatching）。内存入列刻意放在 <b>事务提交后</b>（{@link #afterCommit}）：回滚不留
 * 悬空队列项，排水端再按 run 状态校验一次，双保险。</p>
 *
 * <p>本类不含排水监听、不依赖 {@code ApprovalService}（避免构造器环）；排水在
 * {@code ChatRunDispatchDrainService}，审批重放在 {@code ApprovalService#replayQueuedDecision}。</p>
 */
@Service
public class ChatRunDispatchQueueService {

    private static final Logger logger = LoggerFactory.getLogger(ChatRunDispatchQueueService.class);

    /** 与 {@code ChatSubmissionService} 的 LEASE_TTL 同口径（10 min），park 时续期。 */
    private static final Duration PARK_LEASE_TTL = Duration.ofMinutes(10);

    private final SessionRunConcurrencyGate gate;
    private final RunDispatchQueue queue;
    private final ChatRunRepository runs;
    private final UserQuestionAgentClient questionAgentClient;
    private final InstanceIdentityService identity;

    public ChatRunDispatchQueueService(SessionRunConcurrencyGate gate,
                                       RunDispatchQueue queue,
                                       ChatRunRepository runs,
                                       UserQuestionAgentClient questionAgentClient,
                                       InstanceIdentityService identity) {
        this.gate = gate;
        this.queue = queue;
        this.runs = runs;
        this.questionAgentClient = questionAgentClient;
        this.identity = identity;
    }

    /**
     * 问题答案的恢复闸（在 deliverAnswer 的 CAS 之后调用，同一事务内）。
     *
     * @return {@code true} = 已立即 respond（调用方继续其 audit/log 收尾）；
     *         {@code false} = 已 park：答案保持 durable（用户看到「已回答」），respond 挂到排水。
     */
    public boolean resumeQuestionOrPark(UserQuestion row, String answer) {
        String sessionId = row.getSessionId().toString();
        String runId = row.getRunId().toString();
        if (gate.canResume(sessionId, runId)) {
            // 与原路径一致：respond 失败向上抛，由外层事务回滚 CAS（fail-closed，不伪造 answered）。
            questionAgentClient.respond(row.getId().toString(), sessionId, runId, answer);
            return true;
        }
        if (!parkRunAsQueued(runId, List.of("running", "streaming", "dispatching"))) {
            // 状态期望集落空（run 已不在可 park 的状态）：队列项会成为死项、答案永远等不到执行。
            // 这种情形下 fail-open —— 照旧立即唤醒（回到本卡之前的行为），宁可超一次 cap，
            // 也不能让「用户已经回答」变成永远不恢复。
            logger.warn("[LIFECYCLE] service=cp event=chat_run_park_skipped_fallback_respond "
                    + "sessionId={} runId={}", sessionId, runId);
            questionAgentClient.respond(row.getId().toString(), sessionId, runId, answer);
            return true;
        }
        RunDispatchQueue.QuestionResume payload =
                new RunDispatchQueue.QuestionResume(runId, sessionId, row.getId().toString(), answer);
        afterCommit(() -> queue.park(new RunDispatchQueue.Entry(
                runId, sessionId, Instant.now(), payload)));
        logger.info("[LIFECYCLE] service=cp event=chat_run_resume_queued sessionId={} runId={} "
                        + "reason=dispatch_queue_full questionId={}", sessionId, runId, row.getId());
        return false;
    }

    /**
     * 审批决定的恢复闸（decide 在 markDispatching 之后调用）。为假时 decide 把整单
     * 决定经 {@link #parkApproval} 入队并返回 {@code status=queued} 响应。
     */
    public boolean claimApproval(String sessionId, String runId) {
        return gate.canResume(sessionId, runId);
    }

    /** 审批决定的 park：行已是 {@code dispatching}（事实：决定已作出、待执行），只需入列。 */
    public void parkApproval(ChatApproval approval, ApprovalDecision decision, String userId) {
        String sessionId = approval.getSessionId();
        String runId = approval.getRunId();
        RunDispatchQueue.ApprovalResume payload = new RunDispatchQueue.ApprovalResume(
                runId, sessionId, approval.getRequestId().toString(), userId,
                approval.getWorkspaceId(), decision);
        afterCommit(() -> queue.park(new RunDispatchQueue.Entry(
                runId, sessionId, Instant.now(), payload)));
        logger.info("[LIFECYCLE] service=cp event=chat_approval_decision_queued sessionId={} runId={} "
                        + "requestId={}", sessionId, runId, approval.getRequestId());
    }

    /** 排水执行：问题答案恢复。校验 run 仍 parked，respond → queued→running。 */
    public void resumeQuestionNow(RunDispatchQueue.QuestionResume payload) {
        if (!stillParked(payload.runId())) {
            return;
        }
        questionAgentClient.respond(payload.questionId(), payload.sessionId(),
                payload.runId(), payload.answer());
        resumeQueued(payload.runId());
    }

    /** 取消/会话删除路径：从队列摘除（run 的终态化由调用方负责）。 */
    public boolean removeParked(String runId) {
        return queue.remove(runId);
    }

    /**
     * 队列位置读面（D-1785：位置可见）。position 0 起 = 「前面还有 N 个」。
     * 权威顺序是内存 deque；UI 按既有 run-state 刷新节奏轮询。
     */
    public List<Map<String, Object>> queueView(String sessionId) {
        List<Map<String, Object>> view = new java.util.ArrayList<>();
        int position = 0;
        for (RunDispatchQueue.Entry entry : queue.parkedEntries(sessionId)) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("runId", entry.runId());
            row.put("position", position);
            view.add(row);
            position++;
        }
        return view;
    }

    private boolean stillParked(String runId) {
        ChatRun run = runs.findById(UUID.fromString(runId)).orElse(null);
        if (run == null || !"queued".equals(run.getStatus())) {
            // 重启终态化/并发取消已处理：队列项成死项，丢弃并留痕。
            logger.info("[LIFECYCLE] service=cp event=chat_run_queue_entry_dropped runId={} status={}",
                    runId, run == null ? "gone" : run.getStatus());
            return false;
        }
        return true;
    }

    /** @return true = 状态转移成功（run 已落 queued）；false = 期望集落空（调用方决定兜底）。 */
    private boolean parkRunAsQueued(String runId, List<String> expectedStatuses) {
        int updated = runs.parkRun(UUID.fromString(runId), expectedStatuses,
                identity.instanceId().toString(), Instant.now().plus(PARK_LEASE_TTL));
        if (updated == 0) {
            logger.info("[LIFECYCLE] service=cp event=chat_run_park_transition_lost runId={}", runId);
            return false;
        }
        return true;
    }

    private void resumeQueued(String runId) {
        int updated = runs.resumeQueuedRun(UUID.fromString(runId),
                identity.instanceId().toString(), Instant.now().plus(PARK_LEASE_TTL));
        if (updated == 0) {
            logger.info("[LIFECYCLE] service=cp event=chat_run_resume_transition_lost runId={}", runId);
        }
    }

    /** 内存入列只在事务提交后发生；无活动事务时立即执行（单测/非事务调用方）。 */
    private void afterCommit(Runnable action) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    action.run();
                }
            });
        } else {
            action.run();
        }
    }
}
