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
 * PLAN-0495 T1.1 / PLAN-0497 M0: domain audit store for credential lifecycle
 * and delivery events (the 0497 M3 read-surface source). Rows never carry a
 * value — only type/actor/owner/time (0494 I1, 0495 §方案 5).
 */
@Entity
@Table(name = "credential_events")
public class CredentialEvent {

    public static final String TYPE_CREATED = "created";
    public static final String TYPE_REPLACED = "replaced";
    public static final String TYPE_DELETED = "deleted";
    public static final String TYPE_LEASE_ISSUED = "lease_issued";
    public static final String TYPE_LEASE_REDEEMED = "lease_redeemed";
    public static final String TYPE_REVEALED = "revealed";

    public static final String ACTOR_SYSTEM = "system";

    @Id
    @Column(length = 36, columnDefinition = "uuid")
    private UUID id;

    @Column(name = "credential_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String credentialId;

    @Column(name = "event_type", nullable = false, length = 32)
    private String eventType;

    @Column(nullable = false, length = 64)
    private String actor;

    @Column(name = "owner_type", nullable = false, length = 16)
    private String ownerType;

    @Column(name = "owner_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String ownerId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public CredentialEvent() {}

    @PrePersist
    protected void onCreate() {
        if (createdAt == null) {
            createdAt = Instant.now();
        }
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getCredentialId() { return credentialId; }
    public void setCredentialId(String credentialId) { this.credentialId = credentialId; }
    public String getEventType() { return eventType; }
    public void setEventType(String eventType) { this.eventType = eventType; }
    public String getActor() { return actor; }
    public void setActor(String actor) { this.actor = actor; }
    public String getOwnerType() { return ownerType; }
    public void setOwnerType(String ownerType) { this.ownerType = ownerType; }
    public String getOwnerId() { return ownerId; }
    public void setOwnerId(String ownerId) { this.ownerId = ownerId; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
