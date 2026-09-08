package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * One cross-module actual execution attempt of an {@link OperationItem}.
 */
@Entity
@Table(name = "operation_attempts")
public class OperationAttempt {

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "item_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String itemId;

    @Column(nullable = false, length = 24)
    private String stage;

    @Column(name = "retry_no", nullable = false)
    private Integer retryNo = 0;

    @Column(name = "parent_attempt_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String parentAttemptId;

    @Column(nullable = false, length = 24)
    private String module;

    @Column(name = "request_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String requestId;

    @Column(nullable = false, length = 24)
    private String status;

    @Column(name = "http_status")
    private Integer httpStatus;

    @Column(name = "error_code", length = 64)
    private String errorCode;

    @Column(name = "result_ref", columnDefinition = "TEXT")
    private String resultRef;

    @Column(name = "duration_ms")
    private Long durationMs;

    @Column(name = "started_at", nullable = false)
    private Instant startedAt;

    @Column(name = "finished_at")
    private Instant finishedAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public OperationAttempt() {}

    @PrePersist
    protected void onCreate() {
        Instant now = Instant.now();
        createdAt = now;
        updatedAt = now;
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getItemId() { return itemId; }
    public void setItemId(String itemId) { this.itemId = itemId; }
    public String getStage() { return stage; }
    public void setStage(String stage) { this.stage = stage; }
    public Integer getRetryNo() { return retryNo; }
    public void setRetryNo(Integer retryNo) { this.retryNo = retryNo; }
    public String getParentAttemptId() { return parentAttemptId; }
    public void setParentAttemptId(String parentAttemptId) { this.parentAttemptId = parentAttemptId; }
    public String getModule() { return module; }
    public void setModule(String module) { this.module = module; }
    public String getRequestId() { return requestId; }
    public void setRequestId(String requestId) { this.requestId = requestId; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public Integer getHttpStatus() { return httpStatus; }
    public void setHttpStatus(Integer httpStatus) { this.httpStatus = httpStatus; }
    public String getErrorCode() { return errorCode; }
    public void setErrorCode(String errorCode) { this.errorCode = errorCode; }
    public String getResultRef() { return resultRef; }
    public void setResultRef(String resultRef) { this.resultRef = resultRef; }
    public Long getDurationMs() { return durationMs; }
    public void setDurationMs(Long durationMs) { this.durationMs = durationMs; }
    public Instant getStartedAt() { return startedAt; }
    public void setStartedAt(Instant startedAt) { this.startedAt = startedAt; }
    public Instant getFinishedAt() { return finishedAt; }
    public void setFinishedAt(Instant finishedAt) { this.finishedAt = finishedAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
