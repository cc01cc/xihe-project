package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUserId;

import java.util.List;
import java.util.Optional;

public interface WorkspaceUserRepository extends JpaRepository<WorkspaceUser, WorkspaceUserId> {
    List<WorkspaceUser> findByIdWorkspaceId(String workspaceId);
    List<WorkspaceUser> findByIdUserId(String userId);
    Optional<WorkspaceUser> findByIdWorkspaceIdAndIdUserId(String workspaceId, String userId);
}
