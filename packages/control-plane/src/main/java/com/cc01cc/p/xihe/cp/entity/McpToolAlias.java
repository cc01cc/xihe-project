package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.*;
import java.io.Serializable;
import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * Sticky tool-name alias rows (PLAN-242 M2).
 * issued_name is the name once published to Agents via tools/list and never
 * reassigned (no promotion): history replay joins on
 * (workspace_id, server_id, backend_name, generation), never on the live name.
 */
@Entity
@Table(name = "mcp_tool_aliases")
@IdClass(McpToolAlias.McpToolAliasId.class)
public class McpToolAlias {

    @Id
    @Column(name = "workspace_id", nullable = false, columnDefinition = "uuid")
    private UUID workspaceId;

    @Id
    @Column(name = "issued_name", nullable = false, length = 255)
    private String issuedName;

    @Column(name = "server_id", nullable = false, columnDefinition = "uuid")
    private UUID serverId;

    @Column(name = "backend_name", nullable = false, length = 255)
    private String backendName;

    @Column(name = "generation", nullable = false)
    private long generation;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public McpToolAlias() {}

    public McpToolAlias(String workspaceId, String issuedName, String serverId,
                        String backendName, long generation) {
        this.workspaceId = UUID.fromString(workspaceId);
        this.issuedName = issuedName;
        this.serverId = UUID.fromString(serverId);
        this.backendName = backendName;
        this.generation = generation;
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

    public UUID getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(UUID workspaceId) { this.workspaceId = workspaceId; }

    public String getIssuedName() { return issuedName; }
    public void setIssuedName(String issuedName) { this.issuedName = issuedName; }

    public UUID getServerId() { return serverId; }
    public void setServerId(UUID serverId) { this.serverId = serverId; }

    public String getBackendName() { return backendName; }
    public void setBackendName(String backendName) { this.backendName = backendName; }

    public long getGeneration() { return generation; }
    public void setGeneration(long generation) { this.generation = generation; }

    public static class McpToolAliasId implements Serializable {
        private UUID workspaceId;
        private String issuedName;

        public McpToolAliasId() {}

        public McpToolAliasId(UUID workspaceId, String issuedName) {
            this.workspaceId = workspaceId;
            this.issuedName = issuedName;
        }

        @Override
        public boolean equals(Object other) {
            if (this == other) return true;
            if (!(other instanceof McpToolAliasId that)) return false;
            return Objects.equals(workspaceId, that.workspaceId)
                    && Objects.equals(issuedName, that.issuedName);
        }

        @Override
        public int hashCode() {
            return Objects.hash(workspaceId, issuedName);
        }
    }
}
