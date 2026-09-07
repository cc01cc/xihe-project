package com.cc01cc.p.xihe.cp.context.entity;

import jakarta.persistence.*;
import com.cc01cc.p.xihe.cp.entity.UuidStringConverter;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "context_source_hashes",
       uniqueConstraints = @UniqueConstraint(columnNames = {"workspace_id", "source_key"}))
public class ContextSourceHash {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id", length = 36)
    private UUID id;

    @Column(name = "workspace_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String workspaceId;

    @Column(name = "source_key", nullable = false, length = 255)
    private String sourceKey;

    @Column(name = "hash", nullable = false, length = 64)
    private String hash;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public ContextSourceHash() {}

    public ContextSourceHash(String workspaceId, String sourceKey, String hash) {
        this.workspaceId = workspaceId;
        this.sourceKey = sourceKey;
        this.hash = hash;
    }

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
        updatedAt = Instant.now();
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }

    public String getSourceKey() { return sourceKey; }
    public void setSourceKey(String sourceKey) { this.sourceKey = sourceKey; }

    public String getHash() { return hash; }
    public void setHash(String hash) { this.hash = hash; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
