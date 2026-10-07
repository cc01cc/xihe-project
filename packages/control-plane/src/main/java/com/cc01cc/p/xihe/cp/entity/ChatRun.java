package com.cc01cc.p.xihe.cp.entity;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "chat_runs", uniqueConstraints = @UniqueConstraint(
        name = "uk_chat_runs_user_session_idempotency",
        columnNames = {"user_id", "session_id", "idempotency_key"}))
public class ChatRun {

    public static final String ORIGIN_USER_SUBMISSION = "user_submission";
    public static final String ORIGIN_SPAWN = "spawn";

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "session_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String sessionId;

    /** PLAN-0410 T1.3: durable branch binding (V43 NOT NULL, immutable). */
    @Column(name = "branch_id", nullable = false, length = 36, updatable = false)
    @Convert(converter = UuidStringConverter.class)
    private String branchId;


    @Column(name = "user_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String userId;

    @Column(name = "workspace_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String workspaceId;

    @Column(name = "idempotency_key", nullable = false, length = 128)
    private String idempotencyKey;

    @Column(name = "request_hash", nullable = false, length = 64)
    private String requestHash;

    @Column(name = "origin", nullable = false, length = 24)
    private String origin = ORIGIN_USER_SUBMISSION;

    @Column(length = 50)
    private String provider;

    @Column(length = 100)
    private String model;

    @Column(name = "provider_connection_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String providerConnectionId;

    @Column(name = "connection_revision")
    private Long connectionRevision;

    @Column(name = "tool_mode", nullable = false, length = 20)
    private String toolMode = "none";

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "context_template_snapshot", nullable = false, columnDefinition = "jsonb")
    private JsonNode contextTemplateSnapshot = JsonNodeFactory.instance.objectNode();

    @Column(name = "user_message_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String userMessageId;

    @Column(name = "assistant_message_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String assistantMessageId;

    @Column(nullable = false, length = 24)
    private String status;

    @Column(name = "terminal_at")
    private Instant terminalAt;

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

    @Column(name = "lease_owner", length = 80)
    private String leaseOwner;

    @Column(name = "lease_expires_at")
    private Instant leaseExpiresAt;

    /**
     * PLAN-0464 T2.1 (V50): the spawn waiting link lives on the child run row —
     * which parent run it waits for and which parent tool call the wait belongs
     * to. Nullable: pre-V50 rows are never backfilled (design 风险画像).
     */
    @Column(name = "waiting_on_run_id", columnDefinition = "uuid")
    @Convert(converter = UuidStringConverter.class)
    private String waitingOnRunId;

    @Column(name = "waiting_tool_call_id", columnDefinition = "uuid")
    @Convert(converter = UuidStringConverter.class)
    private String waitingToolCallId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public ChatRun() {}

    public ChatRun(String id, String sessionId, String userId, String workspaceId,
                   String idempotencyKey, String requestHash, String provider,
                   String model, String toolMode, String status) {
        this.id = UUID.fromString(id);
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
        ensureContextTemplateSnapshot();
        Instant now = Instant.now();
        createdAt = now;
        updatedAt = now;
        if (branchId == null || branchId.isBlank()) {
            branchId = RootBranchBinder.ensureRootBranchId(sessionId);
        }
    }

    @PreUpdate
    protected void onUpdate() {
        // Defensive: detached-merge re-saves must never null the snapshot
        // (column is NOT NULL DEFAULT '{}'; merge copies detached nulls).
        ensureContextTemplateSnapshot();
        updatedAt = Instant.now();
    }

    private void ensureContextTemplateSnapshot() {
        if (contextTemplateSnapshot == null) {
            contextTemplateSnapshot = JsonNodeFactory.instance.objectNode();
        }
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getSessionId() { return sessionId; }
    public void setSessionId(String sessionId) { this.sessionId = sessionId; }
    public String getBranchId() { return branchId; }
    public void setBranchId(String branchId) { this.branchId = branchId; }
    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }
    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }
    public String getIdempotencyKey() { return idempotencyKey; }
    public void setIdempotencyKey(String idempotencyKey) { this.idempotencyKey = idempotencyKey; }
    public String getRequestHash() { return requestHash; }
    public void setRequestHash(String requestHash) { this.requestHash = requestHash; }
    public String getOrigin() { return origin; }
    public void setOrigin(String origin) { this.origin = origin; }
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

    public JsonNode getContextTemplateSnapshot() { return contextTemplateSnapshot; }
    public void setContextTemplateSnapshot(JsonNode contextTemplateSnapshot) {
        this.contextTemplateSnapshot = contextTemplateSnapshot == null
                ? JsonNodeFactory.instance.objectNode() : contextTemplateSnapshot.deepCopy();
    }
    public String getUserMessageId() { return userMessageId; }
    public void setUserMessageId(String userMessageId) { this.userMessageId = userMessageId; }
    public String getAssistantMessageId() { return assistantMessageId; }
    public void setAssistantMessageId(String assistantMessageId) { this.assistantMessageId = assistantMessageId; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public Instant getTerminalAt() { return terminalAt; }
    public void setTerminalAt(Instant terminalAt) { this.terminalAt = terminalAt; }
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
    public String getLeaseOwner() { return leaseOwner; }
    public void setLeaseOwner(String leaseOwner) { this.leaseOwner = leaseOwner; }
    public Instant getLeaseExpiresAt() { return leaseExpiresAt; }
    public void setLeaseExpiresAt(Instant leaseExpiresAt) { this.leaseExpiresAt = leaseExpiresAt; }
    public String getWaitingOnRunId() { return waitingOnRunId; }
    public void setWaitingOnRunId(String waitingOnRunId) { this.waitingOnRunId = waitingOnRunId; }
    public String getWaitingToolCallId() { return waitingToolCallId; }
    public void setWaitingToolCallId(String waitingToolCallId) { this.waitingToolCallId = waitingToolCallId; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
