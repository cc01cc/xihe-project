package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0610 授权预设（grant preset，V87 {@code roles}，V182 {@code grant_presets}）。
 *
 * <p>Preset definitions are instance-wide; the <em>scope</em> of a preset lives on the binding
 * ({@link GrantPresetBinding}) and on the materialized {@link AuthorizationGrant} row. A role
 * therefore never means "instance role" or "workspace role" by itself — the atom set plus the
 * binding scope decide what it can address ({@code PermissionAtomCatalog} holds
 * {@code scope_class}).</p>
 *
 * <p>{@code is_system} presets are seeded by the migration and are immutable (no delete, no
 * permission edit; display name only). The field is internal and must never reach an API view
 * directly — the W3 role view projects {name, displayName, description, isSystem}.</p>
 */
@Entity
@Table(name = "grant_presets")
public class GrantPreset {

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "name", nullable = false, length = 64, unique = true)
    private String name;

    @Column(name = "display_name", nullable = false, columnDefinition = "TEXT")
    private String displayName;

    @Column(name = "description", columnDefinition = "TEXT")
    private String description;

    @Column(name = "is_system", nullable = false)
    private boolean system;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public GrantPreset() {
    }

    public GrantPreset(UUID id, String name, String displayName, String description, boolean system) {
        this.id = id;
        this.name = name;
        this.displayName = displayName;
        this.description = description;
        this.system = system;
    }

    @PrePersist
    protected void onCreate() {
        if (id == null) {
            id = UUID.randomUUID();
        }
        Instant now = Instant.now();
        if (createdAt == null) {
            createdAt = now;
        }
        updatedAt = now;
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getDisplayName() { return displayName; }
    public void setDisplayName(String displayName) { this.displayName = displayName; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public boolean isSystem() { return system; }
    public void setSystem(boolean system) { this.system = system; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
