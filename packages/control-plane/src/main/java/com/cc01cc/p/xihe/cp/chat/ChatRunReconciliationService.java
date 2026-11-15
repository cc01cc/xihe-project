package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.status.RequestQueue;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * PLAN-0317 T2.7（决策 #9）：周期收敛"卡住的 run"。
 *
 * <p>候选 = 非终态 + 无有效 lease + 创建已超过宽限期；再用"本进程是否正在处理
 * 该 run"做二次保护，避免误伤正在流式输出的运行（v1 单 CP 实例，该保护是权威
 * 的活跃判断）。收敛规则：{@code cancelling → cancelled}（用户意图），其余
 * {@code → ambiguous}（不谎称成功）；Run-owned domain records are reconciled by
 * the terminal service.
 */
@Component
public class ChatRunReconciliationService {

    private static final Logger logger = LoggerFactory.getLogger(ChatRunReconciliationService.class);

    private static final List<String> RECONCILE_STATUSES = List.of(
            "cancelling", "accepted", "queued", "running", "streaming", "awaiting_approval",
            "dispatching");

    private final ChatRunRepository chatRunRepository;
    private final ChatActiveRunRegistry activeRunRegistry;
    private final ChatRunTerminalService terminalService;
    private final ChatRunTransportService transportAttempts;
    private final Duration grace;

    public ChatRunReconciliationService(
            ChatRunRepository chatRunRepository,
            ChatActiveRunRegistry activeRunRegistry,
            ChatRunTerminalService terminalService,
            ChatRunTransportService transportAttempts,
            @Value("${cp.chat.reconcile-grace-seconds:600}") long graceSeconds) {
        this.chatRunRepository = chatRunRepository;
        this.activeRunRegistry = activeRunRegistry;
        this.terminalService = terminalService;
        this.transportAttempts = transportAttempts;
        this.grace = Duration.ofSeconds(graceSeconds);
    }

    @Scheduled(fixedDelayString = "${cp.chat.reconcile-interval-ms:300000}",
            initialDelayString = "${cp.chat.reconcile-initial-delay-ms:120000}")
    public void reconcileStaleRuns() {
        // Repair the terminal-commit / after-commit-callback crash window before
        // the stale active-run candidate query can early-return on an empty list.
        try {
            int reconciledAttempts = transportAttempts.reconcileOrphanedTerminalAttempts();
            if (reconciledAttempts > 0) {
                logger.info("[LIFECYCLE] service=cp event=terminal_transport_attempts_reconciled count={}",
                        reconciledAttempts);
            }
        } catch (RuntimeException error) {
            // Telemetry repair is best-effort and must not suppress Run reconciliation.
            logger.warn("[LIFECYCLE] service=cp event=terminal_transport_attempt_reconcile_failed failureType={}",
                    error.getClass().getName());
        }

        Instant now = Instant.now();
        Instant cutoff = now.minus(grace);
        List<ChatRun> stale = chatRunRepository.findStaleActiveRuns(RECONCILE_STATUSES, cutoff, cutoff);
        if (stale.isEmpty()) {
            return;
        }
        int cancelled = 0;
        int ambiguous = 0;
        int skippedActive = 0;
        // task-134 A2: a parked (handed-off) run is only "still ours to deliver" while the queue can
        // still deliver it. Past the queue's own TTL the parked entry is dead, and skipping the run
        // because it is "locally registered" would skip it forever (D-1485: registered ≠ owned).
        // Shared contract: this window IS the queue's TTL (RequestQueue.TTL_SECONDS). Changing one
        // side without the other makes the two disagree about when a parked run is still deliverable.
        Instant queueCutoff = now.minus(Duration.ofSeconds(RequestQueue.TTL_SECONDS));
        for (ChatRun run : stale) {
            String runId = run.getId().toString();
            if (activeRunRegistry.isRunActiveLocally(runId)) {
                if (!activeRunRegistry.isHandedOffBefore(runId, queueCutoff)) {
                    skippedActive++;
                    // task-134 A3: the batch total cannot say *which* run was skipped, and a skipped
                    // run is exactly what "wedged forever" looks like from the outside.
                    logger.info("[LIFECYCLE] service=cp event=chat_run_reconcile_skipped runId={} sessionId={} status={} reason=locally_registered",
                            runId, run.getSessionId(), run.getStatus());
                    continue;
                }
                rejectExpiredQueueEntry(run, queueCutoff);
                continue;
            }
            try {
                boolean userCancelled = "cancelling".equals(run.getStatus());
                String target = userCancelled ? "cancelled" : "ambiguous";
                ChatRunTerminalService.TerminalResult result = terminalService.terminalize(
                        new ChatRunTerminalService.TerminalRequest(runId, List.of(run.getStatus()), target,
                                target, userCancelled ? null : "CP_RECONCILED",
                                userCancelled ? null : "Control plane reconciled a stale run without an active lease",
                                run.getTokenCount(), run.getAssistantChars(),
                                userCancelled ? ChatRunTerminalService.TerminalSource.CANCELLATION
                                        : ChatRunTerminalService.TerminalSource.RECONCILIATION,
                                null, null));
                if (result.committed() && userCancelled) {
                    cancelled++;
                } else if (result.committed()) {
                    ambiguous++;
                }
                logger.info("[LIFECYCLE] service=cp event=chat_run_reconciled runId={} sessionId={} status={} staleSince={}",
                        runId, run.getSessionId(), result.currentStatus(), run.getCreatedAt());
            } catch (Exception e) {
                logger.error("[LIFECYCLE] service=cp event=chat_run_reconcile_failed runId={} sessionId={}",
                        runId, run.getSessionId(), e);
            }
        }
        logger.info("[LIFECYCLE] service=cp event=chat_run_reconcile_completed cancelled={} ambiguous={} skipped_active={}",
                cancelled, ambiguous, skippedActive);
    }

    /**
     * task-134 A2: the run was parked for transport recovery and the queue's TTL has passed, so the
     * parked entry can never be delivered. Terminalize it as its <b>own</b> outcome instead of
     * "unknown": the request never left CP, so {@code QUEUE_EXPIRED} says more than a generic stale
     * reconciliation would.
     *
     * <p>Missing-handoff policy (explicit, not an accident): when the parked instant is unknown —
     * an old row, or the registry was rebuilt by a restart — {@code isHandedOffBefore} answers
     * {@code false}, so reconciliation keeps skipping. Conservative on purpose: taking over a run we
     * cannot prove is expired would terminalize a request that the drain may still deliver (a
     * second instance of the "terminal but never delivered" defect), whereas skipping keeps it
     * visible through {@code xihe.chat.queue.depth} and the skip log, and a restart settles it as
     * {@code CP_RESTARTED} anyway.</p>
     *
     * <p>Constraint: the transition must go through {@link ChatRunTerminalService#terminalize}, which
     * owns the CAS on {@code expectedStatuses}, the row lock and the "already terminal ⇒ no second
     * frame" rule. The expected status is narrowed to {@code queued} on purpose: a run that is
     * genuinely {@code running} must never be swept up by this branch.</p>
     */
    private void rejectExpiredQueueEntry(ChatRun run, Instant queueCutoff) {
        String runId = run.getId().toString();
        try {
            ChatRunTerminalService.TerminalResult result = terminalService.terminalize(
                    new ChatRunTerminalService.TerminalRequest(runId, List.of("queued"), "ambiguous",
                            "ambiguous", "QUEUE_EXPIRED",
                            "The queued chat request expired before the agent recovered",
                            run.getTokenCount(), run.getAssistantChars(),
                            ChatRunTerminalService.TerminalSource.RECONCILIATION, null, null));
            if (result.committed()) {
                logger.info("[LIFECYCLE] service=cp event=chat_run_queue_expired runId={} sessionId={} status={} parkedSince=before={}",
                        runId, run.getSessionId(), result.currentStatus(), queueCutoff);
            }
        } catch (Exception e) {
            logger.error("[LIFECYCLE] service=cp event=chat_run_queue_expire_failed runId={} sessionId={}",
                    runId, run.getSessionId(), e);
        }
    }
}
