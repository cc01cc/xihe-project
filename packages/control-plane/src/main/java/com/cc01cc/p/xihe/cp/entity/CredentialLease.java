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
 * PLAN-0497 T1.1: generic credential lease — single-use + TTL + bindings
 * (credential/principal/session/run/workspace, all mandatory) and the
 * expected_revision snapshot taken at issue time (aligned with the 0495
 * credentials.revision column). The token itself is never stored (I2: only
 * its SHA-256 in {@code leaseHash}).
 */
@Entity
@Table(name = "credential_leases")
public class CredentialLease {

    @Id
    @Column(length = 36, columnDefinition = "uuid")
    private UUID id;

    @Column(name = "lease_hash", nullable = false, length = 64)
    private String leaseHash;

    @Column(name = "credential_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String credentialId;

    @Column(name = "principal_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String principalId;

    @Column(name = "session_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String sessionId;

    @Column(name = "run_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String runId;

    @Column(name = "workspace_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String workspaceId;

    @Column(name = "expected_revision", nullable = false)
    private int expectedRevision;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "redeemed_at")
    private Instant redeemedAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public CredentialLease() {}

    @PrePersist
    protected void onCreate() {
        if (createdAt == null) {
            createdAt = Instant.now();
        }
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getLeaseHash() { return leaseHash; }
    public void setLeaseHash(String leaseHash) { this.leaseHash = leaseHash; }
    public String getCredentialId() { return credentialId; }
    public void setCredentialId(String credentialId) { this.credentialId = credentialId; }
    public String getPrincipalId() { return principalId; }
    public void setPrincipalId(String principalId) { this.principalId = principalId; }
    public String getSessionId() { return sessionId; }
    public void setSessionId(String sessionId) { this.sessionId = sessionId; }
    public String getRunId() { return runId; }
    public void setRunId(String runId) { this.runId = runId; }
    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }
    public int getExpectedRevision() { return expectedRevision; }
    public void setExpectedRevision(int expectedRevision) { this.expectedRevision = expectedRevision; }
    public Instant getExpiresAt() { return expiresAt; }
    public void setExpiresAt(Instant expiresAt) { this.expiresAt = expiresAt; }
    public Instant getRedeemedAt() { return redeemedAt; }
    public void setRedeemedAt(Instant redeemedAt) { this.redeemedAt = redeemedAt; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
}
