package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "workspace_assignments", indexes = {
    @Index(name = "idx_workspace_assignments_workspace_generation", columnList = "workspace_id, generation")
})
public class WorkspaceAssignment {

    @Id
    @GeneratedValue(strategy = GenerationType.AUTO)
    @Column(name = "id", columnDefinition = "UUID")
    private String id;

    @Column(name = "workspace_id", nullable = false, length = 36)
    private String workspaceId;

    @Column(nullable = false)
    private Integer generation;

    @Column(name = "sandbox_spec_hash", nullable = false, length = 64)
    private String sandboxSpecHash;

    @Column(name = "sandbox_spec", nullable = false, columnDefinition = "JSONB")
    private String sandboxSpec;

    @Column(name = "storage_backend", nullable = false, length = 32)
    private String storageBackend = "host_directory";

    @Column(name = "storage_ref", nullable = false, length = 64)
    private String storageRef;

    @Column(length = 255)
    private String actor;

    @Column(length = 512)
    private String reason;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public WorkspaceAssignment() {}

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }
    public Integer getGeneration() { return generation; }
    public void setGeneration(Integer generation) { this.generation = generation; }
    public String getSandboxSpecHash() { return sandboxSpecHash; }
    public void setSandboxSpecHash(String sandboxSpecHash) { this.sandboxSpecHash = sandboxSpecHash; }
    public String getSandboxSpec() { return sandboxSpec; }
    public void setSandboxSpec(String sandboxSpec) { this.sandboxSpec = sandboxSpec; }
    public String getStorageBackend() { return storageBackend; }
    public void setStorageBackend(String storageBackend) { this.storageBackend = storageBackend; }
    public String getStorageRef() { return storageRef; }
    public void setStorageRef(String storageRef) { this.storageRef = storageRef; }
    public String getActor() { return actor; }
    public void setActor(String actor) { this.actor = actor; }
    public String getReason() { return reason; }
    public void setReason(String reason) { this.reason = reason; }
    public Instant getCreatedAt() { return createdAt; }
}
