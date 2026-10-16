package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * CP-owned cross-Run identity for an external mutation in one checkpoint lineage.
 * Only an argument fingerprint and lifecycle state are durable; raw arguments
 * and result bodies are deliberately excluded.
 */
@Entity
@Table(name = "agent_lineage_invocations")
public class AgentLineageInvocation {

    public static final String STATUS_PENDING = "pending";
    public static final String STATUS_COMPLETED = "completed";
    public static final String STATUS_AMBIGUOUS = "ambiguous";
    public static final String STATUS_UNKNOWN = "unknown";
    public static final String STATUS_FAILED = "failed";

    @Id
    @Column(nullable = false, columnDefinition = "uuid")
    private UUID id;

    @Column(name = "lineage_id", nullable = false, columnDefinition = "uuid")
    private UUID lineageId;

    @Column(name = "originating_tool_call_id", nullable = false, length = 128)
    private String originatingToolCallId;

    @Column(name = "first_run_id", nullable = false, columnDefinition = "uuid")
    private UUID firstRunId;

    @Column(name = "first_tool_call_id", nullable = false, columnDefinition = "uuid")
    private UUID firstToolCallId;

    @Column(name = "mcp_invocation_id", columnDefinition = "uuid")
    private UUID mcpInvocationId;

    @Column(name = "tool_name", nullable = false, length = 128)
    private String toolName;

    @Column(name = "arguments_hash", nullable = false, length = 64)
    private String argumentsHash;

    @Column(nullable = false, length = 24)
    private String status;

    @Column(name = "conflict_count", nullable = false)
    private int conflictCount;

    @Column(name = "last_conflict_code", length = 48)
    private String lastConflictCode;

    @Column(name = "last_conflict_at")
    private Instant lastConflictAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

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
    public UUID getLineageId() { return lineageId; }
    public void setLineageId(UUID lineageId) { this.lineageId = lineageId; }
    public String getOriginatingToolCallId() { return originatingToolCallId; }
    public void setOriginatingToolCallId(String originatingToolCallId) { this.originatingToolCallId = originatingToolCallId; }
    public UUID getFirstRunId() { return firstRunId; }
    public void setFirstRunId(UUID firstRunId) { this.firstRunId = firstRunId; }
    public UUID getFirstToolCallId() { return firstToolCallId; }
    public void setFirstToolCallId(UUID firstToolCallId) { this.firstToolCallId = firstToolCallId; }
    public UUID getMcpInvocationId() { return mcpInvocationId; }
    public void setMcpInvocationId(UUID mcpInvocationId) { this.mcpInvocationId = mcpInvocationId; }
    public String getToolName() { return toolName; }
    public void setToolName(String toolName) { this.toolName = toolName; }
    public String getArgumentsHash() { return argumentsHash; }
    public void setArgumentsHash(String argumentsHash) { this.argumentsHash = argumentsHash; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public int getConflictCount() { return conflictCount; }
    public void setConflictCount(int conflictCount) { this.conflictCount = conflictCount; }
    public String getLastConflictCode() { return lastConflictCode; }
    public void setLastConflictCode(String lastConflictCode) { this.lastConflictCode = lastConflictCode; }
    public Instant getLastConflictAt() { return lastConflictAt; }
    public void setLastConflictAt(Instant lastConflictAt) { this.lastConflictAt = lastConflictAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
