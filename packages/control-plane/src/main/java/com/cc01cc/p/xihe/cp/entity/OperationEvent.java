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
 * Append-only status transition history for the Operation Ledger.
 * Rows are never updated or deleted; aggregate state is recomputed from the
 * durable item/attempt rows, not from in-memory counters.
 */
@Entity
@Table(name = "operation_events")
public class OperationEvent {

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "operation_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String operationId;

    @Column(name = "item_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String itemId;

    @Column(name = "attempt_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String attemptId;

    @Column(nullable = false)
    private Long sequence;

    @Column(name = "event_type", nullable = false, length = 40)
    private String eventType;

    @Column(nullable = false, length = 24)
    private String state;

    @Column(nullable = false, length = 24)
    private String actor;

    @Column(columnDefinition = "JSONB")
    @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
    private String payload;

    @Column(name = "schema_version", nullable = false)
    private Integer schemaVersion = 1;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public OperationEvent() {}

    public OperationEvent(String operationId, Long sequence, String eventType,
                          String state, String actor, String payload) {
        this.operationId = operationId;
        this.sequence = sequence;
        this.eventType = eventType;
        this.state = state;
        this.actor = actor;
        this.payload = payload;
    }

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getOperationId() { return operationId; }
    public void setOperationId(String operationId) { this.operationId = operationId; }
    public String getItemId() { return itemId; }
    public void setItemId(String itemId) { this.itemId = itemId; }
    public String getAttemptId() { return attemptId; }
    public void setAttemptId(String attemptId) { this.attemptId = attemptId; }
    public Long getSequence() { return sequence; }
    public void setSequence(Long sequence) { this.sequence = sequence; }
    public String getEventType() { return eventType; }
    public void setEventType(String eventType) { this.eventType = eventType; }
    public String getState() { return state; }
    public void setState(String state) { this.state = state; }
    public String getActor() { return actor; }
    public void setActor(String actor) { this.actor = actor; }
    public String getPayload() { return payload; }
    public void setPayload(String payload) { this.payload = payload; }
    public Integer getSchemaVersion() { return schemaVersion; }
    public void setSchemaVersion(Integer schemaVersion) { this.schemaVersion = schemaVersion; }
    public Instant getCreatedAt() { return createdAt; }
}
