package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface McpInvocationRepository extends JpaRepository<McpInvocation, UUID> {

    /** Agent idempotency key (V49 partial unique index on (run_id, tool_call_id)). */
    Optional<McpInvocation> findByRunIdAndToolCallIdAndSource(
            String runId, String toolCallId, String source);

    Optional<McpInvocation> findBySourceAndToolCallId(String source, String toolCallId);

    /** Row lock so the history sequence allocation is serialized per invocation. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select i from McpInvocation i where i.id = :id")
    Optional<McpInvocation> findByIdForUpdate(@Param("id") UUID id);

    List<McpInvocation> findByRunIdOrderByCreatedAtAsc(String runId);

    /** PLAN-0464: run-terminal reconciliation looks up stranded active rows. */
    List<McpInvocation> findByRunIdAndStatus(String runId, String status);

    List<McpInvocation> findByWorkspaceIdAndStatus(String workspaceId, String status);

    boolean existsBySessionId(String sessionId);

    long deleteBySessionId(String sessionId);

    long deleteByWorkspaceId(String workspaceId);
}
