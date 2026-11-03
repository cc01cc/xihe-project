package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.WorkspaceRoot;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** PLAN-0639 M1: root persistence for multi-root workspaces. */
public interface WorkspaceRootRepository extends JpaRepository<WorkspaceRoot, UUID> {

    /** Active roots of a workspace, in position order. */
    List<WorkspaceRoot> findByWorkspaceIdAndDeletedAtIsNullOrderByPositionAsc(UUID workspaceId);

    /** One active root by id. */
    Optional<WorkspaceRoot> findByIdAndDeletedAtIsNull(UUID id);
}
