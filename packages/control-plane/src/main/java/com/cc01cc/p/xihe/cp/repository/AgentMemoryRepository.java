package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.AgentMemory;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0629 M1 (V99): memory rows are always read through the {@code (principal, workspace)} pair —
 * every finder below carries both, so a query cannot accidentally cross the isolation boundary.
 */
@Repository
public interface AgentMemoryRepository extends JpaRepository<AgentMemory, UUID> {

    /** D29-32 dedupe probe: live rows only (a soft-deleted row must not block a re-write). */
    Optional<AgentMemory> findByPrincipalIdAndWorkspaceIdAndTypeAndContentSha256AndDeletedAtIsNull(
            UUID principalId, UUID workspaceId, String type, String contentSha256);

    /** D29-34 injection read: pinned first, then freshest; only the requested status. */
    List<AgentMemory> findByPrincipalIdAndWorkspaceIdAndStatusAndDeletedAtIsNullOrderByPinnedDescUpdatedAtDesc(
            UUID principalId, UUID workspaceId, String status);

    /** Scope-checked lookup for "forget" — an id from another workspace must not be reachable. */
    Optional<AgentMemory> findByIdAndPrincipalIdAndWorkspaceIdAndDeletedAtIsNull(
            UUID id, UUID principalId, UUID workspaceId);
}
