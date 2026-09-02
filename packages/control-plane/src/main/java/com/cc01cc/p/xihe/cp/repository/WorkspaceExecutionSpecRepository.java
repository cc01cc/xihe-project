package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.WorkspaceExecutionSpec;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;
import java.util.UUID;

public interface WorkspaceExecutionSpecRepository extends JpaRepository<WorkspaceExecutionSpec, UUID> {

    Optional<WorkspaceExecutionSpec> findTopByWorkspaceIdOrderByGenerationDesc(String workspaceId);
}
