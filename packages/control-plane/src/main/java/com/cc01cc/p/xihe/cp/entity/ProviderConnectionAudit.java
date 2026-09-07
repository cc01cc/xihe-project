package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Convert;
import jakarta.persistence.Id;
import jakarta.persistence.Convert;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Convert;
import jakarta.persistence.Table;
import jakarta.persistence.Convert;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "provider_connection_audit")
public class ProviderConnectionAudit {

    @Id
    @Column(length = 36, columnDefinition = "uuid")
    private UUID id;

    @Column(name = "provider_connection_id", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String providerConnectionId;

    @Column(name = "owner_type", nullable = false, length = 16)
    private String ownerType;

    @Column(name = "owner_id", nullable = false, length = 64)
    private String ownerId;

    @Column(name = "provider_id", nullable = false, length = 128)
    private String providerId;

    @Column(nullable = false, length = 32)
    private String action;

    @Column(name = "changed_by", nullable = false, length = 64)
    private String changedBy;

    @Column(name = "from_status", length = 32)
    private String fromStatus;

    @Column(name = "to_status", length = 32)
    private String toStatus;

    @Column(name = "credential_present", nullable = false)
    private boolean credentialPresent;

    @Column(name = "credential_last4", length = 4)
    private String credentialLast4;

    @Column(name = "connection_revision", nullable = false)
    private long connectionRevision;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public ProviderConnectionAudit() {}

    @PrePersist
    protected void onCreate() {
        if (createdAt == null) createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getProviderConnectionId() { return providerConnectionId; }
    public void setProviderConnectionId(String providerConnectionId) { this.providerConnectionId = providerConnectionId; }
    public String getOwnerType() { return ownerType; }
    public void setOwnerType(String ownerType) { this.ownerType = ownerType; }
    public String getOwnerId() { return ownerId; }
    public void setOwnerId(String ownerId) { this.ownerId = ownerId; }
    public String getProviderId() { return providerId; }
    public void setProviderId(String providerId) { this.providerId = providerId; }
    public String getAction() { return action; }
    public void setAction(String action) { this.action = action; }
    public String getChangedBy() { return changedBy; }
    public void setChangedBy(String changedBy) { this.changedBy = changedBy; }
    public String getFromStatus() { return fromStatus; }
    public void setFromStatus(String fromStatus) { this.fromStatus = fromStatus; }
    public String getToStatus() { return toStatus; }
    public void setToStatus(String toStatus) { this.toStatus = toStatus; }
    public boolean isCredentialPresent() { return credentialPresent; }
    public void setCredentialPresent(boolean credentialPresent) { this.credentialPresent = credentialPresent; }
    public String getCredentialLast4() { return credentialLast4; }
    public void setCredentialLast4(String credentialLast4) { this.credentialLast4 = credentialLast4; }
    public long getConnectionRevision() { return connectionRevision; }
    public void setConnectionRevision(long connectionRevision) { this.connectionRevision = connectionRevision; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
