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
 * One MCP execution-domain invocation (PLAN-0463 V49, owner-matrix MCPX).
 *
 * <p>Created at the Agent gate ({@code source=agent}) before grant context
 * validation, or best-effort for a user-direct mutation
 * ({@code source=direct_user}). Carries the safe preview/policy snapshot only —
 * never a prompt, raw secret or unbounded argument payload.</p>
 */
@Entity
@Table(name = "mcp_invocations")
public class McpInvocation {

    public static final String SOURCE_AGENT = "agent";
    public static final String SOURCE_DIRECT_USER = "direct_user";

    public static final String STATUS_ACTIVE = "active";
    public static final String STATUS_COMPLETED = "completed";
    public static final String STATUS_FAILED = "failed";
    public static final String STATUS_UNKNOWN = "unknown";
    public static final String STATUS_CANCELLED = "cancelled";

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "tool_call_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String toolCallId;

    @Column(name = "run_id", columnDefinition = "uuid")
    @Convert(converter = UuidStringConverter.class)
    private String runId;

    @Column(name = "session_id", columnDefinition = "uuid")
    @Convert(converter = UuidStringConverter.class)
    private String sessionId;

    @Column(name = "workspace_id", nullable = false, columnDefinition = "uuid")
    @Convert(converter = UuidStringConverter.class)
    private String workspaceId;

    @Column(name = "user_id", nullable = false, columnDefinition = "uuid")
    @Convert(converter = UuidStringConverter.class)
    private String userId;

    @Column(nullable = false, length = 16)
    private String source;

    @Column(name = "tool_name", nullable = false, length = 128)
    private String toolName;

    /** Bounded raw prefix preview (same 4096 rule as the legacy ledger preview). */
    @Column(name = "arguments_preview", columnDefinition = "TEXT")
    private String argumentsPreview;

    @Column(name = "policy_decision", length = 16)
    private String policyDecision;

    /** Safe verdict snapshot only (see {@code OperationPolicySummary}). */
    @Column(name = "policy_summary", columnDefinition = "TEXT")
    private String policySummary;

    @Column(name = "approval_request_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String approvalRequestId;

    @Column(nullable = false, length = 24)
    private String status;

    @Column(name = "error_code", length = 64)
    private String errorCode;

    @Column(name = "request_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String requestId;

    @Column(name = "started_at", nullable = false)
    private Instant startedAt;

    @Column(name = "finished_at")
    private Instant finishedAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public McpInvocation() {}

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
    public String getToolCallId() { return toolCallId; }
    public void setToolCallId(String toolCallId) { this.toolCallId = toolCallId; }
    public String getRunId() { return runId; }
    public void setRunId(String runId) { this.runId = runId; }
    public String getSessionId() { return sessionId; }
    public void setSessionId(String sessionId) { this.sessionId = sessionId; }
    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }
    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }
    public String getSource() { return source; }
    public void setSource(String source) { this.source = source; }
    public String getToolName() { return toolName; }
    public void setToolName(String toolName) { this.toolName = toolName; }
    public String getArgumentsPreview() { return argumentsPreview; }
    public void setArgumentsPreview(String argumentsPreview) { this.argumentsPreview = argumentsPreview; }
    public String getPolicyDecision() { return policyDecision; }
    public void setPolicyDecision(String policyDecision) { this.policyDecision = policyDecision; }
    public String getPolicySummary() { return policySummary; }
    public void setPolicySummary(String policySummary) { this.policySummary = policySummary; }
    public String getApprovalRequestId() { return approvalRequestId; }
    public void setApprovalRequestId(String approvalRequestId) { this.approvalRequestId = approvalRequestId; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public String getErrorCode() { return errorCode; }
    public void setErrorCode(String errorCode) { this.errorCode = errorCode; }
    public String getRequestId() { return requestId; }
    public void setRequestId(String requestId) { this.requestId = requestId; }
    public Instant getStartedAt() { return startedAt; }
    public void setStartedAt(Instant startedAt) { this.startedAt = startedAt; }
    public Instant getFinishedAt() { return finishedAt; }
    public void setFinishedAt(Instant finishedAt) { this.finishedAt = finishedAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
