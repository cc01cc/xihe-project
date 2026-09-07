package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;

@Entity
@Table(name = "approval_requests")
public class ChatApproval {

    @Id
    @Column(name = "request_id", length = 36)
    private String requestId;

    @Column(name = "run_id", nullable = false, length = 36)
    private String runId;

    @Column(name = "session_id", nullable = false, length = 36)
    private String sessionId;

    @Column(name = "user_id", nullable = false, length = 36)
    private String userId;

    @Column(name = "workspace_id", nullable = false, length = 36)
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

    public ChatApproval() {}

    public ChatApproval(String requestId, String runId, String sessionId, String userId,
                        String workspaceId, String tool, String action, String details,
                        String state, Instant expiresAt) {
        this.requestId = requestId;
        this.runId = runId;
        this.sessionId = sessionId;
        this.userId = userId;
        this.workspaceId = workspaceId;
        this.tool = tool;
        this.action = action;
        this.details = details;
        this.state = state;
        this.expiresAt = expiresAt;
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

    public String getRequestId() { return requestId; }
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
}
