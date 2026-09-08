package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * Typed audit payload (llm_usage, mcp_call, ...) attached to an item or an
 * attempt. At least one target must be non-null; schema_version carries
 * forward-compatible payload evolution (late corrections append new versions
 * instead of overwriting existing audit facts).
 */
@Entity
@Table(name = "operation_extensions")
public class OperationExtension {

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "item_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String itemId;

    @Column(name = "attempt_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String attemptId;

    @Column(name = "extension_kind", nullable = false, length = 40)
    private String extensionKind;

    @Column(name = "schema_version", nullable = false)
    private Integer schemaVersion;

    @Column(nullable = false, columnDefinition = "JSONB")
    @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
    private String payload;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public OperationExtension() {}

    public OperationExtension(String itemId, String attemptId, String extensionKind,
                              Integer schemaVersion, String payload) {
        this.itemId = itemId;
        this.attemptId = attemptId;
        this.extensionKind = extensionKind;
        this.schemaVersion = schemaVersion;
        this.payload = payload;
    }

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getItemId() { return itemId; }
    public void setItemId(String itemId) { this.itemId = itemId; }
    public String getAttemptId() { return attemptId; }
    public void setAttemptId(String attemptId) { this.attemptId = attemptId; }
    public String getExtensionKind() { return extensionKind; }
    public void setExtensionKind(String extensionKind) { this.extensionKind = extensionKind; }
    public Integer getSchemaVersion() { return schemaVersion; }
    public void setSchemaVersion(Integer schemaVersion) { this.schemaVersion = schemaVersion; }
    public String getPayload() { return payload; }
    public void setPayload(String payload) { this.payload = payload; }
    public Instant getCreatedAt() { return createdAt; }
}
