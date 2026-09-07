package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "provider_connections", uniqueConstraints = @UniqueConstraint(
        name = "uq_provider_connection_scope",
        columnNames = {"owner_type", "owner_id", "provider_id"}))
public class ProviderConnection {

    public static final String OWNER_SYSTEM = "SYSTEM";
    public static final String OWNER_WORKSPACE = "WORKSPACE";
    public static final String OWNER_USER = "USER";

    public static final String STATUS_UNVERIFIED = "UNVERIFIED";
    public static final String STATUS_VERIFYING = "VERIFYING";
    public static final String STATUS_READY = "READY";
    public static final String STATUS_INVALID_CREDENTIALS = "INVALID_CREDENTIALS";
    public static final String STATUS_UNREACHABLE = "UNREACHABLE";
    public static final String STATUS_DISABLED = "DISABLED";

    @Id
    @Column(length = 36, columnDefinition = "uuid")
    private UUID id;

    @Column(name = "owner_type", nullable = false, length = 16)
    private String ownerType;

    @Column(name = "owner_id", nullable = false, length = 64)
    private String ownerId;

    @Column(name = "provider_id", nullable = false, length = 128)
    private String providerId;

    @Column(nullable = false, length = 128)
    private String label;

    @Column(name = "base_url", length = 2048)
    private String baseUrl;

    @Column(name = "credential_ciphertext", columnDefinition = "TEXT")
    private String credentialCiphertext;

    @Column(name = "encryption_key_version", nullable = false, length = 32)
    private String encryptionKeyVersion;

    @Column(nullable = false)
    private boolean enabled = true;

    @Column(nullable = false, length = 32)
    private String status = STATUS_UNVERIFIED;

    @Column(name = "model_discovery", nullable = false, length = 32)
    private String modelDiscovery = "remote-models";

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "manual_models", columnDefinition = "jsonb")
    private String manualModels;

    @Column(nullable = false)
    private long revision = 1;

    @Column(name = "last_verified_at")
    private Instant lastVerifiedAt;

    @Column(name = "last_error_code", length = 64)
    private String lastErrorCode;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public ProviderConnection() {}

    @PrePersist
    protected void onCreate() {
        Instant now = Instant.now();
        createdAt = now;
        updatedAt = now;
        if (revision < 1) revision = 1;
        if (status == null) status = STATUS_UNVERIFIED;
        if (modelDiscovery == null) modelDiscovery = "remote-models";
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getOwnerType() { return ownerType; }
    public void setOwnerType(String ownerType) { this.ownerType = ownerType; }
    public String getOwnerId() { return ownerId; }
    public void setOwnerId(String ownerId) { this.ownerId = ownerId; }
    public String getProviderId() { return providerId; }
    public void setProviderId(String providerId) { this.providerId = providerId; }
    public String getLabel() { return label; }
    public void setLabel(String label) { this.label = label; }
    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl; }
    public String getCredentialCiphertext() { return credentialCiphertext; }
    public void setCredentialCiphertext(String credentialCiphertext) { this.credentialCiphertext = credentialCiphertext; }
    public String getEncryptionKeyVersion() { return encryptionKeyVersion; }
    public void setEncryptionKeyVersion(String encryptionKeyVersion) { this.encryptionKeyVersion = encryptionKeyVersion; }
    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public String getModelDiscovery() { return modelDiscovery; }
    public void setModelDiscovery(String modelDiscovery) { this.modelDiscovery = modelDiscovery; }
    public String getManualModels() { return manualModels; }
    public void setManualModels(String manualModels) { this.manualModels = manualModels; }
    public long getRevision() { return revision; }
    public void setRevision(long revision) { this.revision = revision; }
    public Instant getLastVerifiedAt() { return lastVerifiedAt; }
    public void setLastVerifiedAt(Instant lastVerifiedAt) { this.lastVerifiedAt = lastVerifiedAt; }
    public String getLastErrorCode() { return lastErrorCode; }
    public void setLastErrorCode(String lastErrorCode) { this.lastErrorCode = lastErrorCode; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
