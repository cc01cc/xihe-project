package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRunHistory;
import com.cc01cc.p.xihe.cp.repository.ChatRunHistoryRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.UUID;

/**
 * PLAN-0464 T1.3: the only writer of {@code chat_run_history}.
 *
 * <p>Runs inside the caller's transaction so a history row commits or rolls back
 * with the transition it describes. Callers must already hold the ChatRun row
 * lock (terminal/recovery transaction) or be the sole writer of the row
 * (startup restore), which is what makes the {@code max(sequence)+1} allocation
 * safe.</p>
 */
@Service
public class ChatRunHistoryWriter {

    private static final Logger logger = LoggerFactory.getLogger(ChatRunHistoryWriter.class);

    private final ChatRunHistoryRepository history;

    public ChatRunHistoryWriter(ChatRunHistoryRepository history) {
        this.history = history;
    }

    public void append(String eventType, String source, String actorType,
                       UUID runId, UUID sessionId, String fromStatus, String toStatus,
                       String terminalOutcome, String errorCode, String payload) {
        ChatRunHistory row = new ChatRunHistory();
        row.setId(UUID.randomUUID());
        row.setRunId(runId);
        row.setSessionId(sessionId);
        row.setSequence(history.findMaxSequence(runId) + 1);
        row.setEventType(eventType);
        row.setSource(source);
        row.setActorType(actorType);
        row.setFromStatus(fromStatus);
        row.setToStatus(toStatus);
        row.setTerminalOutcome(terminalOutcome);
        row.setErrorCode(errorCode);
        row.setPayload(payload);
        history.save(row);
        logger.info("[LIFECYCLE] service=cp event=chat_run_history_appended runId={} sequence={} eventType={} fromStatus={} toStatus={}",
                runId, row.getSequence(), eventType, fromStatus, toStatus);
    }
}
