package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ApprovalHistory;
import com.cc01cc.p.xihe.cp.repository.ApprovalHistoryRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.UUID;

/**
 * PLAN-0464 T1.5: the only writer of {@code approval_history}.
 *
 * <p>Runs inside the caller's transaction so a history row commits or rolls back
 * with the {@code approval_requests} transition it describes. Every caller has
 * already inserted or updated the approval row first, and that row lock is what
 * serializes {@code max(sequence)+1} allocation for one request.</p>
 */
@Service
public class ApprovalHistoryWriter {

    private static final Logger logger = LoggerFactory.getLogger(ApprovalHistoryWriter.class);

    private final ApprovalHistoryRepository history;

    public ApprovalHistoryWriter(ApprovalHistoryRepository history) {
        this.history = history;
    }

    public void append(UUID requestId, UUID runId, UUID sessionId, String eventType,
                       String fromState, String toState, Boolean approved,
                       String decisionKind, String actorType, String payload) {
        ApprovalHistory row = new ApprovalHistory();
        row.setId(UUID.randomUUID());
        row.setRequestId(requestId);
        row.setRunId(runId);
        row.setSessionId(sessionId);
        row.setSequence(history.findMaxSequence(requestId) + 1);
        row.setEventType(eventType);
        row.setFromState(fromState);
        row.setToState(toState);
        row.setApproved(approved);
        row.setDecisionKind(decisionKind);
        row.setActorType(actorType);
        row.setPayload(payload);
        history.save(row);
        logger.info("[LIFECYCLE] service=cp event=approval_history_appended requestId={} sequence={} eventType={} toState={}",
                requestId, row.getSequence(), eventType, toState);
    }
}
