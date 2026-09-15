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
 * PLAN-0328 M2 W3: durable Run checkpoint rows. The unique key is
 * {@code (run_id, workspace_id)}; seal is a conditional base → sealed update so
 * concurrent terminal transitions can never double-apply a seal.
 */
public interface RunCheckpointRepository extends JpaRepository<RunCheckpoint, UUID> {

    Optional<RunCheckpoint> findByRunIdAndWorkspaceId(String runId, String workspaceId);

    List<RunCheckpoint> findByRunId(String runId);

    List<RunCheckpoint> findByState(String state);

    /**
     * Conditional seal: only a row still in {@code base} transitions, so a second
     * (idempotent) seal attempt affects zero rows and appends no duplicate fact.
     */
    @Modifying
    @Transactional
    @Query("update RunCheckpoint c set c.state = 'sealed', c.endRef = :endRef, "
            + "c.changedFiles = :changedFiles, c.sealedWithLiveJobs = :sealedWithLiveJobs, "
            + "c.sealedAfterAbnormal = :sealedAfterAbnormal, c.sealedAt = :sealedAt, c.updatedAt = :sealedAt "
            + "where c.id = :id and c.state = 'base'")
    int markSealed(
            @Param("id") UUID id,
            @Param("endRef") String endRef,
            @Param("changedFiles") String changedFiles,
            @Param("sealedWithLiveJobs") boolean sealedWithLiveJobs,
            @Param("sealedAfterAbnormal") boolean sealedAfterAbnormal,
            @Param("sealedAt") Instant sealedAt);

    /**
     * Conditional revert bookkeeping (PLAN-0328 M3 W2): only a row still in
     * {@code sealed} records a new attempt, so a raced expiry/degrade can never be
     * overwritten and the attempt counter increments exactly once per accepted
     * revert.
     */
    @Modifying
    @Transactional
    @Query("update RunCheckpoint c set c.revertState = :revertState, c.revertRef = :revertRef, "
            + "c.revertSummary = :revertSummary, c.revertedAt = :revertedAt, "
            + "c.revertAttemptCount = c.revertAttemptCount + 1, c.updatedAt = :revertedAt "
            + "where c.id = :id and c.state = 'sealed'")
    int markReverted(
            @Param("id") UUID id,
            @Param("revertState") String revertState,
            @Param("revertRef") String revertRef,
            @Param("revertSummary") String revertSummary,
            @Param("revertedAt") Instant revertedAt);

    /**
     * Conditional expiry (decision #74 first consumer): a sealed row whose Runtime
     * refs are gone flips to {@code expired} exactly once; rows in any other state
     * are untouched.
     */
    @Modifying
    @Transactional
    @Query("update RunCheckpoint c set c.state = 'expired', c.updatedAt = :expiredAt "
            + "where c.id = :id and c.state = 'sealed'")
    int markExpired(@Param("id") UUID id, @Param("expiredAt") Instant expiredAt);

    long countByWorkspaceId(String workspaceId);

    @Query("select count(c) from RunCheckpoint c where c.workspaceId = :workspaceId "
            + "and c.baseRef is not null")
    long countBaseRefs(@Param("workspaceId") String workspaceId);

    @Query("select count(c) from RunCheckpoint c where c.workspaceId = :workspaceId "
            + "and c.endRef is not null")
    long countEndRefs(@Param("workspaceId") String workspaceId);
}
