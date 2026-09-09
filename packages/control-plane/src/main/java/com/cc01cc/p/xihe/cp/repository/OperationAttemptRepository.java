package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.OperationAttempt;
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

public interface OperationAttemptRepository extends JpaRepository<OperationAttempt, UUID> {

    List<OperationAttempt> findByItemIdOrderByStartedAtAsc(String itemId);

    Optional<OperationAttempt> findByItemIdAndStageAndRetryNo(String itemId, String stage, Integer retryNo);

    Optional<OperationAttempt> findByItemIdAndStageAndRequestId(
            String itemId, String stage, String requestId);

    List<OperationAttempt> findByParentAttemptId(String parentAttemptId);

    @Query("select coalesce(max(a.retryNo), -1) from OperationAttempt a where a.itemId = :itemId and a.stage = :stage")
    int findMaxRetryNo(@Param("itemId") String itemId, @Param("stage") String stage);

    @Modifying
    @Transactional
    @Query("update OperationAttempt a set a.status = :status, a.httpStatus = :httpStatus, "
            + "a.errorCode = :errorCode, a.resultRef = :resultRef, a.durationMs = :durationMs, "
            + "a.finishedAt = :finishedAt "
            + "where a.id = :id and a.status = 'started'")
    int finishStarted(@Param("id") UUID id,
            @Param("status") String status,
            @Param("httpStatus") Integer httpStatus,
            @Param("errorCode") String errorCode,
            @Param("resultRef") String resultRef,
            @Param("durationMs") Long durationMs,
            @Param("finishedAt") Instant finishedAt);
}
