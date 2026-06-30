package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "config_audit")
public class ConfigAuditEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "config_id", nullable = false)
    private Long configId;

    @Column(length = 32)
    private String environment;

    @Column(length = 16)
    private String layer;

    @Column(length = 32)
    private String domain;

    @Column(name = "config_key", length = 64)
    private String configKey;

    @Column(name = "old_value", columnDefinition = "TEXT")
    private String oldValue;

    @Column(name = "new_value", columnDefinition = "TEXT")
    private String newValue;

    @Column(name = "changed_by", length = 64)
    private String changedBy;

    @Column(name = "changed_at", nullable = false)
    private Instant changedAt;

    public ConfigAuditEntity() {}

    @PrePersist
    protected void onCreate() {
        changedAt = Instant.now();
    }

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public Long getConfigId() { return configId; }
    public void setConfigId(Long configId) { this.configId = configId; }

    public String getEnvironment() { return environment; }
    public void setEnvironment(String environment) { this.environment = environment; }

    public String getLayer() { return layer; }
    public void setLayer(String layer) { this.layer = layer; }

    public String getDomain() { return domain; }
    public void setDomain(String domain) { this.domain = domain; }

    public String getConfigKey() { return configKey; }
    public void setConfigKey(String configKey) { this.configKey = configKey; }

    public String getOldValue() { return oldValue; }
    public void setOldValue(String oldValue) { this.oldValue = oldValue; }

    public String getNewValue() { return newValue; }
    public void setNewValue(String newValue) { this.newValue = newValue; }

    public String getChangedBy() { return changedBy; }
    public void setChangedBy(String changedBy) { this.changedBy = changedBy; }

    public Instant getChangedAt() { return changedAt; }
    public void setChangedAt(Instant changedAt) { this.changedAt = changedAt; }
}
