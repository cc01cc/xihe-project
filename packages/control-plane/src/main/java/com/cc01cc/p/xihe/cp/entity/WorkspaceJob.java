package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0465 T1.1 (PLAN-0462 decision #5/#7): the Workspace Job domain store.
 *
 * <p>{@code id} is the domain {@code jobId} — the only Job identity on the wire.
 * {@code state} carries the former {@code job_state} extension payload (row-lock
 * + monotonic-forward semantics live in {@code JobStateService}); {@code status}
 * and {@code scope} are promoted query columns mirrored from that payload.
 * {@code operation_item_id} is the dual-write anchor to the legacy job item and
 * survives until PLAN-0467 drops the legacy Ledger job rows.</p>
 */
@Entity
@Table(name = "workspace_jobs")
public class WorkspaceJob {

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "workspace_id", nullable = false, columnDefinition = "uuid")
    private UUID workspaceId;

    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    private UUID userId;

    @Column(name = "session_id", columnDefinition = "uuid")
    private UUID sessionId;

    @Column(name = "run_id", columnDefinition = "uuid")
    private UUID runId;

    @Column(name = "tool_call_id", columnDefinition = "uuid")
    private UUID toolCallId;

    /**
     * Legacy job item anchor（至 0467；workspace-start 双写行必有）。
     * Nullable：PLAN-0464 后 chat-run MCP 工具调用不再产生 ledger item
     * （Agent 停发 X-Operation-Id），此类行以 tool_call_id/run_id/session_id
     * 为 provenance。
     */
    @Column(name = "operation_item_id", columnDefinition = "uuid")
    private UUID operationItemId;

    @Column(nullable = false, length = 32)
    private String source;

    @Column(nullable = false, length = 16)
    private String scope;

    @Column(name = "idempotency_key", length = 128)
    private String idempotencyKey;

    @Column(name = "input_hash", length = 64)
    private String inputHash;

    @Column(nullable = false, length = 24)
    private String status;

    @Column(nullable = false, columnDefinition = "JSONB")
    @JdbcTypeCode(SqlTypes.JSON)
    private String state;

    @Column(name = "cancel_reason", length = 64)
    private String cancelReason;

    @Column(name = "error_code", length = 64)
    private String errorCode;

    /** Runtime backend handle (mirrored from {@code state->>'jobId'}). */
    @Column(name = "runtime_job_id", length = 128)
    private String runtimeJobId;

    @Column(name = "started_at")
    private Instant startedAt;

    @Column(name = "ended_at")
    private Instant endedAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public WorkspaceJob() {}

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
        updatedAt = createdAt;
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public UUID getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(UUID workspaceId) { this.workspaceId = workspaceId; }
    public UUID getUserId() { return userId; }
    public void setUserId(UUID userId) { this.userId = userId; }
    public UUID getSessionId() { return sessionId; }
    public void setSessionId(UUID sessionId) { this.sessionId = sessionId; }
    public UUID getRunId() { return runId; }
    public void setRunId(UUID runId) { this.runId = runId; }
    public UUID getToolCallId() { return toolCallId; }
    public void setToolCallId(UUID toolCallId) { this.toolCallId = toolCallId; }
    public UUID getOperationItemId() { return operationItemId; }
    public void setOperationItemId(UUID operationItemId) { this.operationItemId = operationItemId; }
    public String getSource() { return source; }
    public void setSource(String source) { this.source = source; }
    public String getScope() { return scope; }
    public void setScope(String scope) { this.scope = scope; }
    public String getIdempotencyKey() { return idempotencyKey; }
    public void setIdempotencyKey(String idempotencyKey) { this.idempotencyKey = idempotencyKey; }
    public String getInputHash() { return inputHash; }
    public void setInputHash(String inputHash) { this.inputHash = inputHash; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public String getState() { return state; }
    public void setState(String state) { this.state = state; }
    public String getCancelReason() { return cancelReason; }
    public void setCancelReason(String cancelReason) { this.cancelReason = cancelReason; }
    public String getErrorCode() { return errorCode; }
    public void setErrorCode(String errorCode) { this.errorCode = errorCode; }
    public String getRuntimeJobId() { return runtimeJobId; }
    public void setRuntimeJobId(String runtimeJobId) { this.runtimeJobId = runtimeJobId; }
    public Instant getStartedAt() { return startedAt; }
    public void setStartedAt(Instant startedAt) { this.startedAt = startedAt; }
    public Instant getEndedAt() { return endedAt; }
    public void setEndedAt(Instant endedAt) { this.endedAt = endedAt; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
