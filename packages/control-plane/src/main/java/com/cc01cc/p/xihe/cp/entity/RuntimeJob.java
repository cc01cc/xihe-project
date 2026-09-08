package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * Durable job record for long-running runtime operations (PLAN-274 M2).
 */
@Entity
@Table(name = "runtime_jobs")
public class RuntimeJob {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(columnDefinition = "uuid")
    private UUID id;

    @Column(name = "operation_id", nullable = false, columnDefinition = "uuid")
    private UUID operationId;

    @Column(name = "operation_item_id", nullable = false, columnDefinition = "uuid")
    private UUID operationItemId;

    @Column(name = "workspace_id", nullable = false, columnDefinition = "uuid")
    private UUID workspaceId;

    @Column(name = "run_id", columnDefinition = "uuid")
    private UUID runId;

    @Column(nullable = false, length = 32)
    private String status;

    @Column(name = "command_summary", columnDefinition = "TEXT")
    private String commandSummary;

    @Column
    private Long pid;

    @Column(name = "exit_code")
    private Integer exitCode;

    @Column(name = "error_code", length = 64)
    private String errorCode;

    @Column(name = "output_available", nullable = false)
    private Boolean outputAvailable;

    @Column(name = "output_ref", columnDefinition = "TEXT")
    private String outputRef;

    @Column(name = "owner_id", length = 128)
    private String ownerId;

    @Column(name = "lease_expires_at")
    private Instant leaseExpiresAt;

    @Column(name = "started_at")
    private Instant startedAt;

    @Column(name = "finished_at")
    private Instant finishedAt;

    @Column(name = "orphaned_at")
    private Instant orphanedAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public RuntimeJob() {}

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
    public UUID getOperationId() { return operationId; }
    public void setOperationId(UUID operationId) { this.operationId = operationId; }
    public UUID getOperationItemId() { return operationItemId; }
    public void setOperationItemId(UUID operationItemId) { this.operationItemId = operationItemId; }
    public UUID getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(UUID workspaceId) { this.workspaceId = workspaceId; }
    public UUID getRunId() { return runId; }
    public void setRunId(UUID runId) { this.runId = runId; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public String getCommandSummary() { return commandSummary; }
    public void setCommandSummary(String commandSummary) { this.commandSummary = commandSummary; }
    public Long getPid() { return pid; }
    public void setPid(Long pid) { this.pid = pid; }
    public Integer getExitCode() { return exitCode; }
    public void setExitCode(Integer exitCode) { this.exitCode = exitCode; }
    public String getErrorCode() { return errorCode; }
    public void setErrorCode(String errorCode) { this.errorCode = errorCode; }
    public Boolean getOutputAvailable() { return outputAvailable; }
    public void setOutputAvailable(Boolean outputAvailable) { this.outputAvailable = outputAvailable; }
    public String getOutputRef() { return outputRef; }
    public void setOutputRef(String outputRef) { this.outputRef = outputRef; }
    public String getOwnerId() { return ownerId; }
    public void setOwnerId(String ownerId) { this.ownerId = ownerId; }
    public Instant getLeaseExpiresAt() { return leaseExpiresAt; }
    public void setLeaseExpiresAt(Instant leaseExpiresAt) { this.leaseExpiresAt = leaseExpiresAt; }
    public Instant getStartedAt() { return startedAt; }
    public void setStartedAt(Instant startedAt) { this.startedAt = startedAt; }
    public Instant getFinishedAt() { return finishedAt; }
    public void setFinishedAt(Instant finishedAt) { this.finishedAt = finishedAt; }
    public Instant getOrphanedAt() { return orphanedAt; }
    public void setOrphanedAt(Instant orphanedAt) { this.orphanedAt = orphanedAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
