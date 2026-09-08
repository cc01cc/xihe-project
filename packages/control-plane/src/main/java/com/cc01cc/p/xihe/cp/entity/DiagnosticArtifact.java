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
 * Metadata for an encrypted diagnostic artifact. Artifact content lives in
 * protected artifact storage; only hash, size, storage reference, encryption
 * parameters and ACL scope are stored here.
 */
@Entity
@Table(name = "diagnostic_artifacts")
public class DiagnosticArtifact {

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

    @Column(nullable = false, length = 40)
    private String kind;

    @Column(name = "content_type", nullable = false, length = 128)
    private String contentType;

    @Column(name = "storage_backend", nullable = false, length = 24)
    private String storageBackend;

    @Column(name = "storage_ref", nullable = false, columnDefinition = "TEXT")
    private String storageRef;

    @Column(name = "content_sha256", nullable = false, length = 64)
    private String contentSha256;

    @Column(name = "size_bytes", nullable = false)
    private Long sizeBytes;

    @Column(name = "encryption_algorithm", nullable = false, length = 32)
    private String encryptionAlgorithm;

    @Column(name = "encryption_key_version", nullable = false, length = 32)
    private String encryptionKeyVersion;

    @Column(name = "acl_scope", nullable = false, length = 24)
    private String aclScope;

    @Column(name = "expires_at")
    private Instant expiresAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "deleted_at")
    private Instant deletedAt;

    public DiagnosticArtifact() {}

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
    public String getKind() { return kind; }
    public void setKind(String kind) { this.kind = kind; }
    public String getContentType() { return contentType; }
    public void setContentType(String contentType) { this.contentType = contentType; }
    public String getStorageBackend() { return storageBackend; }
    public void setStorageBackend(String storageBackend) { this.storageBackend = storageBackend; }
    public String getStorageRef() { return storageRef; }
    public void setStorageRef(String storageRef) { this.storageRef = storageRef; }
    public String getContentSha256() { return contentSha256; }
    public void setContentSha256(String contentSha256) { this.contentSha256 = contentSha256; }
    public Long getSizeBytes() { return sizeBytes; }
    public void setSizeBytes(Long sizeBytes) { this.sizeBytes = sizeBytes; }
    public String getEncryptionAlgorithm() { return encryptionAlgorithm; }
    public void setEncryptionAlgorithm(String encryptionAlgorithm) { this.encryptionAlgorithm = encryptionAlgorithm; }
    public String getEncryptionKeyVersion() { return encryptionKeyVersion; }
    public void setEncryptionKeyVersion(String encryptionKeyVersion) { this.encryptionKeyVersion = encryptionKeyVersion; }
    public String getAclScope() { return aclScope; }
    public void setAclScope(String aclScope) { this.aclScope = aclScope; }
    public Instant getExpiresAt() { return expiresAt; }
    public void setExpiresAt(Instant expiresAt) { this.expiresAt = expiresAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getDeletedAt() { return deletedAt; }
    public void setDeletedAt(Instant deletedAt) { this.deletedAt = deletedAt; }
}
