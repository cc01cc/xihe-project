package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
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
 * {@code → ambiguous}（不谎称成功）。所属 operation 与在途 item/attempt 一并收口。
 */
@Component
public class ChatRunReconciliationService {

    private static final Logger logger = LoggerFactory.getLogger(ChatRunReconciliationService.class);

    private static final List<String> RECONCILE_STATUSES = List.of(
            "cancelling", "accepted", "queued", "running", "streaming", "awaiting_approval",
            "dispatching");

    private final ChatRunRepository chatRunRepository;
    private final ChatController chatController;
    private final ChatRunTerminalService terminalService;
    private final Duration grace;

    public ChatRunReconciliationService(
            ChatRunRepository chatRunRepository,
            ChatController chatController,
            ChatRunTerminalService terminalService,
            @Value("${cp.chat.reconcile-grace-seconds:600}") long graceSeconds) {
        this.chatRunRepository = chatRunRepository;
        this.chatController = chatController;
        this.terminalService = terminalService;
        this.grace = Duration.ofSeconds(graceSeconds);
    }

    @Scheduled(fixedDelayString = "${cp.chat.reconcile-interval-ms:300000}",
            initialDelayString = "${cp.chat.reconcile-initial-delay-ms:120000}")
    public void reconcileStaleRuns() {
        Instant now = Instant.now();
        Instant cutoff = now.minus(grace);
        List<ChatRun> stale = chatRunRepository.findStaleActiveRuns(RECONCILE_STATUSES, cutoff, cutoff);
        if (stale.isEmpty()) {
            return;
        }
        int cancelled = 0;
        int ambiguous = 0;
        int skippedActive = 0;
        for (ChatRun run : stale) {
            String runId = run.getId().toString();
            if (chatController.isRunActiveLocally(runId)) {
                skippedActive++;
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
                                null));
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
}
