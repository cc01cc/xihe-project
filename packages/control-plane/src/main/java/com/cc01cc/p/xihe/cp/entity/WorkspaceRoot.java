package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0639 M1: one root of a multi-root workspace.
 *
 * <p>Root[0] (position = 0) has {@code id = workspaceId} (primary-root invariant).
 * Shadow repos are per-root ({@code <hostRoot>/.xihe-shadow/<rootId>.git}); the row here
 * is the CP-side durable record that both the execution spec and the read projection consume.</p>
 */
@Entity
@Table(name = "workspace_roots")
public class WorkspaceRoot {

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "workspace_id", nullable = false, columnDefinition = "uuid")
    private UUID workspaceId;

    @Column(name = "position", nullable = false)
    private Integer position = 0;

    @Column(name = "alias", length = 128)
    private String alias;

    @Column(name = "host_path", nullable = false, columnDefinition = "TEXT")
    private String hostPath;

    @Column(name = "created_by", nullable = false, length = 64)
    private String createdBy;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "deleted_at")
    private Instant deletedAt;

    public WorkspaceRoot() {}

    public WorkspaceRoot(UUID id, UUID workspaceId, Integer position, String hostPath, String createdBy) {
        this.id = id;
        this.workspaceId = workspaceId;
        this.position = position;
        this.hostPath = hostPath;
        this.createdBy = createdBy;
    }

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
    }

    public UUID getId() {
        return id;
    }

    public void setId(UUID id) {
        this.id = id;
    }

    public UUID getWorkspaceId() {
        return workspaceId;
    }

    public void setWorkspaceId(UUID workspaceId) {
        this.workspaceId = workspaceId;
    }

    public Integer getPosition() {
        return position;
    }

    public void setPosition(Integer position) {
        this.position = position;
    }

    public String getAlias() {
        return alias;
    }

    public void setAlias(String alias) {
        this.alias = alias;
    }

    public String getHostPath() {
        return hostPath;
    }

    public void setHostPath(String hostPath) {
        this.hostPath = hostPath;
    }

    public String getCreatedBy() {
        return createdBy;
    }

    public void setCreatedBy(String createdBy) {
        this.createdBy = createdBy;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getDeletedAt() {
        return deletedAt;
    }

    public void setDeletedAt(Instant deletedAt) {
        this.deletedAt = deletedAt;
    }
}
