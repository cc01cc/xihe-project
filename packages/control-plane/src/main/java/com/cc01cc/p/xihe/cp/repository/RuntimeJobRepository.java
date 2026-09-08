package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.RuntimeJob;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.UUID;

public interface RuntimeJobRepository extends JpaRepository<RuntimeJob, UUID> {

    List<RuntimeJob> findByWorkspaceIdAndStatus(UUID workspaceId, String status);

    List<RuntimeJob> findByStatus(String status);

    @Modifying
    @Transactional
    @Query("update RuntimeJob j set j.status = :newStatus, j.ownerId = :ownerId, "
            + "j.leaseExpiresAt = :leaseExpiresAt "
            + "where j.id = :id and j.status in :expectedStatuses")
    int transitionStatus(@Param("id") UUID id,
            @Param("expectedStatuses") Collection<String> expectedStatuses,
            @Param("newStatus") String newStatus,
            @Param("ownerId") String ownerId,
            @Param("leaseExpiresAt") Instant leaseExpiresAt);

    @Modifying
    @Transactional
    @Query("update RuntimeJob j set j.status = :newStatus, j.exitCode = :exitCode, "
            + "j.finishedAt = :finishedAt "
            + "where j.id = :id and j.status in :expectedStatuses")
    int completeJob(@Param("id") UUID id,
            @Param("expectedStatuses") Collection<String> expectedStatuses,
            @Param("newStatus") String newStatus,
            @Param("exitCode") Integer exitCode,
            @Param("finishedAt") Instant finishedAt);

    @Modifying
    @Transactional
    @Query("update RuntimeJob j set j.status = :newStatus, j.errorCode = :errorCode, "
            + "j.finishedAt = :finishedAt "
            + "where j.id = :id and j.status in :expectedStatuses")
    int failJob(@Param("id") UUID id,
            @Param("expectedStatuses") Collection<String> expectedStatuses,
            @Param("newStatus") String newStatus,
            @Param("errorCode") String errorCode,
            @Param("finishedAt") Instant finishedAt);

    @Modifying
    @Transactional
    @Query("update RuntimeJob j set j.status = 'orphaned', j.orphanedAt = :orphanedAt "
            + "where j.ownerId = :ownerId and j.status in ('queued', 'running') "
            + "and (:excludedIds is null or j.id not in :excludedIds)")
    int orphanByOwner(@Param("ownerId") String ownerId,
            @Param("excludedIds") Collection<UUID> excludedIds,
            @Param("orphanedAt") Instant orphanedAt);
}
