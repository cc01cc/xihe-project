package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.WorkspaceImport;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface WorkspaceImportRepository extends JpaRepository<WorkspaceImport, UUID> {
    Optional<WorkspaceImport> findByOwnerIdAndIdempotencyKey(String ownerId, String idempotencyKey);

    Optional<WorkspaceImport> findByIdAndOwnerId(UUID id, String ownerId);

    List<WorkspaceImport> findByWorkspaceIdOrderByCreatedAtDesc(UUID workspaceId);

    @Query("select count(i) > 0 from WorkspaceImport i where i.workspaceId = :workspaceId "
            + "and i.status in ('queued', 'running')")
    boolean existsActiveByWorkspaceId(@Param("workspaceId") UUID workspaceId);
}
