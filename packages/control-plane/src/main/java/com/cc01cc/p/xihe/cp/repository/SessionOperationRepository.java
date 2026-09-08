package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.SessionOperation;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface SessionOperationRepository extends JpaRepository<SessionOperation, UUID> {

    Optional<SessionOperation> findByRunId(String runId);

    boolean existsByUserIdAndSessionIdAndIdempotencyKey(
            String userId, String sessionId, String idempotencyKey);

    Optional<SessionOperation> findByUserIdAndSessionIdAndIdempotencyKey(
            String userId, String sessionId, String idempotencyKey);

    List<SessionOperation> findBySessionIdOrderByCreatedAtDesc(String sessionId);

    List<SessionOperation> findByWorkspaceIdOrderByCreatedAtDesc(String workspaceId);

    @Query("select o from SessionOperation o where o.userId = :userId "
            + "and (:sessionId is null or o.sessionId = :sessionId) "
            + "and (:workspaceId is null or o.workspaceId = :workspaceId) "
            + "and (:status is null or o.status = :status)")
    Page<SessionOperation> searchByUserId(@Param("userId") String userId,
            @Param("sessionId") String sessionId,
            @Param("workspaceId") String workspaceId,
            @Param("status") String status,
            Pageable pageable);

    @Modifying
    @Transactional
    @Query("update SessionOperation o set o.status = :status, o.errorCode = :errorCode, "
            + "o.errorRef = :errorRef, o.finishedAt = :finishedAt "
            + "where o.id = :id and o.status in :expectedStatuses")
    int transitionStatus(@Param("id") UUID id,
            @Param("expectedStatuses") Collection<String> expectedStatuses,
            @Param("status") String status,
            @Param("errorCode") String errorCode,
            @Param("errorRef") String errorRef,
            @Param("finishedAt") Instant finishedAt);
}
