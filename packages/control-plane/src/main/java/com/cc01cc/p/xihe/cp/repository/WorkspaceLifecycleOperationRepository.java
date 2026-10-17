package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.WorkspaceLifecycleOperation;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0391 (decision #27): `workspace_lifecycle_operations` repository.
 *
 * <p>Read-modify-write of a release operation goes through a
 * {@code ...ForUpdate} probe so an accept/settle race serializes on the row
 * (mirrors the Workspace Job row-lock discipline).</p>
 */
public interface WorkspaceLifecycleOperationRepository
        extends JpaRepository<WorkspaceLifecycleOperation, UUID> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select o from WorkspaceLifecycleOperation o where o.id = :id")
    Optional<WorkspaceLifecycleOperation> findByIdForUpdate(@Param("id") UUID id);

    /** Idempotent replay: same key returns the existing operation. */
    Optional<WorkspaceLifecycleOperation> findByUserIdAndWorkspaceIdAndIdempotencyKey(
            UUID userId, UUID workspaceId, String idempotencyKey);

    /** Environment projection / recovery: latest operation for the workspace. */
    Optional<WorkspaceLifecycleOperation> findFirstByWorkspaceIdOrderByCreatedAtDesc(UUID workspaceId);

    /** At most one in-flight release per workspace (also enforced by a partial unique index). */
    Optional<WorkspaceLifecycleOperation> findFirstByWorkspaceIdAndStatusIn(
            UUID workspaceId, Collection<String> status);

    /** Recovery sweep after a CP restart: operations left accepted/running. */
    java.util.List<WorkspaceLifecycleOperation> findByStatusIn(Collection<String> status);

    /** Periodic sweep: operations left in-flight beyond the staleness cutoff. */
    java.util.List<WorkspaceLifecycleOperation> findByStatusInAndCreatedAtBefore(
            Collection<String> status, java.time.Instant cutoff);
}
