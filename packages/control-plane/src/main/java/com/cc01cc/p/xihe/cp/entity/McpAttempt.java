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
 * One execution attempt of an {@link McpInvocation} (PLAN-0463 V49).
 *
 * <p>{@code stage=agent_tool} rows are written by the SSE relay next to the
 * legacy {@code operation_attempts} row (both stay until 0464 removes the
 * recorder component); {@code stage=cp_forward} rows are written by the MCP
 * proxy dispatch. Transport uncertainty finishes as {@code unknown} and may be
 * settled later as {@code late_confirmed}.</p>
 */
@Entity
@Table(name = "mcp_attempts")
public class McpAttempt {

    public static final String STAGE_CP_FORWARD = "cp_forward";
    public static final String STAGE_AGENT_TOOL = "agent_tool";

    public static final String STATUS_STARTED = "started";
    public static final String STATUS_SUCCEEDED = "succeeded";
    public static final String STATUS_FAILED = "failed";
    public static final String STATUS_TIMED_OUT = "timed_out";
    public static final String STATUS_CANCELLED = "cancelled";
    public static final String STATUS_UNKNOWN = "unknown";
    public static final String STATUS_LATE_CONFIRMED = "late_confirmed";

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "invocation_id", nullable = false, columnDefinition = "uuid")
    private UUID invocationId;

    @Column(nullable = false, length = 24)
    private String stage;

    @Column(name = "retry_no", nullable = false)
    private Integer retryNo = 0;

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

    public McpAttempt() {}

    @PrePersist
    protected void onCreate() {
        Instant now = Instant.now();
        createdAt = now;
        updatedAt = now;
        if (startedAt == null) {
            startedAt = now;
        }
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public UUID getInvocationId() { return invocationId; }
    public void setInvocationId(UUID invocationId) { this.invocationId = invocationId; }
    public String getStage() { return stage; }
    public void setStage(String stage) { this.stage = stage; }
    public Integer getRetryNo() { return retryNo; }
    public void setRetryNo(Integer retryNo) { this.retryNo = retryNo; }
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
