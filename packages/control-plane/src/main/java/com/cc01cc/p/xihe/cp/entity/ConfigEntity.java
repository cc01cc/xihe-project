package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0307 decision #37: three-tier config rows bound by scope columns.
 * layer=instance -> user_id/workspace_id NULL; layer=user -> user_id set;
 * layer=workspace -> workspace_id set. Partial unique indexes live in V12.
 */
@Entity
@Table(name = "config")
public class ConfigEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false, length = 16)
    private String layer;

    @Column(name = "user_id")
    private UUID userId;

    @Column(name = "workspace_id")
    private UUID workspaceId;

    @Column(nullable = false, length = 32)
    private String domain;

    @Column(name = "config_key", nullable = false, length = 64)
    private String configKey;

    @Column(name = "config_value", columnDefinition = "TEXT")
    private String configValue;

    @Column(name = "updated_by", length = 64)
    private String updatedBy;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public ConfigEntity() {}

    @PrePersist
    protected void onCreate() {
        Instant now = Instant.now();
        if (createdAt == null) {
            createdAt = now;
        }
        updatedAt = now;
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public String getLayer() { return layer; }
    public void setLayer(String layer) { this.layer = layer; }

    public UUID getUserId() { return userId; }
    public void setUserId(UUID userId) { this.userId = userId; }

    public UUID getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(UUID workspaceId) { this.workspaceId = workspaceId; }

    public String getDomain() { return domain; }
    public void setDomain(String domain) { this.domain = domain; }

    public String getConfigKey() { return configKey; }
    public void setConfigKey(String configKey) { this.configKey = configKey; }

    public String getConfigValue() { return configValue; }
    public void setConfigValue(String configValue) { this.configValue = configValue; }

    public String getUpdatedBy() { return updatedBy; }
    public void setUpdatedBy(String updatedBy) { this.updatedBy = updatedBy; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
