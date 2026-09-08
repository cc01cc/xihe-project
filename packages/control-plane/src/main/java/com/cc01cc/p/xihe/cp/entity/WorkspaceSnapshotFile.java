package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * Per-file record within a workspace snapshot (PLAN-275 M1).
 */
@Entity
@Table(name = "workspace_snapshot_files")
public class WorkspaceSnapshotFile {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(columnDefinition = "uuid")
    private UUID id;

    @Column(name = "snapshot_id", nullable = false, columnDefinition = "uuid")
    private UUID snapshotId;

    @Column(name = "relative_path", nullable = false, columnDefinition = "TEXT")
    private String relativePath;

    @Column(name = "existed_before", nullable = false)
    private Boolean existedBefore;

    @Column(name = "content_hash", nullable = false, length = 64)
    private String contentHash;

    @Column(name = "size_bytes", nullable = false)
    private Long sizeBytes;

    @Column
    private Short mode;

    @Column(name = "content_ref", nullable = false, columnDefinition = "TEXT")
    private String contentRef;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public WorkspaceSnapshotFile() {}

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public UUID getSnapshotId() { return snapshotId; }
    public void setSnapshotId(UUID snapshotId) { this.snapshotId = snapshotId; }
    public String getRelativePath() { return relativePath; }
    public void setRelativePath(String relativePath) { this.relativePath = relativePath; }
    public Boolean getExistedBefore() { return existedBefore; }
    public void setExistedBefore(Boolean existedBefore) { this.existedBefore = existedBefore; }
    public String getContentHash() { return contentHash; }
    public void setContentHash(String contentHash) { this.contentHash = contentHash; }
    public Long getSizeBytes() { return sizeBytes; }
    public void setSizeBytes(Long sizeBytes) { this.sizeBytes = sizeBytes; }
    public Short getMode() { return mode; }
    public void setMode(Short mode) { this.mode = mode; }
    public String getContentRef() { return contentRef; }
    public void setContentRef(String contentRef) { this.contentRef = contentRef; }
    public Instant getCreatedAt() { return createdAt; }
}
