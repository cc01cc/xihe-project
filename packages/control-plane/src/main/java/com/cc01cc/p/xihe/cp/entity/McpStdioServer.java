package com.cc01cc.p.xihe.cp.entity;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;
import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0307 decision #27: stdio MCP servers (Claude Desktop format) live in
 * their own carrier table; the config table is pure instance/user/workspace KV.
 */
@Entity
@Table(name = "mcp_stdio_servers")
public class McpStdioServer {

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "workspace_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String workspaceId;

    @Column(nullable = false, length = 255)
    private String name;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "config", columnDefinition = "jsonb")
    private JsonNode config;

    @Column(nullable = false)
    private boolean enabled = true;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public McpStdioServer() {}

    public McpStdioServer(String workspaceId, String name, JsonNode config) {
        this.workspaceId = workspaceId;
        this.name = name;
        this.config = config;
    }

    @PrePersist
    protected void onCreate() {
        if (id == null) id = UUID.randomUUID();
        Instant now = Instant.now();
        createdAt = now;
        updatedAt = now;
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public JsonNode getConfig() { return config; }
    public void setConfig(JsonNode config) { this.config = config; }

    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
