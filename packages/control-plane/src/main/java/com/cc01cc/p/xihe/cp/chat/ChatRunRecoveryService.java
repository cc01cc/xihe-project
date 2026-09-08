package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;

/**
 * Reconciles chat runs that were left in an active status when the previous CP
 * process stopped. Runs with a live approval request resume as awaiting_approval
 * so the decision can still be dispatched; all other active runs are marked
 * ambiguous with CP_RESTARTED because their Agent stream state is unrecoverable.
 */
@Component
public class ChatRunRecoveryService {

    private static final Logger logger = LoggerFactory.getLogger(ChatRunRecoveryService.class);
    private static final List<String> LIVE_APPROVAL_STATES = List.of("pending", "dispatching");

    private final ChatRunRepository chatRunRepository;
    private final ChatApprovalRepository approvalRepository;
    private final ChatController chatController;

    public ChatRunRecoveryService(ChatRunRepository chatRunRepository,
                                  ChatApprovalRepository approvalRepository,
                                  ChatController chatController) {
        this.chatRunRepository = chatRunRepository;
        this.approvalRepository = approvalRepository;
        this.chatController = chatController;
    }

    @EventListener(ApplicationReadyEvent.class)
    @Transactional
    public void reconcileOnStartup() {
        List<ChatRun> recoverable = chatRunRepository.findRecoverableRuns(ChatRunRepository.ACTIVE_LEASE_STATUSES);
        if (recoverable.isEmpty()) {
            logger.info("[LIFECYCLE] service=cp event=chat_run_recovery_completed recovered=0 ambiguous=0");
            return;
        }
        int restored = 0;
        int ambiguous = 0;
        for (ChatRun run : recoverable) {
            try {
                if (hasLiveApproval(run)) {
                    run.setStatus("awaiting_approval");
                    chatRunRepository.save(run);
                    chatController.restoreActiveRun(run.getSessionId(), run.getId().toString());
                    restored++;
                    logger.info("[LIFECYCLE] service=cp event=chat_run_recovered runId={} sessionId={} status=awaiting_approval reason=live_approval",
                            run.getId(), run.getSessionId());
                } else {
                    run.setStatus("ambiguous");
                    run.setTerminalOutcome("ambiguous");
                    run.setErrorCode("CP_RESTARTED");
                    run.setErrorDetail("Control plane restarted while the chat run was active");
                    chatRunRepository.save(run);
                    ambiguous++;
                    logger.info("[LIFECYCLE] service=cp event=chat_run_recovered runId={} sessionId={} status=ambiguous errorCode=CP_RESTARTED",
                            run.getId(), run.getSessionId());
                }
            } catch (Exception e) {
                logger.error("[LIFECYCLE] service=cp event=chat_run_recovery_failed runId={} sessionId={}",
                        run.getId(), run.getSessionId(), e);
            }
        }
        logger.info("[LIFECYCLE] service=cp event=chat_run_recovery_completed recovered={} ambiguous={}", restored, ambiguous);
    }

    private boolean hasLiveApproval(ChatRun run) {
        List<ChatApproval> approvals = approvalRepository.findByRunIdAndStateIn(
                run.getId().toString(), LIVE_APPROVAL_STATES);
        Instant now = Instant.now();
        return approvals.stream().anyMatch(approval -> approval.getExpiresAt().isAfter(now));
    }
}
