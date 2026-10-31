package com.cc01cc.p.xihe.cp.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;

import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

/** Composite key of {@code role_permissions}: one atom (action class + resource pattern) per role. */
@Embeddable
public class AccessRolePermissionId implements Serializable {

    @Column(name = "role_id", columnDefinition = "uuid")
    private UUID roleId;

    @Column(name = "action_class", length = 64)
    private String actionClass;

    @Column(name = "resource_pattern", length = 255)
    private String resourcePattern;

    public AccessRolePermissionId() {
    }

    public AccessRolePermissionId(UUID roleId, String actionClass, String resourcePattern) {
        this.roleId = roleId;
        this.actionClass = actionClass;
        this.resourcePattern = resourcePattern;
    }

    public UUID getRoleId() { return roleId; }
    public void setRoleId(UUID roleId) { this.roleId = roleId; }

    public String getActionClass() { return actionClass; }
    public void setActionClass(String actionClass) { this.actionClass = actionClass; }

    public String getResourcePattern() { return resourcePattern; }
    public void setResourcePattern(String resourcePattern) { this.resourcePattern = resourcePattern; }

    @Override
    public boolean equals(Object other) {
        if (this == other) {
            return true;
        }
        if (!(other instanceof AccessRolePermissionId that)) {
            return false;
        }
        return Objects.equals(roleId, that.roleId)
                && Objects.equals(actionClass, that.actionClass)
                && Objects.equals(resourcePattern, that.resourcePattern);
    }

    @Override
    public int hashCode() {
        return Objects.hash(roleId, actionClass, resourcePattern);
    }
}
