package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "workspaces")
public class Workspace {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id", length = 36)
    private String id;

    @Column(nullable = false, length = 255)
    private String name;

    @Column(columnDefinition = "TEXT")
    private String description;

    @Column(name = "owner_id", nullable = false, length = 36)
    private String ownerId;

    @Column(columnDefinition = "TEXT")
    private String settings;

    @Column(name = "storage_path", length = 512)
    private String storagePath;

    @Column(name = "storage_backend", length = 32)
    private String storageBackend = "host_directory";

    @Column(name = "storage_ref", length = 64)
    private String storageRef;

    @Column(name = "generation")
    private Integer generation = 0;

    @Column(name = "sandbox_spec_hash", length = 64)
    private String sandboxSpecHash;

    @Column(name = "sandbox_spec", columnDefinition = "JSONB")
    private String sandboxSpec;

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

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public String getOwnerId() { return ownerId; }
    public void setOwnerId(String ownerId) { this.ownerId = ownerId; }

    public String getSettings() { return settings; }
    public void setSettings(String settings) { this.settings = settings; }

    public String getStoragePath() { return storagePath; }
    public void setStoragePath(String storagePath) { this.storagePath = storagePath; }

    public String getStorageBackend() { return storageBackend; }
    public void setStorageBackend(String storageBackend) { this.storageBackend = storageBackend; }

    public String getStorageRef() { return storageRef; }
    public void setStorageRef(String storageRef) { this.storageRef = storageRef; }

    public Integer getGeneration() { return generation; }
    public void setGeneration(Integer generation) { this.generation = generation; }

    public String getSandboxSpecHash() { return sandboxSpecHash; }
    public void setSandboxSpecHash(String sandboxSpecHash) { this.sandboxSpecHash = sandboxSpecHash; }

    public String getSandboxSpec() { return sandboxSpec; }
    public void setSandboxSpec(String sandboxSpec) { this.sandboxSpec = sandboxSpec; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
