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
 * D-935 / PLAN-0767 M1: the immutable deployment identity singleton ({@code id = 1}).
 *
 * <p>This row is the authority for {@code instanceId}; {@code XIHE_DEPLOYMENT_ID} only seeds the
 * first boot and a conflicting value makes the process fail-fast (it never rewrites the row). The
 * table is created by V154 <b>without</b> a row: {@code InstanceIdentityService.ensureSeeded} owns
 * the single-row insert, the {@code provider_connections} sentinel backfill and the init audit, all
 * in one transaction. The row is never updated after creation (V154 keeps {@code updated_at} only
 * for schema consistency).
 */
@Entity
@Table(name = "instance_identity")
public class InstanceIdentity {

    /** The only legal primary key value (also enforced by {@code ck_instance_identity_singleton}). */
    public static final short SINGLETON_ID = 1;

    @Id
    @Column(name = "id", columnDefinition = "smallint")
    private Short id = SINGLETON_ID;

    @Column(name = "instance_id", nullable = false, unique = true, updatable = false,
            columnDefinition = "uuid")
    private UUID instanceId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public InstanceIdentity() {}

    public InstanceIdentity(UUID instanceId) {
        this.instanceId = instanceId;
    }

    @PrePersist
    protected void onCreate() {
        if (id == null) {
            id = SINGLETON_ID;
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

    public Short getId() {
        return id;
    }

    public void setId(Short id) {
        this.id = id;
    }

    public UUID getInstanceId() {
        return instanceId;
    }

    public void setInstanceId(UUID instanceId) {
        this.instanceId = instanceId;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(Instant createdAt) {
        this.createdAt = createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(Instant updatedAt) {
        this.updatedAt = updatedAt;
    }
}
