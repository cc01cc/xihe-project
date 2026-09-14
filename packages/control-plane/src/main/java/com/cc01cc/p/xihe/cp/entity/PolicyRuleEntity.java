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
 * A persisted authorization rule (PLAN-0328 M1, spec §5/§7).
 *
 * <p>{@code layer} ∈ instance | user | workspace；{@code ownerId} 为 userId / workspaceId，
 * instance 层为 NULL。{@code locked} 规则只允许 deny/ask（V15 有 CHECK 约束）。</p>
 */
@Entity
@Table(name = "policy_rules")
public class PolicyRuleEntity {

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "layer", nullable = false, length = 16)
    private String layer;

    @Column(name = "owner_id", length = 36)
    private String ownerId;

    @Column(name = "action_class", nullable = false, length = 64)
    private String actionClass;

    @Column(name = "resource", nullable = false, length = 512)
    private String resource;

    @Column(name = "effect", nullable = false, length = 8)
    private String effect;

    @Column(name = "priority", nullable = false)
    private int priority;

    @Column(name = "locked", nullable = false)
    private boolean locked;

    @Column(name = "created_by", nullable = false, length = 36)
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public PolicyRuleEntity() {
    }

    public PolicyRuleEntity(UUID id, String layer, String ownerId, String actionClass, String resource,
                            String effect, int priority, boolean locked, String createdBy) {
        this.id = id;
        this.layer = layer;
        this.ownerId = ownerId;
        this.actionClass = actionClass;
        this.resource = resource;
        this.effect = effect;
        this.priority = priority;
        this.locked = locked;
        this.createdBy = createdBy;
    }

    @PrePersist
    void onCreate() {
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
    void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() { return id; }

    public String getLayer() { return layer; }

    public void setLayer(String layer) { this.layer = layer; }

    public String getOwnerId() { return ownerId; }

    public void setOwnerId(String ownerId) { this.ownerId = ownerId; }

    public String getActionClass() { return actionClass; }

    public void setActionClass(String actionClass) { this.actionClass = actionClass; }

    public String getResource() { return resource; }

    public void setResource(String resource) { this.resource = resource; }

    public String getEffect() { return effect; }

    public void setEffect(String effect) { this.effect = effect; }

    public int getPriority() { return priority; }

    public void setPriority(int priority) { this.priority = priority; }

    public boolean isLocked() { return locked; }

    public void setLocked(boolean locked) { this.locked = locked; }

    public String getCreatedBy() { return createdBy; }

    public void setCreatedBy(String createdBy) { this.createdBy = createdBy; }

    public Instant getCreatedAt() { return createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
}
