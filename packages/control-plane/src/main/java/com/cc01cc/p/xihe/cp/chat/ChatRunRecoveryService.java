package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ApprovalHistory;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ChatRunHistory;
import com.cc01cc.p.xihe.cp.entity.UserQuestion;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.UserQuestionRepository;
import com.cc01cc.p.xihe.cp.service.RunCheckpointService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Reconciles chat runs that were left in an active status when the previous CP
 * process stopped. Runs with a live approval request resume as awaiting_approval
 * so the decision can still be dispatched; runs with a live pending user question
 * resume as running (G3-a C1: the question row is the durable waiting fact — the
 * run must not be terminalized while a human can still answer); queued runs that
 * carry a durable answered question are left for {@link ChatRunDispatchRecoveryService}
 * to replay (G3-a C2); all other active runs are marked ambiguous with
 * CP_RESTARTED because their Agent stream state is unrecoverable.
 * <p>PLAN-0317 T2.6（决策 #8）：取消请求中途重启的 run（status=cancelling）
 * 收敛为 cancelled——用户意图明确，不应落入 ambiguous。
 * <p>G3-a C5: an approval left {@code dispatching} across a restart has an
 * unknowable dispatch outcome, so it is settled to {@code dispatch_unknown}
 * (the explicit user-retry vocabulary, ApprovalService.decide) instead of being
 * silently replayed — the durable approval row does not carry the full decision
 * body (reject feedback), so an automatic replay could not be lossless.
 */
@Component
public class ChatRunRecoveryService {

    private static final Logger logger = LoggerFactory.getLogger(ChatRunRecoveryService.class);
    private static final List<String> LIVE_APPROVAL_STATES = List.of("pending", "dispatching", "dispatch_unknown");

    private final ChatRunRepository chatRunRepository;
    private final ChatApprovalRepository approvalRepository;
    private final UserQuestionRepository questionRepository;
    private final ChatActiveRunRegistry activeRunRegistry;
    private final ChatRunTerminalService terminalService;
    private final ChatRunHistoryWriter historyWriter;
    private final ApprovalHistoryWriter approvalHistoryWriter;
    private final RunCheckpointService runCheckpointService;

    public ChatRunRecoveryService(ChatRunRepository chatRunRepository,
                                  ChatApprovalRepository approvalRepository,
                                  UserQuestionRepository questionRepository,
                                  ChatActiveRunRegistry activeRunRegistry,
                                  ChatRunTerminalService terminalService,
                                  ChatRunHistoryWriter historyWriter,
                                  ApprovalHistoryWriter approvalHistoryWriter,
                                  RunCheckpointService runCheckpointService) {
        this.chatRunRepository = chatRunRepository;
        this.approvalRepository = approvalRepository;
        this.questionRepository = questionRepository;
        this.activeRunRegistry = activeRunRegistry;
        this.terminalService = terminalService;
        this.historyWriter = historyWriter;
        this.approvalHistoryWriter = approvalHistoryWriter;
        this.runCheckpointService = runCheckpointService;
    }

    @Order(Ordered.HIGHEST_PRECEDENCE)
    @EventListener(ApplicationReadyEvent.class)
    public void reconcileOnStartup() {
        int cancelled = reconcileCancellingRuns();
        List<ChatRun> recoverable = chatRunRepository.findRecoverableRuns(ChatRunRepository.ACTIVE_LEASE_STATUSES);
        if (recoverable.isEmpty()) {
            logger.info("[LIFECYCLE] service=cp event=chat_run_recovery_completed recovered=0 ambiguous=0 cancelled={}",
                    cancelled);
            return;
        }
        int restored = 0;
        int ambiguous = 0;
        int replayable = 0;
        for (ChatRun run : recoverable) {
            try {
                if (hasReplayableParkedAnswer(run)) {
                    // G3-a C2: queued + answered question — ChatRunDispatchRecoveryService
                    // (LOWEST precedence, runs after this listener) rebuilds the dispatch
                    // queue from this durable fact and replays. Terminalizing here would
                    // bury the answer the human already gave.
                    replayable++;
                    logger.info("[LIFECYCLE] service=cp event=chat_run_recovery_skipped runId={} sessionId={} status={} reason=replayable_parked_answer",
                            run.getId(), run.getSessionId(), run.getStatus());
                } else if (hasLiveApproval(run)) {
                    String fromStatus = run.getStatus();
                    run.setStatus("awaiting_approval");
                    chatRunRepository.save(run);
                    // PLAN-0464 T1.3: the live-approval restore branch is one of
                    // the four history writers (restore, not a terminal event).
                    historyWriter.append(ChatRunHistory.EVENT_RESTORE,
                            ChatRunHistory.SOURCE_RECOVERY, "system",
                            run.getId(), UUID.fromString(run.getSessionId()), fromStatus,
                            "awaiting_approval", null, null, null);
                    // G3-a C5: an approval stuck in dispatching across the restart has an
                    // unknowable dispatch outcome. Settle it to dispatch_unknown so the
                    // explicit user-retry path (ApprovalService.decide) can complete it —
                    // no silent replay of a partially-known decision.
                    settleDispatchingApprovals(run);
                    // PLAN-0645: the registry keeps a set per Session, so every recovered run is
                    // restored (a Session may legitimately have several in-flight runs).
                    activeRunRegistry.restore(run.getSessionId(), run.getId().toString());
                    restored++;
                    logger.info("[LIFECYCLE] service=cp event=chat_run_recovered runId={} sessionId={} status=awaiting_approval reason=live_approval",
                            run.getId(), run.getSessionId());
                } else if (hasLiveQuestion(run)) {
                    // G3-a C1: a live pending question means a human can still answer.
                    // Restore the run as running (no new status vocabulary — the question
                    // row remains the durable waiting fact) and let the normal answer
                    // path (deliverAnswer → respond) resume it once the agent is back.
                    String fromStatus = run.getStatus();
                    run.setStatus("running");
                    chatRunRepository.save(run);
                    historyWriter.append(ChatRunHistory.EVENT_RESTORE,
                            ChatRunHistory.SOURCE_RECOVERY, "system",
                            run.getId(), UUID.fromString(run.getSessionId()), fromStatus,
                            "running", null, null, null);
                    activeRunRegistry.restore(run.getSessionId(), run.getId().toString());
                    restored++;
                    logger.info("[LIFECYCLE] service=cp event=chat_run_recovered runId={} sessionId={} status=running reason=live_pending_question",
                            run.getId(), run.getSessionId());
                } else {
                    ChatRunTerminalService.TerminalResult result = terminalService.terminalize(
                            new ChatRunTerminalService.TerminalRequest(run.getId().toString(),
                                    List.of(run.getStatus()), "ambiguous", "ambiguous", "CP_RESTARTED",
                                    "Control plane restarted while the chat run was active",
                                    run.getTokenCount(), run.getAssistantChars(),
                                    ChatRunTerminalService.TerminalSource.RECONCILIATION, null, null));
                    if (result.committed()) {
                        ambiguous++;
                        logger.info("[LIFECYCLE] service=cp event=chat_run_recovered runId={} sessionId={} status=ambiguous errorCode=CP_RESTARTED",
                                run.getId(), run.getSessionId());
                    }
                }
            } catch (Exception e) {
                logger.error("[LIFECYCLE] service=cp event=chat_run_recovery_failed runId={} sessionId={}",
                        run.getId(), run.getSessionId(), e);
            }
        }
        logger.info("[LIFECYCLE] service=cp event=chat_run_recovery_completed recovered={} ambiguous={} cancelled={} replayable={}",
                restored, ambiguous, cancelled, replayable);
    }

    /**
     * PLAN-0338（切片模型补拍）：恢复事务提交后，对"已终态但没有任何 checkpoint
     * 投影行"的 Run 补拍切片。放在独立的低优先级监听器里，保证：(a) 先看到恢复写下的
     * 终态；(b) 不在恢复事务内做 Runtime HTTP 调用。幂等——每次启动重复执行安全。
     */
    @Order(Ordered.LOWEST_PRECEDENCE)
    @EventListener(ApplicationReadyEvent.class)
    public void captureRecoveredRuns() {
        try {
            int captured = runCheckpointService.captureTerminalRuns();
            logger.info("[LIFECYCLE] service=cp event=run_checkpoint_recovery_capture_completed runsCaptured={}",
                    captured);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_recovery_capture_failed", e);
        }
    }

    /**
     * PLAN-0317 T2.6: settle Runs left cancelling by a process restart as
     * cancelled, reconciling their domain-owned records through the terminal service.
     */
    private int reconcileCancellingRuns() {
        int cancelled = 0;
        for (ChatRun run : chatRunRepository.findByStatus("cancelling")) {
            try {
                ChatRunTerminalService.TerminalResult result = terminalService.terminalize(
                        new ChatRunTerminalService.TerminalRequest(run.getId().toString(),
                                List.of("cancelling"), "cancelled", "cancelled", null, null,
                                run.getTokenCount(), run.getAssistantChars(),
                                ChatRunTerminalService.TerminalSource.CANCELLATION, null, null));
                if (result.committed()) {
                    cancelled++;
                    logger.info("[LIFECYCLE] service=cp event=chat_run_recovered runId={} sessionId={} status=cancelled reason=restart_during_cancel",
                            run.getId(), run.getSessionId());
                }
            } catch (Exception e) {
                logger.error("[LIFECYCLE] service=cp event=chat_run_recovery_failed runId={} sessionId={} status=cancelling",
                        run.getId(), run.getSessionId(), e);
            }
        }
        return cancelled;
    }

    private boolean hasLiveApproval(ChatRun run) {
        List<ChatApproval> approvals = approvalRepository.findByRunIdAndStateIn(
                run.getId().toString(), LIVE_APPROVAL_STATES);
        Instant now = Instant.now();
        return approvals.stream().anyMatch(approval -> approval.getExpiresAt().isAfter(now));
    }

    /** G3-a C1: an unexpired pending question row — the run is waiting on a human, not dead. */
    private boolean hasLiveQuestion(ChatRun run) {
        List<UserQuestion> pending = questionRepository.findByRunIdAndStateIn(
                run.getId(), List.of(UserQuestion.STATE_PENDING));
        Instant now = Instant.now();
        return pending.stream().anyMatch(question -> question.getExpiresAt() == null
                || question.getExpiresAt().isAfter(now));
    }

    /** G3-a C2 handoff: queued with a durable answered question — replay, don't terminalize. */
    private boolean hasReplayableParkedAnswer(ChatRun run) {
        return "queued".equals(run.getStatus())
                && questionRepository.existsByRunIdAndState(run.getId(), UserQuestion.STATE_ANSWERED);
    }

    /** G3-a C5: settle approvals left dispatching by the restart to the explicit-retry state. */
    private void settleDispatchingApprovals(ChatRun run) {
        Instant now = Instant.now();
        for (ChatApproval approval : approvalRepository.findByRunIdAndStateIn(
                run.getId().toString(), List.of("dispatching"))) {
            int marked = approvalRepository.markDispatchUnknown(approval.getRequestId(), "CP_RESTARTED", now);
            if (marked == 0) {
                logger.warn("[LIFECYCLE] service=cp event=chat_approval_dispatch_unknown_skipped requestId={} state was no longer dispatching",
                        approval.getRequestId());
                continue;
            }
            approvalHistoryWriter.append(approval.getRequestId(),
                    UUID.fromString(approval.getRunId()), UUID.fromString(approval.getSessionId()),
                    ApprovalHistory.EVENT_DISPATCH_UNKNOWN, "dispatching", "dispatch_unknown",
                    approval.getApproved(), approval.getDecisionKind(), "system", "CP_RESTARTED");
            logger.info("[LIFECYCLE] service=cp event=chat_approval_dispatch_unknown requestId={} runId={} reason=cp_restart",
                    approval.getRequestId(), approval.getRunId());
        }
    }
}
