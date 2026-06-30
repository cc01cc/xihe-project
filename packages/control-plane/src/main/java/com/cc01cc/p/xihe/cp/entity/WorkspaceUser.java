package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "workspace_users")
public class WorkspaceUser {

    @EmbeddedId
    private WorkspaceUserId id;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private WorkspaceRole role;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public WorkspaceUser() {}

    public WorkspaceUser(String workspaceId, String userId, WorkspaceRole role) {
        this.id = new WorkspaceUserId(workspaceId, userId);
        this.role = role;
    }

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
    }

    public WorkspaceUserId getId() { return id; }
    public void setId(WorkspaceUserId id) { this.id = id; }

    public WorkspaceRole getRole() { return role; }
    public void setRole(WorkspaceRole role) { this.role = role; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
