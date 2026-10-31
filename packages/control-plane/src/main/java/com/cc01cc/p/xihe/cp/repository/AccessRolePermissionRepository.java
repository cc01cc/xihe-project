package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermissionId;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

public interface AccessRolePermissionRepository extends JpaRepository<AccessRolePermission, AccessRolePermissionId> {

    List<AccessRolePermission> findByIdRoleId(UUID roleId);

    List<AccessRolePermission> findByIdRoleIdIn(Collection<UUID> roleIds);

    void deleteByIdRoleId(UUID roleId);
}
