package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.entity.WorkspaceJobHistory;
import com.cc01cc.p.xihe.cp.repository.WorkspaceJobHistoryRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.UUID;

/**
 * PLAN-0465 T1.3: the only writer of {@code workspace_job_history}.
 *
 * <p>Runs inside the caller's transaction so a history row commits or rolls back
 * with the transition it describes. Callers must already hold the
 * {@code workspace_jobs} row lock (upsert) or be the inserting transaction
 * (create), which is what makes the {@code max(sequence)+1} allocation safe.</p>
 */
@Service
public class WorkspaceJobHistoryWriter {

    private static final Logger logger = LoggerFactory.getLogger(WorkspaceJobHistoryWriter.class);

    private final WorkspaceJobHistoryRepository history;

    public WorkspaceJobHistoryWriter(WorkspaceJobHistoryRepository history) {
        this.history = history;
    }

    public void append(UUID jobId, String eventType, String fromStatus, String toStatus,
                       String cancelReason, String errorCode, String payload) {
        WorkspaceJobHistory row = new WorkspaceJobHistory();
        row.setId(UUID.randomUUID());
        row.setJobId(jobId);
        row.setSequence(history.findMaxSequence(jobId) + 1);
        row.setEventType(eventType);
        row.setFromStatus(fromStatus);
        row.setToStatus(toStatus);
        row.setCancelReason(cancelReason);
        row.setErrorCode(errorCode);
        row.setPayload(payload);
        history.save(row);
        logger.info("[LIFECYCLE] service=cp event=workspace_job_history_appended jobId={} sequence={} eventType={} fromStatus={} toStatus={}",
                jobId, row.getSequence(), eventType, fromStatus, toStatus);
    }
}
