package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Convert;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Convert;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Convert;
import jakarta.persistence.Id;
import jakarta.persistence.Convert;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Convert;
import jakarta.persistence.Table;
import jakarta.persistence.Convert;
import jakarta.persistence.Index;
import jakarta.persistence.Convert;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

/** The current desired execution configuration for one logical workspace. */
@Entity
@Table(name = "workspace_execution_specs", indexes = {
    @Index(name = "idx_workspace_execution_specs_workspace_generation", columnList = "workspace_id, generation")
})
public class WorkspaceExecutionSpec {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id", columnDefinition = "UUID")
    private UUID id;

    @Column(name = "workspace_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String workspaceId;

    @Column(nullable = false)
    private Integer generation;

    @Column(name = "sandbox_spec_hash", nullable = false, length = 64)
    private String sandboxSpecHash;

    @Column(name = "sandbox_spec", nullable = false, columnDefinition = "JSONB")
    @JdbcTypeCode(SqlTypes.JSON)
    private String sandboxSpec;

    @Column(name = "storage_backend", nullable = false, length = 32)
    private String storageBackend;

    @Column(name = "storage_ref", nullable = false, length = 64)
    private String storageRef;

    @Column(length = 255)
    private String actor;

    @Column(length = 512)
    private String reason;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @PrePersist
    protected void onCreate() {
        if (createdAt == null) {
            createdAt = Instant.now();
        }
    }

    public UUID getId() {
        return id;
    }

    public void setId(UUID id) {
        this.id = id;
    }

    public String getWorkspaceId() {
        return workspaceId;
    }

    public void setWorkspaceId(String workspaceId) {
        this.workspaceId = workspaceId;
    }

    public Integer getGeneration() {
        return generation;
    }

    public void setGeneration(Integer generation) {
        this.generation = generation;
    }

    public String getSandboxSpecHash() {
        return sandboxSpecHash;
    }

    public void setSandboxSpecHash(String sandboxSpecHash) {
        this.sandboxSpecHash = sandboxSpecHash;
    }

    public String getSandboxSpec() {
        return sandboxSpec;
    }

    public void setSandboxSpec(String sandboxSpec) {
        this.sandboxSpec = sandboxSpec;
    }

    public String getStorageBackend() {
        return storageBackend;
    }

    public void setStorageBackend(String storageBackend) {
        this.storageBackend = storageBackend;
    }

    public String getStorageRef() {
        return storageRef;
    }

    public void setStorageRef(String storageRef) {
        this.storageRef = storageRef;
    }

    public String getActor() {
        return actor;
    }

    public void setActor(String actor) {
        this.actor = actor;
    }

    public String getReason() {
        return reason;
    }

    public void setReason(String reason) {
        this.reason = reason;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(Instant createdAt) {
        this.createdAt = createdAt;
    }
}
