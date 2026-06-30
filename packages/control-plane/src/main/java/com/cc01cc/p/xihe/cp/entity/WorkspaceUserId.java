package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import java.io.Serializable;
import java.util.Objects;

@Embeddable
public class WorkspaceUserId implements Serializable {

    @Column(name = "workspace_id", length = 36)
    private String workspaceId;

    @Column(name = "user_id", length = 36)
    private String userId;

    public WorkspaceUserId() {}

    public WorkspaceUserId(String workspaceId, String userId) {
        this.workspaceId = workspaceId;
        this.userId = userId;
    }

    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

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
