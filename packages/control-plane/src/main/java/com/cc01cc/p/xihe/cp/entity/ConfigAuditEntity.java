package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "config_audit")
public class ConfigAuditEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "config_id", nullable = false)
    @Convert(converter = UuidStringConverter.class)
    private String configId;

    @Column(length = 32)
    private String environment;

    @Column(length = 24)
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

    /**
     * task-309 (user ruling b): which door's atom gate authorized this write — {@code h1}/{@code h2}/
     * {@code h3}, never free text (the DB CHECK pins the same domain). NULL means the write passed no
     * atom gate (Flyway seeds, admin bypass, template domain writers).
     */
    @Column(name = "atom_source", length = 24)
    private String atomSource;

    @Column(name = "changed_at", nullable = false)
    private Instant changedAt;

    public ConfigAuditEntity() {}

    @PrePersist
    protected void onCreate() {
        changedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public String getConfigId() { return configId; }
    public void setConfigId(String configId) { this.configId = configId; }

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

    /** task-309: enumerated door id (h1/h2/h3) or null when the write passed no atom gate. */
    public String getAtomSource() { return atomSource; }

    public void setAtomSource(String atomSource) { this.atomSource = atomSource; }

    public Instant getChangedAt() { return changedAt; }
    public void setChangedAt(Instant changedAt) { this.changedAt = changedAt; }
}
