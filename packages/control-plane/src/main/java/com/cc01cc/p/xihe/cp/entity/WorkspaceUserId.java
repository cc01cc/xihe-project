package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

@Embeddable
public class WorkspaceUserId implements Serializable {

    @Column(name = "workspace_id", columnDefinition = "uuid")
    private UUID workspaceId;

    @Column(name = "user_id", columnDefinition = "uuid")
    private UUID userId;

    public WorkspaceUserId() {}

    public WorkspaceUserId(String workspaceId, String userId) {
        this.workspaceId = UUID.fromString(workspaceId);
        this.userId = UUID.fromString(userId);
    }

    public UUID getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(UUID workspaceId) { this.workspaceId = workspaceId; }

    public UUID getUserId() { return userId; }
    public void setUserId(UUID userId) { this.userId = userId; }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof WorkspaceUserId that)) return false;
        return Objects.equals(workspaceId, that.workspaceId) && Objects.equals(userId, that.userId);
    }

    @Override
    public int hashCode() {
        return Objects.hash(workspaceId, userId);
    }
}
