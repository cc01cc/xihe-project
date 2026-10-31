package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;

import java.util.UUID;

/**
 * PLAN-0610 角色权限原子（V87 {@code role_permissions}）。
 *
 * <p>Only the atom <em>name</em> is stored. The {@code scope_class} of an atom
 * ({@code instance} / {@code workspace} / {@code both}) lives in
 * {@code PermissionAtomCatalog} — the single source of truth — so a role definition cannot drift
 * from the code that evaluates it.</p>
 *
 * <p>Capability atoms ({@code instance:super}, {@code instance:admin}, {@code workspace:admin})
 * are valid rows here but are never materialized into {@code grants}: they are resolved at
 * authentication time by {@code AuthzContext}.</p>
 */
@Entity
@Table(name = "role_permissions")
public class AccessRolePermission {

    @EmbeddedId
    private AccessRolePermissionId id;

    public AccessRolePermission() {
    }

    public AccessRolePermission(AccessRolePermissionId id) {
        this.id = id;
    }

    public AccessRolePermission(UUID roleId, String actionClass, String resourcePattern) {
        this.id = new AccessRolePermissionId(roleId, actionClass, resourcePattern);
    }

    public UUID roleId() {
        return id == null ? null : id.getRoleId();
    }

    public String actionClass() {
        return id == null ? null : id.getActionClass();
    }

    public String resourcePattern() {
        return id == null ? null : id.getResourcePattern();
    }

    public AccessRolePermissionId getId() { return id; }
    public void setId(AccessRolePermissionId id) { this.id = id; }
}
