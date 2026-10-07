package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.McpAttempt;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface McpAttemptRepository extends JpaRepository<McpAttempt, UUID> {

    List<McpAttempt> findByInvocationIdOrderByStartedAtAsc(UUID invocationId);

    Optional<McpAttempt> findByInvocationIdAndStageAndRequestId(
            UUID invocationId, String stage, String requestId);

    @Query("select coalesce(max(a.retryNo), -1) from McpAttempt a "
            + "where a.invocationId = :invocationId and a.stage = :stage")
    int findMaxRetryNo(@Param("invocationId") UUID invocationId, @Param("stage") String stage);

    /** The unknown dispatch a late-termination report can settle. */
    Optional<McpAttempt> findFirstByInvocationIdAndStatusOrderByStartedAtDesc(
            UUID invocationId, String status);

    @Modifying
    @Transactional
    @Query("update McpAttempt a set a.status = :status, a.httpStatus = :httpStatus, "
            + "a.errorCode = :errorCode, a.resultRef = :resultRef, a.durationMs = :durationMs, "
            + "a.finishedAt = :finishedAt, a.updatedAt = :updatedAt "
            + "where a.id = :id and a.status = 'started'")
    int finishStarted(@Param("id") UUID id,
            @Param("status") String status,
            @Param("httpStatus") Integer httpStatus,
            @Param("errorCode") String errorCode,
            @Param("resultRef") String resultRef,
            @Param("durationMs") Long durationMs,
            @Param("finishedAt") Instant finishedAt,
            @Param("updatedAt") Instant updatedAt);

    /** unknown → late_confirmed (owner-matrix §3), only from the unknown state. */
    @Modifying
    @Transactional
    @Query("update McpAttempt a set a.status = 'late_confirmed', a.finishedAt = :finishedAt, "
            + "a.updatedAt = :updatedAt where a.id = :id and a.status = 'unknown'")
    int confirmLate(@Param("id") UUID id,
            @Param("finishedAt") Instant finishedAt,
            @Param("updatedAt") Instant updatedAt);
}
