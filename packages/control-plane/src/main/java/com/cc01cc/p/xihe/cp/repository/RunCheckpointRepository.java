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
}
