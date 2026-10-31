package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

/**
 * PLAN-0610 角色绑定（V87 {@code role_bindings}）：role × subject × scope。
 *
 * <p>Scopes are <b>explicit and non-inheriting</b> (design #11): an instance-scope binding does
 * not produce workspace-scoped atoms and a workspace binding does not reach the instance. The
 * materialized {@link AuthorizationGrant} rows carry the same {@code scope_type/scope_id} pair,
 * so evaluation can filter by request scope without re-reading the bindings.</p>
 *
 * <p>{@code scope_id} references {@code workspaces(id) ON DELETE CASCADE}: a deleted workspace
 * must not leave a dangling binding. Instance bindings keep {@code scope_id} NULL (V87
 * {@code ck_role_bindings_scope}).</p>
 */
@Entity
@Table(name = "role_bindings")
public class AccessRoleBinding {

    @Id
    @Column(name = "id", columnDefinition = "uuid")
    private UUID id;

    @Column(name = "role_id", nullable = false, columnDefinition = "uuid")
    private UUID roleId;

    @Column(name = "subject_type", nullable = false, length = 24)
    private String subjectType;

    @Column(name = "subject_id", nullable = false, columnDefinition = "uuid")
    private UUID subjectId;

    @Column(name = "scope_type", nullable = false, length = 16)
    private String scopeType;

    @Column(name = "scope_id", columnDefinition = "uuid")
    private UUID scopeId;

    @Column(name = "granted_by", columnDefinition = "uuid")
    private UUID grantedBy;

    @Column(name = "granted_at", nullable = false, updatable = false)
    private Instant grantedAt;

    public AccessRoleBinding() {
    }

    public AccessRoleBinding(UUID roleId, String subjectType, UUID subjectId,
                             String scopeType, UUID scopeId, UUID grantedBy) {
        this.roleId = roleId;
        this.subjectType = subjectType;
        this.subjectId = subjectId;
        this.scopeType = scopeType;
        this.scopeId = scopeId;
        this.grantedBy = grantedBy;
    }

    @PrePersist
    protected void onCreate() {
        if (id == null) {
            id = UUID.randomUUID();
        }
        if (grantedAt == null) {
            grantedAt = Instant.now();
        }
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public UUID getRoleId() { return roleId; }
    public void setRoleId(UUID roleId) { this.roleId = roleId; }

    public String getSubjectType() { return subjectType; }
    public void setSubjectType(String subjectType) { this.subjectType = subjectType; }

    public UUID getSubjectId() { return subjectId; }
    public void setSubjectId(UUID subjectId) { this.subjectId = subjectId; }

    public String getScopeType() { return scopeType; }
    public void setScopeType(String scopeType) { this.scopeType = scopeType; }

    public UUID getScopeId() { return scopeId; }
    public void setScopeId(UUID scopeId) { this.scopeId = scopeId; }

    public UUID getGrantedBy() { return grantedBy; }
    public void setGrantedBy(UUID grantedBy) { this.grantedBy = grantedBy; }

    public Instant getGrantedAt() { return grantedAt; }
    public void setGrantedAt(Instant grantedAt) { this.grantedAt = grantedAt; }
}
