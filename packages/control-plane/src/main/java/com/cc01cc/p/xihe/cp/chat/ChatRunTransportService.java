package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ChatRunTransportAttempt;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunTransportAttemptRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/** Sole writer for durable provider HTTP attempt lifecycle rows (PLAN-0508). */
@Service
public class ChatRunTransportService {

    private static final Logger logger = LoggerFactory.getLogger(ChatRunTransportService.class);
    private static final Set<String> AGENT_TERMINAL_OUTCOMES = Set.of(
            ChatRunTransportAttempt.OUTCOME_SUCCESS,
            ChatRunTransportAttempt.OUTCOME_ERROR,
            ChatRunTransportAttempt.OUTCOME_TIMEOUT,
            ChatRunTransportAttempt.OUTCOME_ABORTED);
    private static final Set<String> PROGRESS_STAGES = Set.of(
            ChatRunTransportAttempt.STAGE_ATTEMPT_STARTED,
            ChatRunTransportAttempt.STAGE_FIRST_CHUNK,
            ChatRunTransportAttempt.STAGE_STREAMING,
            ChatRunTransportAttempt.STAGE_ATTEMPT_FINISHED);

    private final DbLockTimeout dbLockTimeout;
    private final ChatRunRepository chatRuns;
    private final ChatRunTransportAttemptRepository attempts;

    public ChatRunTransportService(
            DbLockTimeout dbLockTimeout,
            ChatRunRepository chatRuns,
            ChatRunTransportAttemptRepository attempts) {
        this.dbLockTimeout = dbLockTimeout;
        this.chatRuns = chatRuns;
        this.attempts = attempts;
    }

    /**
     * Persist the start receipt before the CP relays the bounded progress event.
     * The ChatRun row lock serializes start acceptance with its terminal transition.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public boolean startAttempt(String runId, UUID attemptId, long sequence, Instant startedAt) {
        if (runId == null || runId.isBlank() || attemptId == null || sequence < 1 || startedAt == null) {
            throw new IllegalArgumentException("Invalid transport attempt start");
        }
        UUID runUuid = UUID.fromString(runId);
        dbLockTimeout.apply();
        ChatRun run = chatRuns.findByIdForUpdate(runUuid).orElse(null);
        if (run == null || ChatRunTerminalService.isTerminalStatus(run.getStatus())) {
            logger.info("[LIFECYCLE] service=cp event=transport_attempt_start_ignored runId={} attemptId={} "+
                    "reason=run_missing_or_terminal", runId, attemptId);
            return false;
        }

        Optional<ChatRunTransportAttempt> byId = attempts.findById(attemptId);
        if (byId.isPresent()) {
            ChatRunTransportAttempt existing = byId.get();
            if (runId.equals(existing.getRunId()) && Long.valueOf(sequence).equals(existing.getSequence())) {
                return false;
            }
            logger.warn("[LIFECYCLE] service=cp event=transport_attempt_identity_conflict runId={} attemptId={}",
                    runId, attemptId);
            return false;
        }
        if (attempts.findByRunIdAndSequence(runId, sequence).isPresent()) {
            logger.warn("[LIFECYCLE] service=cp event=transport_attempt_sequence_conflict runId={} seq={}",
                    runId, sequence);
            return false;
        }

        ChatRunTransportAttempt row = new ChatRunTransportAttempt();
        row.setAttemptId(attemptId);
        row.setRunId(runId);
        row.setSessionId(run.getSessionId());
        row.setSequence(sequence);
        row.setStatus(ChatRunTransportAttempt.STATUS_RUNNING);
        row.setStartedAt(startedAt);
        attempts.saveAndFlush(row);
        logger.debug("[LIFECYCLE] service=cp event=transport_attempt_started runId={} attemptId={} seq={}",
                runId, attemptId, sequence);
        return true;
    }

    /**
     * Persist the last accepted bounded progress sample before the CP relays
     * its progress event (B1 minimal). Stage rank is strictly monotonic, so
     * duplicate or out-of-order stages are idempotent no-ops and the sample
     * never regresses; the sample is frozen once the row is terminal.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public boolean recordProgress(String runId, UUID attemptId, long sequence, String stage, long elapsedMs) {
        if (runId == null || runId.isBlank() || attemptId == null || sequence < 1
                || stage == null || !PROGRESS_STAGES.contains(stage) || elapsedMs < 0) {
            throw new IllegalArgumentException("Invalid transport attempt progress");
        }
        UUID runUuid = UUID.fromString(runId);
        dbLockTimeout.apply();
        return attempts.recordProgressStage(attemptId, runUuid, sequence, stage, elapsedMs) == 1;
    }

    /**
     * Persist an Agent terminal summary. A missing start receipt falls back to a
     * terminal-only row; duplicate terminal messages are idempotent no-ops.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public boolean completeAttempt(String runId, UUID attemptId, long sequence, AttemptCompletion completion) {
        validateCompletion(runId, attemptId, sequence, completion);
        UUID runUuid = UUID.fromString(runId);
        dbLockTimeout.apply();
        ChatRun run = chatRuns.findByIdForUpdate(runUuid).orElse(null);
        if (run == null) {
            return false;
        }

        Optional<ChatRunTransportAttempt> byId = attempts.findById(attemptId);
        if (byId.isPresent()) {
            ChatRunTransportAttempt existing = byId.get();
            if (!runId.equals(existing.getRunId()) || !Long.valueOf(sequence).equals(existing.getSequence())) {
                logger.warn("[LIFECYCLE] service=cp event=transport_attempt_identity_conflict runId={} attemptId={}",
                        runId, attemptId);
                return false;
            }
            if (ChatRunTransportAttempt.STATUS_TERMINAL.equals(existing.getStatus())) {
                return false;
            }
            return attempts.completeRunningAttempt(
                    attemptId, runId, completion.outcome(), completion.startedAt(), completion.endedAt(),
                    completion.durationMs(), completion.errorCode(), completion.providerHttpStatus(),
                    completion.firstChunkMs(), completion.chunkCount()) == 1;
        }

        if (attempts.findByRunIdAndSequence(runId, sequence).isPresent()) {
            logger.warn("[LIFECYCLE] service=cp event=transport_attempt_sequence_conflict runId={} seq={}",
                    runId, sequence);
            return false;
        }
        ChatRunTransportAttempt row = terminalRow(run, attemptId, sequence, completion);
        attempts.saveAndFlush(row);
        logger.debug("[LIFECYCLE] service=cp event=transport_attempt_terminal_fallback_inserted runId={} attemptId={} seq={} outcome={}",
                runId, attemptId, sequence, completion.outcome());
        return true;
    }

    /**
     * Best-effort after-commit reconciliation for one Run. It runs in a fresh
     * transaction so telemetry failures cannot roll back the Run terminal commit.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int reconcileRunAfterTerminal(String runId, Instant terminalAt) {
        if (runId == null || runId.isBlank() || terminalAt == null) {
            throw new IllegalArgumentException("Invalid transport attempt reconciliation");
        }
        dbLockTimeout.apply();
        return attempts.reconcileRunningForRun(runId, terminalAt);
    }

    /**
     * Repair the process-crash gap between Run commit and its after-commit
     * callback. Caller invokes this on the existing reconciliation schedule.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int reconcileOrphanedTerminalAttempts() {
        dbLockTimeout.apply();
        return attempts.reconcileOrphanedTerminalAttempts();
    }

    private ChatRunTransportAttempt terminalRow(
            ChatRun run, UUID attemptId, long sequence, AttemptCompletion completion) {
        ChatRunTransportAttempt row = new ChatRunTransportAttempt();
        row.setAttemptId(attemptId);
        row.setRunId(run.getId().toString());
        row.setSessionId(run.getSessionId());
        row.setSequence(sequence);
        row.setStatus(ChatRunTransportAttempt.STATUS_TERMINAL);
        row.setOutcome(completion.outcome());
        row.setStartedAt(completion.startedAt());
        row.setEndedAt(completion.endedAt());
        row.setDurationMs(completion.durationMs());
        row.setErrorCode(completion.errorCode());
        row.setProviderHttpStatus(completion.providerHttpStatus());
        row.setFirstChunkMs(completion.firstChunkMs());
        row.setChunkCount(completion.chunkCount());
        return row;
    }

    private static void validateCompletion(
            String runId, UUID attemptId, long sequence, AttemptCompletion completion) {
        if (runId == null || runId.isBlank() || attemptId == null || sequence < 1 || completion == null) {
            throw new IllegalArgumentException("Invalid transport attempt terminal summary");
        }
        if (!AGENT_TERMINAL_OUTCOMES.contains(completion.outcome())) {
            throw new IllegalArgumentException("Unsupported Agent transport attempt outcome");
        }
        if (completion.startedAt() == null || completion.endedAt() == null || completion.durationMs() < 0
                || completion.firstChunkMs() != null && completion.firstChunkMs() < 0
                || completion.chunkCount() == null || completion.chunkCount() < 0) {
            throw new IllegalArgumentException("Invalid transport attempt measurements");
        }
        if (completion.errorCode() != null && completion.providerHttpStatus() != null) {
            throw new IllegalArgumentException("Transport attempt error code sources are mutually exclusive");
        }
    }

    public record AttemptCompletion(
            String outcome,
            Instant startedAt,
            Instant endedAt,
            long durationMs,
            String errorCode,
            Integer providerHttpStatus,
            Long firstChunkMs,
            Long chunkCount) {}
}
