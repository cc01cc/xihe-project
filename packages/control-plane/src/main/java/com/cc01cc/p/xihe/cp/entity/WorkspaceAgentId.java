package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;

import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

@Embeddable
public class WorkspaceAgentId implements Serializable {

    @Column(name = "principal_id", columnDefinition = "uuid")
    private UUID principalId;

    @Column(name = "workspace_id", columnDefinition = "uuid")
    private UUID workspaceId;

    public WorkspaceAgentId() {}

    public WorkspaceAgentId(UUID principalId, UUID workspaceId) {
        this.principalId = principalId;
        this.workspaceId = workspaceId;
    }

    public WorkspaceAgentId(String principalId, String workspaceId) {
        this(UUID.fromString(principalId), UUID.fromString(workspaceId));
    }

    public UUID getPrincipalId() { return principalId; }
    public void setPrincipalId(UUID principalId) { this.principalId = principalId; }

    public UUID getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(UUID workspaceId) { this.workspaceId = workspaceId; }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof WorkspaceAgentId that)) return false;
        return Objects.equals(principalId, that.principalId) && Objects.equals(workspaceId, that.workspaceId);
    }

    @Override
    public int hashCode() {
        return Objects.hash(principalId, workspaceId);
    }
}
