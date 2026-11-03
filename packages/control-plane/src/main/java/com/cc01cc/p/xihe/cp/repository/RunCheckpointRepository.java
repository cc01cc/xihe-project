package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.RunCheckpoint;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Durable workspace slice-checkpoint rows. Runtime owns the refs; CP owns this
 * projection and its revert bookkeeping. State changes stay conditional so a
 * raced expiry/revert cannot overwrite a newer lifecycle state.
 */
public interface RunCheckpointRepository extends JpaRepository<RunCheckpoint, UUID> {

    /**
     * Every slice row of one Run in one workspace — one per captured root
     * (PLAN-0639 M8). Callers that only care about the primary root filter on
     * {@code rootId.equals(workspaceId)}.
     */
    List<RunCheckpoint> findBySourceRunIdAndWorkspaceId(String sourceRunId, String workspaceId);

    /**
     * The single row of one (run, workspace, root): the per-root idempotency
     * lookup, replacing the pre-M8 (run, workspace) lookup whose uniqueness no
     * longer holds once a run is captured per declared root.
     */
    Optional<RunCheckpoint> findBySourceRunIdAndWorkspaceIdAndRootId(
            String sourceRunId, String workspaceId, String rootId);

    Optional<RunCheckpoint> findByWorkspaceIdAndSliceRef(String workspaceId, String sliceRef);

    List<RunCheckpoint> findByWorkspaceIdAndStateNotOrderByCapturedAtDesc(
            String workspaceId, String state);

    /**
     * Conditional revert bookkeeping: only a captured row records a new attempt, so a raced
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
     * Conditional expiry: a captured row whose
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
            + "and c.sliceRef is not null")
    long countSliceRefs(@Param("workspaceId") String workspaceId);

    @Modifying
    @Transactional
    @Query("delete from RunCheckpoint c where c.workspaceId = :workspaceId")
    int deleteByWorkspaceId(@Param("workspaceId") String workspaceId);
}
