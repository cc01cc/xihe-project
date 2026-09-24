package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface WorkspaceAgentRepository extends JpaRepository<WorkspaceAgent, WorkspaceAgentId> {
    List<WorkspaceAgent> findByIdWorkspaceId(UUID workspaceId);
    List<WorkspaceAgent> findByIdPrincipalId(UUID principalId);
}
