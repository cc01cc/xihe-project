package com.cc01cc.p.xihe.cp.entity;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.Column;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;

@Entity
@Table(name = "workspace_agents")
public class WorkspaceAgent {

    @EmbeddedId
    private WorkspaceAgentId id;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "permissions_snapshot", nullable = false, columnDefinition = "jsonb")
    private JsonNode permissionsSnapshot;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public WorkspaceAgent() {}

    public WorkspaceAgent(String principalId, String workspaceId, JsonNode permissionsSnapshot) {
        this.id = new WorkspaceAgentId(principalId, workspaceId);
        this.permissionsSnapshot = permissionsSnapshot;
    }

    @PrePersist
    protected void onCreate() {
        if (createdAt == null) {
            createdAt = Instant.now();
        }
    }

    public WorkspaceAgentId getId() { return id; }
    public void setId(WorkspaceAgentId id) { this.id = id; }

    public JsonNode getPermissionsSnapshot() { return permissionsSnapshot; }
    public void setPermissionsSnapshot(JsonNode permissionsSnapshot) { this.permissionsSnapshot = permissionsSnapshot; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
