package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;

@Entity
@Table(name = "provider_credential_leases")
public class ProviderCredentialLease {

    @Id
    @Column(length = 36)
    private String id;

    @Column(name = "lease_hash", nullable = false, unique = true, length = 128)
    private String leaseHash;

    @Column(name = "provider_connection_id", nullable = false, length = 36)
    private String providerConnectionId;

    @Column(name = "user_id", nullable = false, length = 36)
    private String userId;

    @Column(name = "workspace_id", length = 36)
    private String workspaceId;

    @Column(name = "session_id", length = 36)
    private String sessionId;

    @Column(name = "run_id", length = 36)
    private String runId;

    @Column(name = "provider_id", nullable = false, length = 128)
    private String providerId;

    @Column(nullable = false, length = 255)
    private String model;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "redeemed_at")
    private Instant redeemedAt;

    @Column(name = "revoked_at")
    private Instant revokedAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public ProviderCredentialLease() {}

    @PrePersist
    protected void onCreate() {
        if (createdAt == null) createdAt = Instant.now();
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getLeaseHash() { return leaseHash; }
    public void setLeaseHash(String leaseHash) { this.leaseHash = leaseHash; }
    public String getProviderConnectionId() { return providerConnectionId; }
    public void setProviderConnectionId(String providerConnectionId) { this.providerConnectionId = providerConnectionId; }
    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }
    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }
    public String getSessionId() { return sessionId; }
    public void setSessionId(String sessionId) { this.sessionId = sessionId; }
    public String getRunId() { return runId; }
    public void setRunId(String runId) { this.runId = runId; }
    public String getProviderId() { return providerId; }
    public void setProviderId(String providerId) { this.providerId = providerId; }
    public String getModel() { return model; }
    public void setModel(String model) { this.model = model; }
    public Instant getExpiresAt() { return expiresAt; }
    public void setExpiresAt(Instant expiresAt) { this.expiresAt = expiresAt; }
    public Instant getRedeemedAt() { return redeemedAt; }
    public void setRedeemedAt(Instant redeemedAt) { this.redeemedAt = redeemedAt; }
    public Instant getRevokedAt() { return revokedAt; }
    public void setRevokedAt(Instant revokedAt) { this.revokedAt = revokedAt; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
