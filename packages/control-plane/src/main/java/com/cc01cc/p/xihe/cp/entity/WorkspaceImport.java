package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

@Entity
@Table(name = "workspace_imports")
public class WorkspaceImport {

    @Id
    @Column(columnDefinition = "uuid")
    private UUID id;

    @Column(name = "workspace_id", nullable = false, columnDefinition = "uuid")
    private UUID workspaceId;

    @Column(name = "owner_id", nullable = false, length = 36)
    private String ownerId;

    @Column(name = "source_path", nullable = false, columnDefinition = "TEXT")
    private String sourcePath;

    @Column(name = "exclude_rules", nullable = false, columnDefinition = "TEXT")
    private String excludeRules = "[]";

    @Column(name = "idempotency_key", nullable = false, length = 255)
    private String idempotencyKey;

    @Column(nullable = false, length = 32)
    private String status = "queued";

    @Column(name = "files_scanned", nullable = false)
    private long filesScanned;

    @Column(name = "files_copied", nullable = false)
    private long filesCopied;

    @Column(name = "files_skipped", nullable = false)
    private long filesSkipped;

    @Column(name = "bytes_copied", nullable = false)
    private long bytesCopied;

    @Column(name = "bytes_skipped", nullable = false)
    private long bytesSkipped;

    @Column(name = "current_file_path", columnDefinition = "TEXT")
    private String currentPath;

    @Column(name = "error_code", length = 96)
    private String errorCode;

    @Column(name = "error_detail", columnDefinition = "TEXT")
    private String errorDetail;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Column(name = "started_at")
    private Instant startedAt;

    @Column(name = "completed_at")
    private Instant completedAt;

    protected WorkspaceImport() {}

    public WorkspaceImport(UUID workspaceId, String ownerId, String sourcePath,
                           String excludeRules, String idempotencyKey) {
        this.id = UUID.randomUUID();
        this.workspaceId = workspaceId;
        this.ownerId = ownerId;
        this.sourcePath = sourcePath;
        this.excludeRules = excludeRules == null ? "[]" : excludeRules;
        this.idempotencyKey = idempotencyKey;
    }

    @PrePersist
    void onCreate() {
        Instant now = Instant.now();
        createdAt = now;
        updatedAt = now;
    }

    @PreUpdate
    void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public UUID getWorkspaceId() { return workspaceId; }
    public String getOwnerId() { return ownerId; }
    public String getSourcePath() { return sourcePath; }
    public String getExcludeRules() { return excludeRules; }
    public String getIdempotencyKey() { return idempotencyKey; }
    public String getStatus() { return status; }
    public long getFilesScanned() { return filesScanned; }
    public long getFilesCopied() { return filesCopied; }
    public long getFilesSkipped() { return filesSkipped; }
    public long getBytesCopied() { return bytesCopied; }
    public long getBytesSkipped() { return bytesSkipped; }
    public String getCurrentPath() { return currentPath; }
    public String getErrorCode() { return errorCode; }
    public String getErrorDetail() { return errorDetail; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public Instant getStartedAt() { return startedAt; }
    public Instant getCompletedAt() { return completedAt; }

    public void cancel() { this.status = "cancelled"; this.completedAt = Instant.now(); }

    public void markRunning() { this.status = "running"; this.startedAt = Instant.now(); }

    public void markRuntimeFailure(String code, String detail) {
        this.status = "failed";
        this.errorCode = code;
        this.errorDetail = detail;
        this.completedAt = Instant.now();
    }

    public void applyRuntimeStatus(Map<String, Object> runtime) {
        Object statusValue = runtime.get("status");
        if (statusValue instanceof String value) this.status = value;
        this.filesScanned = number(runtime.get("filesScanned"), filesScanned);
        this.filesCopied = number(runtime.get("filesCopied"), filesCopied);
        this.filesSkipped = number(runtime.get("filesSkipped"), filesSkipped);
        this.bytesCopied = number(runtime.get("bytesCopied"), bytesCopied);
        this.bytesSkipped = number(runtime.get("bytesSkipped"), bytesSkipped);
        if (runtime.get("currentPath") instanceof String value) this.currentPath = value;
        if (runtime.get("errorCode") instanceof String value) this.errorCode = value;
        if (runtime.get("errorDetail") instanceof String value) this.errorDetail = value;
        if ("running".equals(status) && startedAt == null) startedAt = Instant.now();
        if ("completed".equals(status) || "cancelled".equals(status) || "failed".equals(status)) {
            completedAt = completedAt == null ? Instant.now() : completedAt;
        }
    }

    private static long number(Object value, long fallback) {
        return value instanceof Number number ? number.longValue() : fallback;
    }
}
