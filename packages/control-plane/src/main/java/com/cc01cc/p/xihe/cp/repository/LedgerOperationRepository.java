package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.LedgerOperation;
import jakarta.persistence.LockModeType;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface LedgerOperationRepository extends JpaRepository<LedgerOperation, UUID> {

    Optional<LedgerOperation> findByRunId(String runId);

    boolean existsByUserIdAndSessionIdAndIdempotencyKey(
            String userId, String sessionId, String idempotencyKey);

    Optional<LedgerOperation> findByUserIdAndSessionIdAndIdempotencyKey(
            String userId, String sessionId, String idempotencyKey);

    /**
     * PLAN-0390：Workspace 级 Job（session_id 为 NULL）的幂等键。
     * 既有 {@code uq_session_operations_idempotency} 在 session_id NULL 时
     * 不构成约束（Postgres 唯一索引把 NULL 视为互异），因此另加
     * {@code uq_ledger_operations_workspace_job_idempotency} 承载该语义。
     */
    Optional<LedgerOperation> findByUserIdAndWorkspaceIdAndKindAndIdempotencyKey(
            String userId, String workspaceId, String kind, String idempotencyKey);

    List<LedgerOperation> findBySessionIdOrderByCreatedAtDesc(String sessionId);

    List<LedgerOperation> findByWorkspaceIdOrderByCreatedAtDesc(String workspaceId);

    List<LedgerOperation> findByWorkspaceIdAndKindOrderByCreatedAtDesc(String workspaceId, String kind);

    @Query("select o from LedgerOperation o where o.userId = :userId "
            + "and (:sessionId is null or o.sessionId = :sessionId) "
            + "and (:workspaceId is null or o.workspaceId = :workspaceId) "
            + "and (:status is null or o.status = :status)")
    Page<LedgerOperation> searchByUserId(@Param("userId") String userId,
            @Param("sessionId") String sessionId,
            @Param("workspaceId") String workspaceId,
            @Param("status") String status,
            Pageable pageable);

    /**
     * PLAN-0317 决策 #7②：追加 item/event 前锁定该 operation 行，串行化同一
     * operation 内的序号分配（并发时不再靠唯一约束回滚）。
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select o from LedgerOperation o where o.id = :id")
    Optional<LedgerOperation> findByIdForUpdate(@Param("id") UUID id);

    // PLAN-0317 决策 #7①：批量状态转换必须显式刷新 updated_at（JPQL 绕过
    // @PreUpdate，此前时间戳停在插入值）。
    @Modifying
    @Transactional
    @Query("update LedgerOperation o set o.status = :status, o.errorCode = :errorCode, "
            + "o.errorRef = :errorRef, o.finishedAt = :finishedAt, "
            + "o.updatedAt = CURRENT_INSTANT "
            + "where o.id = :id and o.status in :expectedStatuses")
    int transitionStatus(@Param("id") UUID id,
            @Param("expectedStatuses") Collection<String> expectedStatuses,
            @Param("status") String status,
            @Param("errorCode") String errorCode,
            @Param("errorRef") String errorRef,
            @Param("finishedAt") Instant finishedAt);
}
