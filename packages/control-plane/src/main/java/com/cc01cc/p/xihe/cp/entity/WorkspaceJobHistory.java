package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0465 T1.3 (PLAN-0462 decision #8): append-only transition history for one
 * Workspace Job.
 *
 * <p>Rows are never updated; the sequence is allocated per job inside the writer
 * transaction while the {@code workspace_jobs} row is locked. The six
 * {@code event_type} values are the six write branches: {@code start},
 * {@code running}, {@code settle}, {@code cancel}, {@code orphaned},
 * {@code interrupted}.</p>
 */
@Entity
@Table(name = "workspace_job_history")
public class WorkspaceJobHistory {

    public static final String EVENT_START = "start";
    public static final String EVENT_RUNNING = "running";
    public static final String EVENT_SETTLE = "settle";
    public static final String EVENT_CANCEL = "cancel";
    public static final String EVENT_ORPHANED = "orphaned";
    public static final String EVENT_INTERRUPTED = "interrupted";

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "job_id", nullable = false, columnDefinition = "uuid")
    private UUID jobId;

    @Column(nullable = false)
    private Long sequence;

    @Column(name = "event_type", nullable = false, length = 24)
    private String eventType;

    @Column(name = "from_status", length = 24)
    private String fromStatus;

    @Column(name = "to_status", nullable = false, length = 24)
    private String toStatus;

    @Column(name = "cancel_reason", length = 64)
    private String cancelReason;

    @Column(name = "error_code", length = 64)
    private String errorCode;

    /** Safe payload only (ids/flags); never raw commands, env or secrets. */
    @Column(columnDefinition = "TEXT")
    private String payload;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public WorkspaceJobHistory() {}

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public UUID getJobId() { return jobId; }
    public void setJobId(UUID jobId) { this.jobId = jobId; }
    public Long getSequence() { return sequence; }
    public void setSequence(Long sequence) { this.sequence = sequence; }
    public String getEventType() { return eventType; }
    public void setEventType(String eventType) { this.eventType = eventType; }
    public String getFromStatus() { return fromStatus; }
    public void setFromStatus(String fromStatus) { this.fromStatus = fromStatus; }
    public String getToStatus() { return toStatus; }
    public void setToStatus(String toStatus) { this.toStatus = toStatus; }
    public String getCancelReason() { return cancelReason; }
    public void setCancelReason(String cancelReason) { this.cancelReason = cancelReason; }
    public String getErrorCode() { return errorCode; }
    public void setErrorCode(String errorCode) { this.errorCode = errorCode; }
    public String getPayload() { return payload; }
    public void setPayload(String payload) { this.payload = payload; }
    public Instant getCreatedAt() { return createdAt; }
}
