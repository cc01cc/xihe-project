package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

import java.time.Instant;

@Entity
@Table(name = "chat_runs", uniqueConstraints = @UniqueConstraint(
        name = "uk_chat_runs_user_session_idempotency",
        columnNames = {"user_id", "session_id", "idempotency_key"}))
public class ChatRun {

    @Id
    @Column(name = "id", length = 36)
    private String id;

    @Column(name = "session_id", nullable = false, length = 36)
    private String sessionId;

    @Column(name = "user_id", nullable = false, length = 36)
    private String userId;

    @Column(name = "workspace_id", nullable = false, length = 36)
    private String workspaceId;

    @Column(name = "idempotency_key", nullable = false, length = 128)
    private String idempotencyKey;

    @Column(name = "request_hash", nullable = false, length = 64)
    private String requestHash;

    @Column(length = 50)
    private String provider;

    @Column(length = 100)
    private String model;

    @Column(name = "provider_connection_id", length = 36)
    private String providerConnectionId;

    @Column(name = "connection_revision")
    private Long connectionRevision;

    @Column(name = "tool_mode", nullable = false, length = 20)
    private String toolMode = "none";

    @Column(name = "user_message_id", length = 36)
    private String userMessageId;

    @Column(name = "assistant_message_id", length = 36)
    private String assistantMessageId;

    @Column(nullable = false, length = 24)
    private String status;

    @Column(name = "terminal_outcome", length = 24)
    private String terminalOutcome;

    @Column(name = "error_code", length = 64)
    private String errorCode;

    @Column(name = "error_detail", columnDefinition = "TEXT")
    private String errorDetail;

    @Column(name = "token_count", nullable = false)
    private int tokenCount;

    @Column(name = "assistant_chars", nullable = false)
    private int assistantChars;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public ChatRun() {}

    public ChatRun(String id, String sessionId, String userId, String workspaceId,
                   String idempotencyKey, String requestHash, String provider,
                   String model, String toolMode, String status) {
        this.id = id;
        this.sessionId = sessionId;
        this.userId = userId;
        this.workspaceId = workspaceId;
        this.idempotencyKey = idempotencyKey;
        this.requestHash = requestHash;
        this.provider = provider;
        this.model = model;
        this.toolMode = toolMode == null || toolMode.isBlank() ? "none" : toolMode;
        this.status = status;
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

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getSessionId() { return sessionId; }
    public void setSessionId(String sessionId) { this.sessionId = sessionId; }
    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }
    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }
    public String getIdempotencyKey() { return idempotencyKey; }
    public void setIdempotencyKey(String idempotencyKey) { this.idempotencyKey = idempotencyKey; }
    public String getRequestHash() { return requestHash; }
    public void setRequestHash(String requestHash) { this.requestHash = requestHash; }
    public String getProvider() { return provider; }
    public void setProvider(String provider) { this.provider = provider; }
    public String getModel() { return model; }
    public void setModel(String model) { this.model = model; }
    public String getProviderConnectionId() { return providerConnectionId; }
    public void setProviderConnectionId(String providerConnectionId) { this.providerConnectionId = providerConnectionId; }
    public Long getConnectionRevision() { return connectionRevision; }
    public void setConnectionRevision(Long connectionRevision) { this.connectionRevision = connectionRevision; }
    public String getToolMode() { return toolMode; }
    public void setToolMode(String toolMode) { this.toolMode = toolMode; }
    public String getUserMessageId() { return userMessageId; }
    public void setUserMessageId(String userMessageId) { this.userMessageId = userMessageId; }
    public String getAssistantMessageId() { return assistantMessageId; }
    public void setAssistantMessageId(String assistantMessageId) { this.assistantMessageId = assistantMessageId; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public String getTerminalOutcome() { return terminalOutcome; }
    public void setTerminalOutcome(String terminalOutcome) { this.terminalOutcome = terminalOutcome; }
    public String getErrorCode() { return errorCode; }
    public void setErrorCode(String errorCode) { this.errorCode = errorCode; }
    public String getErrorDetail() { return errorDetail; }
    public void setErrorDetail(String errorDetail) { this.errorDetail = errorDetail; }
    public int getTokenCount() { return tokenCount; }
    public void setTokenCount(int tokenCount) { this.tokenCount = tokenCount; }
    public int getAssistantChars() { return assistantChars; }
    public void setAssistantChars(int assistantChars) { this.assistantChars = assistantChars; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
