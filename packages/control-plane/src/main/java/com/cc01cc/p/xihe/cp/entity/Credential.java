package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0495 T1.1: credential manager object — metadata + one encrypted JSON
 * payload ({@code token} or {@code access/secret} pair, 0494 #6), lifecycle
 * fields (status/revision/soft-delete, 0495 #7/#8) and the envelope key version.
 * The ciphertext binds {@code credentialId|ownerType|ownerId} via AAD (0495 I2);
 * neither ciphertext nor fingerprint ever carry the plaintext value.
 */
@Entity
@Table(name = "credentials")
public class Credential {

    public static final String OWNER_USER = "USER";
    public static final String OWNER_WORKSPACE = "WORKSPACE";

    public static final String KIND_TOKEN = "token";
    public static final String KIND_KEY_PAIR = "key_pair";

    public static final String TIER_LEASE = "lease";
    public static final String TIER_REVEAL = "reveal";

    public static final String STATUS_ACTIVE = "active";
    public static final String STATUS_DISABLED = "disabled";

    /** PLAN-0576: AAD format version stored per row (V84 default 1 = PLAN-0495 format). */
    public static final short AAD_VERSION_LEGACY = 1;
    public static final short AAD_VERSION_V2 = 2;

    /** PLAN-0576: fingerprint algorithm/key version stored per row. */
    public static final String FINGERPRINT_VERSION_SHA256 = "sha256";
    public static final String FINGERPRINT_VERSION_HMAC_SHA256_V1 = "hmac-sha256-v1";

    @Id
    @Column(length = 36, columnDefinition = "uuid")
    private UUID id;

    @Column(name = "owner_type", nullable = false, length = 16)
    private String ownerType;

    @Column(name = "owner_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String ownerId;

    @Column(nullable = false, length = 128)
    private String label;

    @Column(nullable = false, length = 16)
    private String kind;

    @Column(name = "delivery_tier", nullable = false, length = 16)
    private String deliveryTier;

    @Column(nullable = false, length = 16)
    private String status = STATUS_ACTIVE;

    @Column(nullable = false)
    private int revision = 1;

    @Column(name = "secret_ciphertext", nullable = false, columnDefinition = "TEXT")
    private String secretCiphertext;

    @Column(nullable = false, length = 64)
    private String fingerprint;

    @Column(name = "key_version", nullable = false, length = 16)
    private String keyVersion;

    @Column(name = "aad_version", nullable = false)
    private short aadVersion = AAD_VERSION_LEGACY;

    @Column(name = "fingerprint_version", nullable = false, length = 32)
    private String fingerprintVersion = FINGERPRINT_VERSION_SHA256;

    @Column(name = "created_by", length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String createdBy;

    @Column(name = "replaced_at")
    private Instant replacedAt;

    @Column(name = "rotated_at")
    private Instant rotatedAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Column(name = "deleted_at")
    private Instant deletedAt;

    public Credential() {}

    @PrePersist
    protected void onCreate() {
        Instant now = Instant.now();
        createdAt = now;
        updatedAt = now;
        if (revision < 1) {
            revision = 1;
        }
        if (status == null) {
            status = STATUS_ACTIVE;
        }
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
    public String getLabel() { return label; }
    public void setLabel(String label) { this.label = label; }
    public String getKind() { return kind; }
    public void setKind(String kind) { this.kind = kind; }
    public String getDeliveryTier() { return deliveryTier; }
    public void setDeliveryTier(String deliveryTier) { this.deliveryTier = deliveryTier; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public int getRevision() { return revision; }
    public void setRevision(int revision) { this.revision = revision; }
    public String getSecretCiphertext() { return secretCiphertext; }
    public void setSecretCiphertext(String secretCiphertext) { this.secretCiphertext = secretCiphertext; }
    public String getFingerprint() { return fingerprint; }
    public void setFingerprint(String fingerprint) { this.fingerprint = fingerprint; }
    public String getKeyVersion() { return keyVersion; }
    public void setKeyVersion(String keyVersion) { this.keyVersion = keyVersion; }
    public short getAadVersion() { return aadVersion; }
    public void setAadVersion(short aadVersion) { this.aadVersion = aadVersion; }
    public String getFingerprintVersion() { return fingerprintVersion; }
    public void setFingerprintVersion(String fingerprintVersion) { this.fingerprintVersion = fingerprintVersion; }
    public String getCreatedBy() { return createdBy; }
    public void setCreatedBy(String createdBy) { this.createdBy = createdBy; }
    public Instant getReplacedAt() { return replacedAt; }
    public void setReplacedAt(Instant replacedAt) { this.replacedAt = replacedAt; }
    public Instant getRotatedAt() { return rotatedAt; }
    public void setRotatedAt(Instant rotatedAt) { this.rotatedAt = rotatedAt; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
    public Instant getDeletedAt() { return deletedAt; }
    public void setDeletedAt(Instant deletedAt) { this.deletedAt = deletedAt; }
}
