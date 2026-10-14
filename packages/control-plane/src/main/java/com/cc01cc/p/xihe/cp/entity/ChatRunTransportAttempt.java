package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "chat_run_transport_attempts", uniqueConstraints = @UniqueConstraint(
        name = "uq_chat_run_transport_attempts_run_seq",
        columnNames = {"run_id", "seq"}))
public class ChatRunTransportAttempt {

    public static final String STATUS_RUNNING = "running";
    public static final String STATUS_TERMINAL = "terminal";

    public static final String OUTCOME_SUCCESS = "success";
    public static final String OUTCOME_ERROR = "error";
    public static final String OUTCOME_TIMEOUT = "timeout";
    public static final String OUTCOME_ABORTED = "aborted";
    public static final String OUTCOME_PARTIAL = "partial";

    public static final String STAGE_ATTEMPT_STARTED = "attempt_started";
    public static final String STAGE_FIRST_CHUNK = "first_chunk";
    public static final String STAGE_STREAMING = "streaming";
    public static final String STAGE_ATTEMPT_FINISHED = "attempt_finished";

    @Id
    @Column(name = "attempt_id", columnDefinition = "uuid")
    private UUID attemptId;

    @Column(name = "run_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String runId;

    @Column(name = "session_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String sessionId;

    @Column(name = "seq", nullable = false)
    private Long sequence;

    @Column(name = "status", nullable = false, length = 16)
    private String status;

    @Column(name = "outcome", length = 16)
    private String outcome;

    @Column(name = "started_at", nullable = false)
    private Instant startedAt;

    @Column(name = "ended_at")
    private Instant endedAt;

    @Column(name = "duration_ms")
    private Long durationMs;

    @Column(name = "error_code", length = 64)
    private String errorCode;

    @Column(name = "provider_http_status")
    private Integer providerHttpStatus;

    @Column(name = "first_chunk_ms")
    private Long firstChunkMs;

    @Column(name = "chunk_count")
    private Long chunkCount;

    @Column(name = "last_progress_stage", length = 32)
    private String lastProgressStage;

    @Column(name = "last_progress_elapsed_ms")
    private Long lastProgressElapsedMs;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public ChatRunTransportAttempt() {}

    @PrePersist
    protected void onCreate() {
        Instant now = Instant.now();
        if (createdAt == null) {
            createdAt = now;
        }
        if (updatedAt == null) {
            updatedAt = now;
        }
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getAttemptId() { return attemptId; }
    public void setAttemptId(UUID attemptId) { this.attemptId = attemptId; }
    public String getRunId() { return runId; }
    public void setRunId(String runId) { this.runId = runId; }
    public String getSessionId() { return sessionId; }
    public void setSessionId(String sessionId) { this.sessionId = sessionId; }
    public Long getSequence() { return sequence; }
    public void setSequence(Long sequence) { this.sequence = sequence; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public String getOutcome() { return outcome; }
    public void setOutcome(String outcome) { this.outcome = outcome; }
    public Instant getStartedAt() { return startedAt; }
    public void setStartedAt(Instant startedAt) { this.startedAt = startedAt; }
    public Instant getEndedAt() { return endedAt; }
    public void setEndedAt(Instant endedAt) { this.endedAt = endedAt; }
    public Long getDurationMs() { return durationMs; }
    public void setDurationMs(Long durationMs) { this.durationMs = durationMs; }
    public String getErrorCode() { return errorCode; }
    public void setErrorCode(String errorCode) { this.errorCode = errorCode; }
    public Integer getProviderHttpStatus() { return providerHttpStatus; }
    public void setProviderHttpStatus(Integer providerHttpStatus) { this.providerHttpStatus = providerHttpStatus; }
    public Long getFirstChunkMs() { return firstChunkMs; }
    public void setFirstChunkMs(Long firstChunkMs) { this.firstChunkMs = firstChunkMs; }
    public Long getChunkCount() { return chunkCount; }
    public void setChunkCount(Long chunkCount) { this.chunkCount = chunkCount; }
    public String getLastProgressStage() { return lastProgressStage; }
    public void setLastProgressStage(String lastProgressStage) { this.lastProgressStage = lastProgressStage; }
    public Long getLastProgressElapsedMs() { return lastProgressElapsedMs; }
    public void setLastProgressElapsedMs(Long lastProgressElapsedMs) { this.lastProgressElapsedMs = lastProgressElapsedMs; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
