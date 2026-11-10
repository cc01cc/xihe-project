package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/** Remote (HTTP + OAuth) MCP servers; V12 renamed the table to mcp_remote_servers. */
@Entity
@Table(name = "mcp_remote_servers")
public class McpServer {

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "workspace_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String workspaceId;

    @Column(nullable = false, length = 255)
    private String name;

    @Column(nullable = false, length = 512)
    private String endpoint;

    @Column(name = "auth_mode", nullable = false, length = 16)
    private String authMode = "oauth";

    @Column(nullable = false)
    private boolean enabled;

    // PLAN-301 M2: per-server tool execution timeout in seconds. NULL =
    // inherit the Agent-side global default (XIHE_MCP_TOOL_TIMEOUT_S).
    @Column(name = "tool_timeout_s")
    private Integer toolTimeoutS;

    // PLAN-0759 / BL-548: server-level OAuth client configuration (shared by all
    // users of the workspace). All nullable: rows created before the OAuth block
    // was persisted carry NULLs and stay valid as plain http endpoints.
    @Column(name = "oauth_client_id", length = 255)
    private String oauthClientId;

    @Column(name = "oauth_authorization_endpoint", length = 512)
    private String oauthAuthorizationEndpoint;

    @Column(name = "oauth_token_endpoint", length = 512)
    private String oauthTokenEndpoint;

    @Column(name = "oauth_redirect_uri", length = 512)
    private String oauthRedirectUri;

    @Column(name = "oauth_scope", length = 1024)
    private String oauthScope;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public McpServer() {}

    public McpServer(String workspaceId, String name, String endpoint) {
        this.workspaceId = workspaceId;
        this.name = name;
        this.endpoint = endpoint;
    }

    @PrePersist
    protected void onCreate() {
        if (id == null) {
            id = java.util.UUID.randomUUID();
        }
        createdAt = Instant.now();
        updatedAt = Instant.now();
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

    public String getEndpoint() { return endpoint; }
    public void setEndpoint(String endpoint) { this.endpoint = endpoint; }

    public String getAuthMode() { return authMode; }
    public void setAuthMode(String authMode) { this.authMode = authMode; }

    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }

    public Integer getToolTimeoutS() { return toolTimeoutS; }
    public void setToolTimeoutS(Integer toolTimeoutS) { this.toolTimeoutS = toolTimeoutS; }

    public String getOauthClientId() { return oauthClientId; }
    public void setOauthClientId(String oauthClientId) { this.oauthClientId = oauthClientId; }

    public String getOauthAuthorizationEndpoint() { return oauthAuthorizationEndpoint; }
    public void setOauthAuthorizationEndpoint(String oauthAuthorizationEndpoint) { this.oauthAuthorizationEndpoint = oauthAuthorizationEndpoint; }

    public String getOauthTokenEndpoint() { return oauthTokenEndpoint; }
    public void setOauthTokenEndpoint(String oauthTokenEndpoint) { this.oauthTokenEndpoint = oauthTokenEndpoint; }

    public String getOauthRedirectUri() { return oauthRedirectUri; }
    public void setOauthRedirectUri(String oauthRedirectUri) { this.oauthRedirectUri = oauthRedirectUri; }

    public String getOauthScope() { return oauthScope; }
    public void setOauthScope(String oauthScope) { this.oauthScope = oauthScope; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
