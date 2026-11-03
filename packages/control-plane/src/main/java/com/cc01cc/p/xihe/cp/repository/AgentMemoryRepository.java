package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.AgentMemory;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0629 M1 (V99) + user ruling 2026-11-04 (V107): memory rows are read through the
 * <b>subject</b> ({@code principal_id}) alone — the workspace is no longer part of any key, so the
 * same agent principal sees one memory set everywhere it is bound.
 *
 * <p>Every finder below carries the principal, so a query cannot accidentally cross the subject
 * boundary; authorization (which workspace context allowed the call) is decided by the caller before
 * the repository is reached.</p>
 */
@Repository
public interface AgentMemoryRepository extends JpaRepository<AgentMemory, UUID> {

    /**
     * D29-32 dedupe probe: live rows only (a soft-deleted row must not block a re-write).
     *
     * <p>Key is {@code (principal, content_sha256)}: the same sentence is the same assertion
     * regardless of channel or of the workspace the write came from.
     */
    Optional<AgentMemory> findByPrincipalIdAndContentSha256AndDeletedAtIsNull(
            UUID principalId, String contentSha256);

    /**
     * PLAN-0629 M1-6 idempotency probe: has this exact passive write already landed? The natural key is
     * {@code source_ref} ({@code passive.<mode>:<sessionId>:<compaction cursor>}), which is why the same
     * session end cannot write twice even when the summary text differs between attempts. Live rows
     * only — a rejected (soft-deleted) candidate must not block a later write.
     */
    boolean existsByPrincipalIdAndSourceRefAndDeletedAtIsNull(UUID principalId, String sourceRef);

    /** D29-34 injection read: pinned first, then freshest; only the requested status. */
    List<AgentMemory> findByPrincipalIdAndStatusAndDeletedAtIsNullOrderByPinnedDescUpdatedAtDesc(
            UUID principalId, String status);

    /**
     * PLAN-0629 M1-5 "归档" view: the same ordering but <b>including</b> soft-deleted rows, so the API
     * can show what was archived (and only the API: injection keeps using the live-only finder above).
     * Candidates stay excluded by the status filter — they are invisible to every listing.
     */
    List<AgentMemory> findByPrincipalIdAndStatusOrderByPinnedDescUpdatedAtDesc(
            UUID principalId, String status);

    /** Subject-checked lookup for "forget"/"update" — an id of another principal is unreachable. */
    Optional<AgentMemory> findByIdAndPrincipalIdAndDeletedAtIsNull(UUID id, UUID principalId);
}
