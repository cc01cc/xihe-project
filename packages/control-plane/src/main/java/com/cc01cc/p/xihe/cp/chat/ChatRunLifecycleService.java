package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** Owns conditional non-terminal Run transitions and persisted lease operations. */
@Service
public class ChatRunLifecycleService {

    private static final Logger logger = LoggerFactory.getLogger(ChatRunLifecycleService.class);

    private final ChatRunRepository chatRunRepository;
    private final ChatRunTerminalService chatRunTerminalService;

    public ChatRunLifecycleService(ChatRunRepository chatRunRepository,
                                   ChatRunTerminalService chatRunTerminalService) {
        this.chatRunRepository = chatRunRepository;
        this.chatRunTerminalService = chatRunTerminalService;
    }

    public boolean transition(String runId, List<String> expectedStatuses, String status,
                              String outcome, String errorCode, String errorDetail,
                              int tokenCount, int assistantChars, Object usagePayload) {
        if (runId == null || runId.isBlank()) {
            return false;
        }
        if (ChatRunTerminalService.isTerminalStatus(status)) {
            ChatRunTerminalService.TerminalResult result = chatRunTerminalService.terminalize(
                    new ChatRunTerminalService.TerminalRequest(runId, expectedStatuses, status,
                            outcome, errorCode, errorDetail, tokenCount, assistantChars,
                            ChatRunTerminalService.TerminalSource.STREAM, usagePayload));
            if (!result.committed()) {
                logger.debug("[LIFECYCLE] service=cp event=chat_run_transition_ignored runId={} targetStatus={} outcome={}",
                        runId, status, result.outcome());
            }
            return result.committed();
        }
        int updated = chatRunRepository.transition(
                UUID.fromString(runId), expectedStatuses, status, outcome, errorCode, errorDetail,
                tokenCount, assistantChars);
        if (updated == 0) {
            logger.debug("[LIFECYCLE] service=cp event=chat_run_transition_ignored runId={} targetStatus={}",
                    runId, status);
            return false;
        }
        return true;
    }

    public int tryAcquireLease(UUID runId, String instanceId, Instant expiresAt, Instant now) {
        return chatRunRepository.tryAcquireLease(
                runId, instanceId, expiresAt, now, ChatRunRepository.ACTIVE_LEASE_STATUSES);
    }

    public int releaseLease(UUID runId, String instanceId) {
        return chatRunRepository.releaseLease(runId, instanceId);
    }
}
