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
 * Persisted tool face: tool → actionClass + shape (PLAN-0328 M1, decision #38 / spec §8).
 *
 * <p>{@code scope} ∈ instance | workspace；{@code shape} ∈ structured | interpreter | opaque。
 * 用户/管理员显式指派后，第三方 MCP 工具才从 {@code unclassified} 变为可被规则表达。</p>
 */
@Entity
@Table(name = "tool_faces")
public class ToolFaceEntity {

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "scope", nullable = false, length = 16)
    private String scope;

    @Column(name = "owner_id", length = 36)
    private String ownerId;

    @Column(name = "tool", nullable = false, length = 128)
    private String tool;

    @Column(name = "action_class", nullable = false, length = 64)
    private String actionClass;

    @Column(name = "shape", nullable = false, length = 16)
    private String shape;

    @Column(name = "created_by", nullable = false, length = 36)
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public ToolFaceEntity() {
    }

    public ToolFaceEntity(UUID id, String scope, String ownerId, String tool, String actionClass,
                          String shape, String createdBy) {
        this.id = id;
        this.scope = scope;
        this.ownerId = ownerId;
        this.tool = tool;
        this.actionClass = actionClass;
        this.shape = shape;
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

    public String getScope() { return scope; }

    public void setScope(String scope) { this.scope = scope; }

    public String getOwnerId() { return ownerId; }

    public void setOwnerId(String ownerId) { this.ownerId = ownerId; }

    public String getTool() { return tool; }

    public void setTool(String tool) { this.tool = tool; }

    public String getActionClass() { return actionClass; }

    public void setActionClass(String actionClass) { this.actionClass = actionClass; }

    public String getShape() { return shape; }

    public void setShape(String shape) { this.shape = shape; }

    public String getCreatedBy() { return createdBy; }

    public void setCreatedBy(String createdBy) { this.createdBy = createdBy; }

    public Instant getCreatedAt() { return createdAt; }

    public Instant getUpdatedAt() { return updatedAt; }
}
