package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

public interface ChatRunRepository extends JpaRepository<ChatRun, UUID> {

    List<String> ACTIVE_LEASE_STATUSES = List.of(
            "accepted", "queued", "running", "streaming", "awaiting_approval", "dispatching");

    Optional<ChatRun> findByUserIdAndSessionIdAndIdempotencyKey(
            String userId, String sessionId, String idempotencyKey);

    Optional<ChatRun> findByUserIdAndIdempotencyKeyAndOrigin(
            String userId, String idempotencyKey, String origin);

    /** PLAN-0352 T1.2：会话删除路径枚举非终态 run（含 cancelling）。 */
    List<ChatRun> findBySessionIdAndStatusIn(String sessionId, Collection<String> statuses);

    @Modifying
    @Transactional
    @Query("update ChatRun r set r.status = :status, r.terminalOutcome = :outcome, "
            + "r.errorCode = :errorCode, r.errorDetail = :errorDetail, "
            + "r.tokenCount = :tokenCount, r.assistantChars = :assistantChars "
            + "where r.id = :id and r.status in :expectedStatuses")
    int transition(
            @Param("id") UUID id,
            @Param("expectedStatuses") Collection<String> expectedStatuses,
            @Param("status") String status,
            @Param("outcome") String outcome,
            @Param("errorCode") String errorCode,
            @Param("errorDetail") String errorDetail,
            @Param("tokenCount") int tokenCount,
            @Param("assistantChars") int assistantChars);

    @Modifying
    @Transactional
    @Query("update ChatRun r set r.leaseOwner = :owner, r.leaseExpiresAt = :expiresAt "
            + "where r.id = :runId and r.status in :activeStatuses "
            + "and (r.leaseOwner = :owner or r.leaseOwner is null or r.leaseExpiresAt < :now)")
    int tryAcquireLease(
            @Param("runId") UUID runId,
            @Param("owner") String owner,
            @Param("expiresAt") Instant expiresAt,
            @Param("now") Instant now,
            @Param("activeStatuses") Collection<String> activeStatuses);

    @Modifying
    @Transactional
    @Query("update ChatRun r set r.leaseOwner = null, r.leaseExpiresAt = null "
            + "where r.id = :runId and r.leaseOwner = :owner")
    int releaseLease(
            @Param("runId") UUID runId,
            @Param("owner") String owner);

    @Query("select r from ChatRun r where r.status in :activeStatuses")
    List<ChatRun> findRecoverableRuns(@Param("activeStatuses") Collection<String> activeStatuses);

    /** PLAN-0317 T2.6：重启时收敛被取消请求卡住的 run（cancelling 无 lease、不在恢复集内）。 */
    List<ChatRun> findByStatus(String status);

    /**
     * PLAN-0317 T2.7（决策 #9）：周期对账候选——非终态、无有效 lease、且创建已超过
     * 宽限期的 run。调用方必须再用"本进程是否正在处理该 run"做二次保护（避免误伤）。
     */
    @Query("select r from ChatRun r where r.status in :statuses "
            + "and (r.leaseOwner is null or r.leaseExpiresAt is null or r.leaseExpiresAt < :staleBefore) "
            + "and r.createdAt < :createdBefore")
    List<ChatRun> findStaleActiveRuns(@Param("statuses") Collection<String> statuses,
            @Param("staleBefore") Instant staleBefore,
            @Param("createdBefore") Instant createdBefore);

    /**
     * PLAN-0338 切片模型启动补偿：已终态但没有任何 checkpoint 投影行的 run
     * （进程在终态捕获前退出，或升级前从未写过行）。原生 SQL 是因为
     * {@code run_checkpoints.source_run_id} 经 {@link com.cc01cc.p.xihe.cp.entity.UuidStringConverter}
     * 映射为字符串，JPQL 无法与 {@code chat_runs.id}（UUID）直接比较。
     * 调用方按页取用，保证单次启动的补偿量有界。
     */
    @Query(value = "select r.* from chat_runs r where r.status in (:statuses) "
            + "and not exists (select 1 from run_checkpoints c where c.source_run_id = r.id)",
            nativeQuery = true)
    List<ChatRun> findTerminalRunsWithoutCheckpoint(@Param("statuses") Collection<String> statuses,
            Pageable pageable);
}
