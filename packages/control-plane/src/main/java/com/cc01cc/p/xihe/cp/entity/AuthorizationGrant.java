package com.cc01cc.p.xihe.cp.entity;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

/** permissions stores the canonical PLAN-0407 permission atom array. */
@Entity
@Table(name = "grants")
public class AuthorizationGrant {

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "granter_type", length = 24)
    private String granterType;

    @Column(name = "granter_id", columnDefinition = "uuid")
    private UUID granterId;

    @Column(name = "subject_type", nullable = false, length = 24)
    private String subjectType;

    @Column(name = "subject_id", nullable = false, columnDefinition = "uuid")
    private UUID subjectId;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "permissions", nullable = false, columnDefinition = "jsonb")
    private JsonNode permissions;

    @Column(name = "source", nullable = false, length = 16)
    private String source;

    @Column(name = "role_name", columnDefinition = "TEXT")
    private String roleName;

    @Column(name = "template_name", columnDefinition = "TEXT")
    private String templateName;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "read_state", nullable = false, length = 16)
    private String readState = "unread";

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

    public String getGranterType() { return granterType; }
    public void setGranterType(String granterType) { this.granterType = granterType; }

    public UUID getGranterId() { return granterId; }
    public void setGranterId(UUID granterId) { this.granterId = granterId; }

    public String getSubjectType() { return subjectType; }
    public void setSubjectType(String subjectType) { this.subjectType = subjectType; }

    public UUID getSubjectId() { return subjectId; }
    public void setSubjectId(UUID subjectId) { this.subjectId = subjectId; }

    public JsonNode getPermissions() { return permissions; }
    public void setPermissions(JsonNode permissions) { this.permissions = permissions; }

    public String getSource() { return source; }
    public void setSource(String source) { this.source = source; }

    public String getRoleName() { return roleName; }
    public void setRoleName(String roleName) { this.roleName = roleName; }

    public String getTemplateName() { return templateName; }
    public void setTemplateName(String templateName) { this.templateName = templateName; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public String getReadState() { return readState; }
    public void setReadState(String readState) { this.readState = readState; }
}
