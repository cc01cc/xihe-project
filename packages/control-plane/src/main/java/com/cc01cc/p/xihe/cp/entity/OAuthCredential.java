package com.cc01cc.p.xihe.cp.entity;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.Convert;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Convert;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Convert;
import jakarta.persistence.Id;
import jakarta.persistence.Convert;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Convert;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Convert;
import jakarta.persistence.Table;
import jakarta.persistence.Convert;
import jakarta.persistence.UniqueConstraint;
import jakarta.persistence.Convert;

@Entity
@Table(name = "oauth_credentials", uniqueConstraints = @UniqueConstraint(
        columnNames = {"user_id", "workspace_id", "server_id"}))
public class OAuthCredential {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(length = 36, columnDefinition = "uuid")
    private UUID id;

    @Column(name = "user_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String userId;

    @Column(name = "workspace_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String workspaceId;

    @Column(name = "server_id", nullable = false, length = 36)
    @Convert(converter = UuidStringConverter.class)
    private String serverId;

    @Column(name = "client_id", nullable = false, length = 255)
    private String clientId;

    @Column(name = "token_endpoint", nullable = false, length = 512)
    private String tokenEndpoint;

    @Column(name = "redirect_uri", nullable = false, length = 512)
    private String redirectUri;

    @Column(nullable = false, length = 1024)
    private String scope;

    @Column(name = "refresh_token_ciphertext", nullable = false, columnDefinition = "TEXT")
    private String refreshTokenCiphertext;

    @Column(name = "encryption_key_version", nullable = false, length = 32)
    private String encryptionKeyVersion;

    @Column(nullable = false, length = 32)
    private String status;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public OAuthCredential() {}

    @PrePersist
    protected void onCreate() {
        Instant now = Instant.now();
        createdAt = now;
        updatedAt = now;
        if (status == null) status = "AUTHORIZED";
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }
    public String getWorkspaceId() { return workspaceId; }
    public void setWorkspaceId(String workspaceId) { this.workspaceId = workspaceId; }
    public String getServerId() { return serverId; }
    public void setServerId(String serverId) { this.serverId = serverId; }
    public String getClientId() { return clientId; }
    public void setClientId(String clientId) { this.clientId = clientId; }
    public String getTokenEndpoint() { return tokenEndpoint; }
    public void setTokenEndpoint(String tokenEndpoint) { this.tokenEndpoint = tokenEndpoint; }
    public String getRedirectUri() { return redirectUri; }
    public void setRedirectUri(String redirectUri) { this.redirectUri = redirectUri; }
    public String getScope() { return scope; }
    public void setScope(String scope) { this.scope = scope; }
    public String getRefreshTokenCiphertext() { return refreshTokenCiphertext; }
    public void setRefreshTokenCiphertext(String refreshTokenCiphertext) { this.refreshTokenCiphertext = refreshTokenCiphertext; }
    public String getEncryptionKeyVersion() { return encryptionKeyVersion; }
    public void setEncryptionKeyVersion(String encryptionKeyVersion) { this.encryptionKeyVersion = encryptionKeyVersion; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
