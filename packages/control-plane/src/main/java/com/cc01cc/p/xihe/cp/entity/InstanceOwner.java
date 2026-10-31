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
 * PLAN-0580: the single-row instance owner pointer ({@code id = 1}).
 *
 * <p>Ownership is a single-instance fact, so the row count is constrained in
 * the database ({@code ck_instance_owner_singleton CHECK (id = 1)} in V85)
 * rather than modelled as a role. {@code ownerUserId} is null only on a fresh
 * instance with no ADMIN yet; {@code assignedAt} shares that nullability
 * ({@code ck_instance_owner_consistency}).
 *
 * <p>{@code assignedBy} is a best-effort responsibility link: the durable
 * truth is {@code assignedAt} plus the audit row, so the FK is
 * {@code ON DELETE SET NULL} and this column may become null after the
 * assigner is deleted.
 */
@Entity
@Table(name = "instance_owner")
public class InstanceOwner {

    /** The only legal primary key value. */
    public static final short SINGLETON_ID = 1;

    @Id
    @Column(name = "id", columnDefinition = "smallint")
    private Short id = SINGLETON_ID;

    @Column(name = "owner_user_id", columnDefinition = "uuid")
    private UUID ownerUserId;

    @Column(name = "assigned_at")
    private Instant assignedAt;

    @Column(name = "assigned_by", columnDefinition = "uuid")
    private UUID assignedBy;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public InstanceOwner() {}

    /**
     * PLAN-0580: pointer move. {@code assignedAt} and {@code ownerUserId} are
     * always written together so {@code ck_instance_owner_consistency} holds.
     */
    public void assignTo(UUID newOwnerUserId, UUID assignerUserId) {
        this.ownerUserId = newOwnerUserId;
        this.assignedAt = Instant.now();
        this.assignedBy = assignerUserId;
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

    public Short getId() { return id; }
    public void setId(Short id) { this.id = id; }

    public UUID getOwnerUserId() { return ownerUserId; }
    public void setOwnerUserId(UUID ownerUserId) { this.ownerUserId = ownerUserId; }

    public Instant getAssignedAt() { return assignedAt; }
    public void setAssignedAt(Instant assignedAt) { this.assignedAt = assignedAt; }

    public UUID getAssignedBy() { return assignedBy; }
    public void setAssignedBy(UUID assignedBy) { this.assignedBy = assignedBy; }

    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
}
