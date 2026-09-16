package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.RunCheckpoint;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0338: durable Run slice-checkpoint rows. The unique key is
 * {@code (run_id, workspace_id)}; the runtime is authoritative for the slice
 * refs, the CP row is the projection the terminal hooks and the startup sweep
 * work on. Revert bookkeeping and expiry stay conditional so a raced state
 * change can never be overwritten.
 */
public interface RunCheckpointRepository extends JpaRepository<RunCheckpoint, UUID> {

    Optional<RunCheckpoint> findByRunIdAndWorkspaceId(String runId, String workspaceId);

    /**
     * Conditional revert bookkeeping (PLAN-0328 M3 W2, slice-state guard
     * PLAN-0338): only a captured row records a new attempt, so a raced
     * expiry/degrade can never be overwritten and the attempt counter increments
     * exactly once per accepted revert.
     */
    @Modifying
    @Transactional
    @Query("update RunCheckpoint c set c.revertState = :revertState, c.revertRef = :revertRef, "
            + "c.revertSummary = :revertSummary, c.revertedAt = :revertedAt, "
            + "c.revertAttemptCount = c.revertAttemptCount + 1, c.updatedAt = :revertedAt "
            + "where c.id = :id and c.state in ('captured', 'abnormal-captured')")
    int markReverted(
            @Param("id") UUID id,
            @Param("revertState") String revertState,
            @Param("revertRef") String revertRef,
            @Param("revertSummary") String revertSummary,
            @Param("revertedAt") Instant revertedAt);

    /**
     * Conditional expiry (decision #74 first consumer): a captured row whose
     * Runtime slice refs are gone flips to {@code expired} exactly once; rows in
     * any other state are untouched.
     */
    @Modifying
    @Transactional
    @Query("update RunCheckpoint c set c.state = 'expired', c.updatedAt = :expiredAt "
            + "where c.id = :id and c.state in ('captured', 'abnormal-captured')")
    int markExpired(@Param("id") UUID id, @Param("expiredAt") Instant expiredAt);

    long countByWorkspaceId(String workspaceId);

    @Query("select count(c) from RunCheckpoint c where c.workspaceId = :workspaceId "
            + "and c.baseRef is not null")
    long countBaseRefs(@Param("workspaceId") String workspaceId);

    @Query("select count(c) from RunCheckpoint c where c.workspaceId = :workspaceId "
            + "and c.endRef is not null")
    long countEndRefs(@Param("workspaceId") String workspaceId);
}
