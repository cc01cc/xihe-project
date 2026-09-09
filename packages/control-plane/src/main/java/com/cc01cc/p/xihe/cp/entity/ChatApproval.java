package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Convert;
import jakarta.persistence.Id;
import jakarta.persistence.Convert;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Convert;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Convert;
import jakarta.persistence.Table;
import jakarta.persistence.Convert;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "approval_requests")
public class ChatApproval {

    @Id
    @Column(name = "request_id", columnDefinition = "uuid")
    private UUID requestId;

    @Column(name = "run_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String runId;

    @Column(name = "session_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String sessionId;

    @Column(name = "user_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String userId;

    @Column(name = "workspace_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String workspaceId;

    @Column(nullable = false, length = 80)
    private String tool;

    @Column(nullable = false, length = 512)
    private String action;

    @Column(columnDefinition = "TEXT")
    private String details;

    @Column(nullable = false, length = 24)
    private String state;

    @Column
    private Boolean approved;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Column(name = "decided_at")
    private Instant decidedAt;

    @Column(name = "dispatch_error_code", length = 64)
    private String dispatchErrorCode;

    @Column(name = "snapshot_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String snapshotId;

    @Column(name = "policy_class", length = 32)
    private String policyClass;

    @Column(name = "grant_consumed_at")
    private Instant grantConsumedAt;

    @Column(name = "arguments_hash", length = 96)
    private String argumentsHash;

    public ChatApproval() {}

    public ChatApproval(String requestId, String runId, String sessionId, String userId,
                        String workspaceId, String tool, String action, String details,
                        String state, Instant expiresAt, String snapshotId, String policyClass) {
        this(requestId, runId, sessionId, userId, workspaceId, tool, action, details,
                state, expiresAt, snapshotId, policyClass, null);
    }

    public ChatApproval(String requestId, String runId, String sessionId, String userId,
                        String workspaceId, String tool, String action, String details,
                        String state, Instant expiresAt, String snapshotId, String policyClass,
                        String argumentsHash) {
        this.requestId = UUID.fromString(requestId);
        this.runId = runId;
        this.sessionId = sessionId;
        this.userId = userId;
        this.workspaceId = workspaceId;
        this.tool = tool;
        this.action = action;
        this.details = details;
        this.state = state;
        this.expiresAt = expiresAt;
        this.snapshotId = snapshotId;
        this.policyClass = policyClass;
        this.argumentsHash = argumentsHash;
    }

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

    public UUID getRequestId() { return requestId; }
    public String getRunId() { return runId; }
    public String getSessionId() { return sessionId; }
    public String getUserId() { return userId; }
    public String getWorkspaceId() { return workspaceId; }
    public String getTool() { return tool; }
    public String getAction() { return action; }
    public String getDetails() { return details; }
    public String getState() { return state; }
    public Boolean getApproved() { return approved; }
    public Instant getExpiresAt() { return expiresAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public Instant getDecidedAt() { return decidedAt; }
    public String getDispatchErrorCode() { return dispatchErrorCode; }

    public void setState(String state) { this.state = state; }
    public void setApproved(Boolean approved) { this.approved = approved; }
    public void setDecidedAt(Instant decidedAt) { this.decidedAt = decidedAt; }
    public void setDispatchErrorCode(String dispatchErrorCode) { this.dispatchErrorCode = dispatchErrorCode; }
    public String getSnapshotId() { return snapshotId; }
    public String getPolicyClass() { return policyClass; }
    public Instant getGrantConsumedAt() { return grantConsumedAt; }
    public String getArgumentsHash() { return argumentsHash; }
    public void setSnapshotId(String snapshotId) { this.snapshotId = snapshotId; }
    public void setPolicyClass(String policyClass) { this.policyClass = policyClass; }
    public void setGrantConsumedAt(Instant grantConsumedAt) { this.grantConsumedAt = grantConsumedAt; }
}
