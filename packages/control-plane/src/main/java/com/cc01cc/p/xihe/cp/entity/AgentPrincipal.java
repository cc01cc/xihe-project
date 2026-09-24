package com.cc01cc.p.xihe.cp.entity;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "agent_principals")
public class AgentPrincipal {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "name", nullable = false, columnDefinition = "TEXT")
    private String name;

    @Column(name = "template_id", columnDefinition = "TEXT")
    private String templateId;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "template_snapshot", columnDefinition = "jsonb")
    private JsonNode templateSnapshot;

    @Column(name = "created_by_user_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String createdByUserId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "disabled_at")
    private Instant disabledAt;

    public AgentPrincipal() {}

    @PrePersist
    protected void onCreate() {
        if (id == null) {
            id = UUID.randomUUID();
        }
        if (createdAt == null) {
            createdAt = Instant.now();
        }
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getTemplateId() { return templateId; }
    public void setTemplateId(String templateId) { this.templateId = templateId; }

    public JsonNode getTemplateSnapshot() { return templateSnapshot; }
    public void setTemplateSnapshot(JsonNode templateSnapshot) { this.templateSnapshot = templateSnapshot; }

    public String getCreatedByUserId() { return createdByUserId; }
    public void setCreatedByUserId(String createdByUserId) { this.createdByUserId = createdByUserId; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getDisabledAt() { return disabledAt; }
    public void setDisabledAt(Instant disabledAt) { this.disabledAt = disabledAt; }
}
