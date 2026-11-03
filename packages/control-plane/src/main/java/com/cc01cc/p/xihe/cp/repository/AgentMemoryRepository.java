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

    /**
     * D29-32 dedupe probe: live rows only (a soft-deleted row must not block a re-write).
     *
     * <p>PLAN-0629 M1-5 (V106): the key is {@code (principal, workspace, content_sha256)} — the
     * {@code type} column is gone, so the same sentence is the same assertion regardless of channel.
     */
    Optional<AgentMemory> findByPrincipalIdAndWorkspaceIdAndContentSha256AndDeletedAtIsNull(
            UUID principalId, UUID workspaceId, String contentSha256);

    /**
     * PLAN-0629 M1-6 idempotency probe: has this exact passive write already landed? The natural key is
     * {@code source_ref} ({@code passive.<mode>:<sessionId>:<compaction cursor>}), which is why the same
     * session end cannot write twice even when the summary text differs between attempts. Live rows
     * only — a rejected (soft-deleted) candidate must not block a later write.
     */
    boolean existsByPrincipalIdAndWorkspaceIdAndSourceRefAndDeletedAtIsNull(
            UUID principalId, UUID workspaceId, String sourceRef);

    /** D29-34 injection read: pinned first, then freshest; only the requested status. */
    List<AgentMemory> findByPrincipalIdAndWorkspaceIdAndStatusAndDeletedAtIsNullOrderByPinnedDescUpdatedAtDesc(
            UUID principalId, UUID workspaceId, String status);

    /**
     * PLAN-0629 M1-5 "归档" view: the same ordering but <b>including</b> soft-deleted rows, so the API
     * can show what was archived (and only the API: injection keeps using the live-only finder above).
     * Candidates stay excluded by the status filter — they are invisible to every listing.
     */
    List<AgentMemory> findByPrincipalIdAndWorkspaceIdAndStatusOrderByPinnedDescUpdatedAtDesc(
            UUID principalId, UUID workspaceId, String status);

    /** Scope-checked lookup for "forget" — an id from another workspace must not be reachable. */
    Optional<AgentMemory> findByIdAndPrincipalIdAndWorkspaceIdAndDeletedAtIsNull(
            UUID id, UUID principalId, UUID workspaceId);
}
