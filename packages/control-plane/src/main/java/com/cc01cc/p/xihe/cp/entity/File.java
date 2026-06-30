package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "files")
public class File {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id", length = 36)
    private String id;

    @Column(name = "user_id", nullable = false, length = 36)
    private String userId;

    @Column(name = "workspace_id", length = 36)
    private String workspaceId;

    @Column(nullable = false, length = 255)
    private String filename;

    @Column(name = "mime_type", length = 127)
    private String mimeType;

    @Column(name = "size_bytes")
    private long sizeBytes;

    @Column(name = "storage_path", nullable = false, length = 512)
    private String storagePath;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public File() {}

    public File(String userId, String filename, String storagePath) {
        this.userId = userId;
        this.filename = filename;
        this.storagePath = storagePath;
    }

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }

    public String getFilename() { return filename; }
    public void setFilename(String filename) { this.filename = filename; }

    public String getMimeType() { return mimeType; }
    public void setMimeType(String mimeType) { this.mimeType = mimeType; }

    public long getSizeBytes() { return sizeBytes; }
    public void setSizeBytes(long sizeBytes) { this.sizeBytes = sizeBytes; }

    public String getStoragePath() { return storagePath; }
    public void setStoragePath(String storagePath) { this.storagePath = storagePath; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
