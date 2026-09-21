package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "workspaces")
public class Workspace {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(nullable = false, length = 255)
    private String name;

    @Column(columnDefinition = "TEXT")
    private String description;

    @Column(name = "owner_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String ownerId;

    @Column(name = "storage_backend", length = 32)
    private String storageBackend = "host_directory";

    @Column(name = "storage_ref", length = 64)
    private String storageRef;

    @Column(name = "storage_mode", nullable = false, length = 32)
    private String storageMode = "managed_import";

    @Column(name = "host_path", columnDefinition = "TEXT")
    private String hostPath;

    @Column(name = "execution_mode", nullable = false, length = 32)
    private String executionMode = "docker";

    @Column(name = "create_idempotency_key", length = 128)
    private String createIdempotencyKey;

    @Column(name = "create_request_hash", length = 64)
    private String createRequestHash;

    @Column(name = "generation")
    private Integer generation = 0;

    @Column(name = "sandbox_spec_hash", length = 64)
    private String sandboxSpecHash;

    @Column(name = "sandbox_spec", columnDefinition = "JSONB")
    @JdbcTypeCode(SqlTypes.JSON)
    private String sandboxSpec;

    @Column(name = "deleted_at")
    private Instant deletedAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public Workspace() {}

    public Workspace(String name, String ownerId) {
        this.name = name;
        this.ownerId = ownerId;
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

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public String getOwnerId() { return ownerId; }
    public void setOwnerId(String ownerId) { this.ownerId = ownerId; }

    public String getStorageBackend() { return storageBackend; }
    public void setStorageBackend(String storageBackend) { this.storageBackend = storageBackend; }

    public String getStorageRef() { return storageRef; }
    public void setStorageRef(String storageRef) { this.storageRef = storageRef; }

    public String getStorageMode() { return storageMode; }
    public void setStorageMode(String storageMode) { this.storageMode = storageMode; }

    public String getHostPath() { return hostPath; }
    public void setHostPath(String hostPath) { this.hostPath = hostPath; }

    public String getExecutionMode() { return executionMode; }
    public void setExecutionMode(String executionMode) { this.executionMode = executionMode; }

    public String getCreateIdempotencyKey() { return createIdempotencyKey; }
    public void setCreateIdempotencyKey(String createIdempotencyKey) { this.createIdempotencyKey = createIdempotencyKey; }

    public String getCreateRequestHash() { return createRequestHash; }
    public void setCreateRequestHash(String createRequestHash) { this.createRequestHash = createRequestHash; }

    public Integer getGeneration() { return generation; }
    public void setGeneration(Integer generation) { this.generation = generation; }

    public String getSandboxSpecHash() { return sandboxSpecHash; }
    public void setSandboxSpecHash(String sandboxSpecHash) { this.sandboxSpecHash = sandboxSpecHash; }

    public String getSandboxSpec() { return sandboxSpec; }
    public void setSandboxSpec(String sandboxSpec) { this.sandboxSpec = sandboxSpec; }

    public Instant getDeletedAt() { return deletedAt; }
    public void setDeletedAt(Instant deletedAt) { this.deletedAt = deletedAt; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
