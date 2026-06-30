package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;
import java.time.Instant;

@Entity
@Table(name = "config", uniqueConstraints = {
    @UniqueConstraint(columnNames = {"environment", "layer", "domain", "config_key"})
})
public class ConfigEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 32)
    private String environment = "default";

    @Column(nullable = false, length = 16)
    private String layer;

    @Column(nullable = false, length = 32)
    private String domain;

    @Column(name = "config_key", nullable = false, length = 64)
    private String configKey;

    @Column(name = "config_value", columnDefinition = "TEXT")
    private String configValue;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "mcp_config", columnDefinition = "jsonb")
    private String mcpConfig;

    @Column(name = "is_set", nullable = false)
    private Boolean isSet = true;

    @Column(name = "updated_by", length = 64)
    private String updatedBy;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public ConfigEntity() {}

    @PrePersist
    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public String getEnvironment() { return environment; }
    public void setEnvironment(String environment) { this.environment = environment; }

    public String getLayer() { return layer; }
    public void setLayer(String layer) { this.layer = layer; }

    public String getDomain() { return domain; }
    public void setDomain(String domain) { this.domain = domain; }

    public String getConfigKey() { return configKey; }
    public void setConfigKey(String configKey) { this.configKey = configKey; }

    public String getConfigValue() { return configValue; }
    public void setConfigValue(String configValue) { this.configValue = configValue; }

    public String getMcpConfig() { return mcpConfig; }
    public void setMcpConfig(String mcpConfig) { this.mcpConfig = mcpConfig; }

    public Boolean getIsSet() { return isSet; }
    public void setIsSet(Boolean isSet) { this.isSet = isSet; }

    public String getUpdatedBy() { return updatedBy; }
    public void setUpdatedBy(String updatedBy) { this.updatedBy = updatedBy; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
