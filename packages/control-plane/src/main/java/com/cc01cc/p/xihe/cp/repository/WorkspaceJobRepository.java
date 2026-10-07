package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.WorkspaceJob;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0465 T1.1: `workspace_jobs` repository.
 *
 * <p>Read-modify-write of the mutable Job state always goes through a
 * `...ForUpdate` probe so reconciliation, scope closure and tool-result sync
 * serialize on the row (the extension-era row lock, now on the domain row).</p>
 */
public interface WorkspaceJobRepository extends JpaRepository<WorkspaceJob, UUID> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select j from WorkspaceJob j where j.id = :id")
    Optional<WorkspaceJob> findByIdForUpdate(@Param("id") UUID id);

    Optional<WorkspaceJob> findByOperationItemId(UUID operationItemId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select j from WorkspaceJob j where j.operationItemId = :operationItemId")
    Optional<WorkspaceJob> findByOperationItemIdForUpdate(
            @Param("operationItemId") UUID operationItemId);

    /**
     * PLAN-0465：post-0464 chat-run MCP 行以 tool_call_id 为物化键
     *（一个 tool call 对应一个 job 档案，get/cancel 结果回写同一行）。
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select j from WorkspaceJob j where j.toolCallId = :toolCallId")
    Optional<WorkspaceJob> findByToolCallIdForUpdate(@Param("toolCallId") UUID toolCallId);

    List<WorkspaceJob> findByWorkspaceIdOrderByCreatedAtDesc(UUID workspaceId);

    /** Idempotent replay (V36 semantics): session-bound key. */
    Optional<WorkspaceJob> findByUserIdAndSessionIdAndIdempotencyKey(
            UUID userId, UUID sessionId, String idempotencyKey);

    /** Idempotent replay (V36 semantics): session-less key. */
    @Query("select j from WorkspaceJob j where j.userId = :userId "
            + "and j.workspaceId = :workspaceId and j.sessionId is null "
            + "and j.idempotencyKey = :idempotencyKey")
    Optional<WorkspaceJob> findSessionLessByKey(@Param("userId") UUID userId,
                                                @Param("workspaceId") UUID workspaceId,
                                                @Param("idempotencyKey") String idempotencyKey);

    boolean existsByWorkspaceIdAndStatusIn(UUID workspaceId, Collection<String> status);

    List<WorkspaceJob> findByWorkspaceIdAndStatusInOrderByCreatedAtAsc(
            UUID workspaceId, Collection<String> status);

    /** Reconciliation sweep: running rows created after the window. */
    List<WorkspaceJob> findByStatusAndCreatedAtAfter(String status, Instant createdAfter);

    /** Scope closure / destroy scans (status filter applied by callers). */
    List<WorkspaceJob> findByScopeAndRunIdAndStatusIn(
            String scope, UUID runId, Collection<String> status);

    List<WorkspaceJob> findByScopeAndSessionIdAndStatusIn(
            String scope, UUID sessionId, Collection<String> status);

    List<WorkspaceJob> findByScopeAndWorkspaceIdAndStatusIn(
            String scope, UUID workspaceId, Collection<String> status);

    /** PLAN-0465 T2.2: Message jobSummary source (run → domain rows). */
    List<WorkspaceJob> findByRunIdOrderByCreatedAtAsc(UUID runId);
}
