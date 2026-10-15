package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.entity.ChatRunTransportAttempt;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ChatRunTransportAttemptRepository
        extends JpaRepository<ChatRunTransportAttempt, UUID> {

    Optional<ChatRunTransportAttempt> findByAttemptIdAndRunId(UUID attemptId, String runId);

    Optional<ChatRunTransportAttempt> findByRunIdAndSequence(String runId, Long sequence);

    List<ChatRunTransportAttempt> findByRunIdOrderBySequenceAsc(String runId);

    @Query(value = "SELECT COUNT(*) AS attempt_count, "
            + "COALESCE(SUM(CASE WHEN outcome IN ('error', 'timeout') THEN 1 ELSE 0 END), 0) AS failed_count, "
            + "COALESCE(SUM(CASE WHEN outcome IN ('aborted', 'partial') THEN 1 ELSE 0 END), 0) AS partial_count "
            + "FROM chat_run_transport_attempts WHERE session_id = CAST(:sessionId AS UUID)",
            nativeQuery = true)
    List<Object[]> aggregateCountsForSession(@Param("sessionId") String sessionId);

    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("update ChatRunTransportAttempt a set a.status = 'terminal', a.outcome = :outcome, "
            + "a.startedAt = :startedAt, a.endedAt = :endedAt, a.durationMs = :durationMs, "
            + "a.errorCode = :errorCode, a.providerHttpStatus = :providerHttpStatus, "
            + "a.firstChunkMs = :firstChunkMs, a.chunkCount = :chunkCount, "
            + "a.updatedAt = CURRENT_INSTANT "
            + "where a.attemptId = :attemptId and a.runId = :runId and a.status = 'running'")
    int completeRunningAttempt(
            @Param("attemptId") UUID attemptId,
            @Param("runId") String runId,
            @Param("outcome") String outcome,
            @Param("startedAt") Instant startedAt,
            @Param("endedAt") Instant endedAt,
            @Param("durationMs") Long durationMs,
            @Param("errorCode") String errorCode,
            @Param("providerHttpStatus") Integer providerHttpStatus,
            @Param("firstChunkMs") Long firstChunkMs,
            @Param("chunkCount") Long chunkCount);

    /**
     * Bounded last-stage sample update. The stage rank guard makes stale or
     * duplicate progress a no-op, so out-of-order relay cannot regress the
     * sample; the status predicate freezes it once the row is terminal.
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(value = "UPDATE chat_run_transport_attempts "
            + "SET last_progress_stage = :stage, last_progress_elapsed_ms = :elapsedMs, "
            + "updated_at = NOW() "
            + "WHERE attempt_id = :attemptId AND run_id = :runId AND seq = :sequence "
            + "AND status = 'running' "
            + "AND (last_progress_stage IS NULL "
            + "OR (CASE :stage WHEN 'attempt_started' THEN 1 WHEN 'first_chunk' THEN 2 "
            + "WHEN 'streaming' THEN 3 ELSE 4 END) "
            + "> (CASE last_progress_stage WHEN 'attempt_started' THEN 1 WHEN 'first_chunk' THEN 2 "
            + "WHEN 'streaming' THEN 3 ELSE 4 END))",
            nativeQuery = true)
    int recordProgressStage(
            @Param("attemptId") UUID attemptId,
            @Param("runId") UUID runId,
            @Param("sequence") long sequence,
            @Param("stage") String stage,
            @Param("elapsedMs") long elapsedMs);

    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("update ChatRunTransportAttempt a set a.status = 'terminal', a.outcome = 'partial', "
            + "a.endedAt = :terminalAt, a.updatedAt = CURRENT_INSTANT "
            + "where a.runId = :runId and a.status = 'running'")
    int reconcileRunningForRun(
            @Param("runId") String runId,
            @Param("terminalAt") Instant terminalAt);

    /**
     * Scheduled crash-gap repair. Run terminal_at is the durable marker set by
     * the sole terminal-state owner; the status predicate keeps this idempotent.
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(value = "UPDATE chat_run_transport_attempts a "
            + "SET status = 'terminal', outcome = 'partial', ended_at = r.terminal_at, "
            + "updated_at = NOW() "
            + "FROM chat_runs r "
            + "WHERE a.run_id = r.id "
            + "AND a.status = 'running' "
            + "AND r.terminal_at IS NOT NULL",
            nativeQuery = true)
    int reconcileOrphanedTerminalAttempts();
}
