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
 * An auditable logical action / tool call within a {@link SessionOperation}.
 */
@Entity
@Table(name = "operation_items")
public class OperationItem {

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "operation_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String operationId;

    @Column(name = "tool_call_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String toolCallId;

    @Column(name = "parent_item_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String parentItemId;

    @Column(nullable = false)
    private Integer sequence;

    @Column(nullable = false, length = 32)
    private String kind;

    @Column(name = "tool_name", length = 128)
    private String toolName;

    @Column(nullable = false, length = 24)
    private String source;

    @Column(name = "policy_decision", length = 24)
    private String policyDecision;

    @Column(name = "approval_request_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String approvalRequestId;

    @Column(name = "request_hash", length = 64)
    private String requestHash;

    @Column(name = "arguments_preview", columnDefinition = "JSONB")
    @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
    private String argumentsPreview;

    @Column(name = "normalized_argv", columnDefinition = "JSONB")
    @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
    private String normalizedArgv;

    @Column(length = 1024)
    private String cwd;

    @Column(name = "env_policy_hash", length = 64)
    private String envPolicyHash;

    @Column(name = "expires_at")
    private Instant expiresAt;

    @Column(nullable = false, length = 24)
    private String status;

    @Column(name = "result_ref", columnDefinition = "TEXT")
    private String resultRef;

    @Column(name = "error_code", length = 64)
    private String errorCode;

    @Column(name = "started_at")
    private Instant startedAt;

    @Column(name = "finished_at")
    private Instant finishedAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public OperationItem() {}

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
    public String getOperationId() { return operationId; }
    public void setOperationId(String operationId) { this.operationId = operationId; }
    public String getToolCallId() { return toolCallId; }
    public void setToolCallId(String toolCallId) { this.toolCallId = toolCallId; }
    public String getParentItemId() { return parentItemId; }
    public void setParentItemId(String parentItemId) { this.parentItemId = parentItemId; }
    public Integer getSequence() { return sequence; }
    public void setSequence(Integer sequence) { this.sequence = sequence; }
    public String getKind() { return kind; }
    public void setKind(String kind) { this.kind = kind; }
    public String getToolName() { return toolName; }
    public void setToolName(String toolName) { this.toolName = toolName; }
    public String getSource() { return source; }
    public void setSource(String source) { this.source = source; }
    public String getPolicyDecision() { return policyDecision; }
    public void setPolicyDecision(String policyDecision) { this.policyDecision = policyDecision; }
    public String getApprovalRequestId() { return approvalRequestId; }
    public void setApprovalRequestId(String approvalRequestId) { this.approvalRequestId = approvalRequestId; }
    public String getRequestHash() { return requestHash; }
    public void setRequestHash(String requestHash) { this.requestHash = requestHash; }
    public String getArgumentsPreview() { return argumentsPreview; }
    public void setArgumentsPreview(String argumentsPreview) { this.argumentsPreview = argumentsPreview; }
    public String getNormalizedArgv() { return normalizedArgv; }
    public void setNormalizedArgv(String normalizedArgv) { this.normalizedArgv = normalizedArgv; }
    public String getCwd() { return cwd; }
    public void setCwd(String cwd) { this.cwd = cwd; }
    public String getEnvPolicyHash() { return envPolicyHash; }
    public void setEnvPolicyHash(String envPolicyHash) { this.envPolicyHash = envPolicyHash; }
    public Instant getExpiresAt() { return expiresAt; }
    public void setExpiresAt(Instant expiresAt) { this.expiresAt = expiresAt; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public String getResultRef() { return resultRef; }
    public void setResultRef(String resultRef) { this.resultRef = resultRef; }
    public String getErrorCode() { return errorCode; }
    public void setErrorCode(String errorCode) { this.errorCode = errorCode; }
    public Instant getStartedAt() { return startedAt; }
    public void setStartedAt(Instant startedAt) { this.startedAt = startedAt; }
    public Instant getFinishedAt() { return finishedAt; }
    public void setFinishedAt(Instant finishedAt) { this.finishedAt = finishedAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
