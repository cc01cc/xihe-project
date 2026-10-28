package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "users")
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(nullable = false, unique = true, length = 255)
    private String email;

    /**
     * PLAN-0565 ruling #7: unique account handle, {@code ^[a-z][a-z0-9]{0,31}$}
     * (letter-first). Backfilled/generated from the email local part when not
     * supplied at registration.
     */
    @Column(nullable = false, unique = true, length = 32)
    private String username;

    @Column(name = "password_hash", nullable = false, length = 255)
    private String passwordHash;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private UserRole role;

    @Column(length = 100)
    private String name;

    @Column(length = 512)
    private String avatar;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public User() {}

    public User(String email, String passwordHash, UserRole role, String name) {
        this(email, passwordHash, role, name, defaultUsernameFromEmail(email));
    }

    public User(String email, String passwordHash, UserRole role, String name, String username) {
        this.email = email;
        this.username = username;
        this.passwordHash = passwordHash;
        this.role = role;
        this.name = name;
    }

    /**
     * PLAN-0565: deterministic username fallback derived from the email local
     * part — lowercase, non-alphanumerics stripped, truncated to 32; an empty
     * or digit-leading result gets the {@code user} prefix (ruling #7).
     * Uniqueness is ensured by callers (registration loop / V82 backfill).
     */
    public static String defaultUsernameFromEmail(String email) {
        String cleaned = email == null ? ""
                : email.toLowerCase().split("@", 2)[0].replaceAll("[^a-z0-9]", "");
        if (cleaned.length() > 32) {
            cleaned = cleaned.substring(0, 32);
        }
        if (cleaned.isEmpty() || !cleaned.matches("[a-z].*")) {
            cleaned = ("user" + cleaned);
            if (cleaned.length() > 32) {
                cleaned = cleaned.substring(0, 32);
            }
        }
        return cleaned;
    }

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
        updatedAt = Instant.now();
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }

    public String getUsername() { return username; }
    public void setUsername(String username) { this.username = username; }

    public String getPasswordHash() { return passwordHash; }
    public void setPasswordHash(String passwordHash) { this.passwordHash = passwordHash; }

    public UserRole getRole() { return role; }
    public void setRole(UserRole role) { this.role = role; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getAvatar() { return avatar; }
    public void setAvatar(String avatar) { this.avatar = avatar; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
