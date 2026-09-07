package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUserId;

import java.util.List;
import java.util.UUID;
import java.util.Optional;
import java.util.UUID;

public interface WorkspaceUserRepository extends JpaRepository<WorkspaceUser, WorkspaceUserId> {
    List<WorkspaceUser> findByIdWorkspaceId(UUID workspaceId);
    List<WorkspaceUser> findByIdUserId(UUID userId);
    Optional<WorkspaceUser> findByIdWorkspaceIdAndIdUserId(UUID workspaceId, UUID userId);
}
