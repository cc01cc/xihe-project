package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.RunCheckpoint;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.RunCheckpointRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeCheckpointClient;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicLong;

/**
 * PLAN-0338: Run slice-checkpoint lifecycle on the CP side.
 *
 * <p>The Runtime owns the slice refs; this service keeps the durable CP
 * projection and wires it to the chat Run lifecycle:</p>
 * <ul>
 *   <li>{@link #captureCheckpoint} — single capture at the Run terminal
 *       transition (no-change → no slice ref); a failed capture records
 *       {@code degraded} + {@code unrollableReason} instead of blocking the
 *       terminal transition;</li>
 *   <li>{@link #requestCapture} — fire-and-forget trigger used by every terminal
 *       path;</li>
 *   <li>{@link #captureTerminalRuns} — startup sweep: terminal Runs without a
 *       checkpoint projection row (the slice model has no pre-dispatch row).</li>
 * </ul>
 *
 * <p>NOTE (PLAN-0339): the slice-table rebuild replaces this projection. Until
 * then the slice ref is stored in the legacy {@code end_ref} column and the
 * state vocabulary is {@code captured | abnormal-captured | degraded | expired}.</p>
 *
 * <p>Checkpoint lifecycle markers use the existing operation ledger
 * ({@code kind=checkpoint}, {@code source=runtime}); user-triggered revert
 * markers use {@code source=ui}. When the run has no durable operation the
 * marker is skipped with a lifecycle log — the ledger is never fabricated.</p>
 */
@Service
public class RunCheckpointService {

    private static final Logger logger = LoggerFactory.getLogger(RunCheckpointService.class);

    public static final String REASON_UNAVAILABLE = "UNAVAILABLE";

    /** PLAN-0328 M3: projection state for a run without a checkpoint row. */
    public static final String STATE_NONE = "none";

    /** Frozen reason vocabulary for {@code 409 CHECKPOINT_NOT_AVAILABLE}. */
    public static final String REASON_MISSING = "MISSING";
    public static final String REASON_EXPIRED = "EXPIRED";
    public static final String REASON_NOT_SEALED = "NOT_SEALED";
    public static final String REASON_DEGRADED = "DEGRADED";
    public static final String REASON_INVALID_REQUEST = "INVALID_REQUEST";
    public static final String REASON_TOO_LARGE = "TOO_LARGE";

    /** Retention constants (decision #10): newest N runs + TTL days per workspace. */
    public static final int RETENTION_MAX_RUNS = 50;
    public static final int RETENTION_TTL_DAYS = 30;

    /** Changed-file projection cap of the public checkpoint view. */
    static final int MAX_VIEW_FILES = 20;
    /** Suspect entries kept in the revert summary/ledger item. */
    static final int MAX_SUMMARY_SUSPECTS = 20;
    /** PLAN-0338: startup compensation batch bound per boot. */
    static final int MAX_SWEEP_RUNS = 100;

    static final String LEDGER_KIND = "checkpoint";
    static final String LEDGER_TOOL_NAME = "run_checkpoint";
    static final String LEDGER_TOOL_NAME_REVERT = "revert_checkpoint";
    static final String LEDGER_SOURCE = "runtime";
    static final String LEDGER_SOURCE_UI = "ui";

    /** SSE event announcing checkpoint lifecycle changes on the session channel. */
    static final String SSE_EVENT_RUN_CHECKPOINT = "run_checkpoint";

    /** ChatRun terminal statuses (mirrors {@code ChatController} terminal transitions). */
    private static final List<String> TERMINAL_RUN_STATUSES = List.of(
            "succeeded", "failed", "partial", "ambiguous", "cancelled");

    /** PLAN-0338: a terminal Run counts as abnormal unless it succeeded or was cancelled. */
    private static final List<String> NORMAL_RUN_STATUSES = List.of("succeeded", "cancelled");

    private final RunCheckpointRepository checkpoints;
    private final RuntimeCheckpointClient runtime;
    private final OperationService operationService;
    private final ChatRunRepository chatRuns;
    private final ObjectMapper objectMapper;
    private final SseEmitterManager sseManager;
    private final AtomicLong captureSequence = new AtomicLong();
    private final java.util.Set<String> captureInFlight = ConcurrentHashMap.newKeySet();
    private final ExecutorService captureExecutor;

    public RunCheckpointService(RunCheckpointRepository checkpoints,
                                RuntimeCheckpointClient runtime,
                                OperationService operationService,
                                ChatRunRepository chatRuns,
                                ObjectMapper objectMapper,
                                SseEmitterManager sseManager) {
        this.checkpoints = checkpoints;
        this.runtime = runtime;
        this.operationService = operationService;
        this.chatRuns = chatRuns;
        this.objectMapper = objectMapper;
        this.sseManager = sseManager;
        this.captureExecutor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "xihe-checkpoint-capture-" + captureSequence.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        });
    }

    @PreDestroy
    public void shutdown() {
        captureExecutor.shutdownNow();
    }

    /** Fire-and-forget capture used by terminal transitions; never throws or blocks them. */
    public void requestCapture(String runId) {
        if (isBlank(runId)) {
            return;
        }
        try {
            captureExecutor.execute(() -> captureCheckpoint(runId));
        } catch (RejectedExecutionException e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_capture_rejected runId={}", runId);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_capture_request_failed runId={} failureType={}",
                    runId, e.getClass().getName());
        }
    }

    /**
     * Captures one Run into a slice exactly once (idempotent per run: an already
     * captured row is left untouched). A failed capture records a {@code degraded}
     * row with the frozen reason and returns {@code false} — callers must never
     * fail their own Run transition because of it.
     */
    public boolean captureCheckpoint(String runId) {
        if (isBlank(runId)) {
            return false;
        }
        if (!captureInFlight.add(runId)) {
            logger.info("[LIFECYCLE] service=cp event=run_checkpoint_capture_skipped runId={} reason=in_flight",
                    runId);
            return false;
        }
        try {
            ChatRun run = findRun(runId);
            if (run == null) {
                logger.info("[LIFECYCLE] service=cp event=run_checkpoint_capture_skipped runId={} reason=run_missing",
                        runId);
                return false;
            }
            String workspaceId = run.getWorkspaceId();
            RunCheckpoint existing = findRow(runId, workspaceId);
            if (existing != null && isCapturedState(existing.getState())) {
                logger.debug("[LIFECYCLE] service=cp event=run_checkpoint_capture_exists runId={} workspaceId={}",
                        runId, workspaceId);
                return false;
            }
            boolean abnormal = isAbnormalStatus(run.getStatus());
            RuntimeCheckpointClient.CaptureResult result = runtime.capture(workspaceId, runId,
                    run.getUserId(), captureCallId(runId), abnormal);
            return switch (result.outcome()) {
                case OK -> {
                    persistCaptured(runId, workspaceId, result, abnormal);
                    yield true;
                }
                case INVALID_REQUEST -> {
                    persistDegraded(runId, workspaceId, REASON_INVALID_REQUEST, result.reason());
                    yield false;
                }
                default -> {
                    persistDegraded(runId, workspaceId, REASON_UNAVAILABLE, result.reason());
                    yield false;
                }
            };
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_capture_failed runId={} failureType={}",
                    runId, e.getClass().getName());
            return false;
        } finally {
            captureInFlight.remove(runId);
        }
    }

    /**
     * Startup sweep (PLAN-0338 slice model): capture terminal Runs that have no
     * checkpoint projection row at all — a CP crash before the terminal capture
     * (or an upgrade from the interval model where no row was ever written).
     * Bounded to {@link #MAX_SWEEP_RUNS} rows per boot; each capture is
     * idempotent, so repeating the sweep is safe. Returns the number of rows
     * captured in this pass.
     */
    public int captureTerminalRuns() {
        List<ChatRun> runs;
        try {
            runs = chatRuns.findTerminalRunsWithoutCheckpoint(TERMINAL_RUN_STATUSES,
                    PageRequest.of(0, MAX_SWEEP_RUNS));
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_sweep_failed failureType={}",
                    e.getClass().getName());
            return 0;
        }
        int captured = 0;
        for (ChatRun run : runs) {
            if (captureCheckpoint(run.getId().toString())) {
                captured++;
            }
        }
        if (captured > 0) {
            logger.info("[LIFECYCLE] service=cp event=run_checkpoint_sweep_completed captured={}", captured);
        }
        return captured;
    }

    // ── PLAN-0328 M3 W2: public checkpoint surface (view / revert / file / git) ──

    /** Service-level gate verdict; the controller maps each value to one HTTP shape. */
    public enum Gate {
        OK,
        /** 409 CHECKPOINT_NOT_SEALED (legacy Runtime code) — the slice ref does not exist. */
        NOT_SEALED,
        /** 409 CHECKPOINT_NOT_AVAILABLE {reason} — missing/expired/degraded row. */
        NOT_AVAILABLE,
        /** 409 CHECKPOINT_TYPE_CHANGES_UNACKNOWLEDGED — type changes not acknowledged. */
        TYPE_CHANGES_UNACKNOWLEDGED,
        /** 409 CHECKPOINT_RESTORE_LOCKED — another restore holds the workspace restore lock. */
        RESTORE_LOCKED,
        /** 400 CHECKPOINT_INVALID_REQUEST — malformed blob request. */
        INVALID_REQUEST,
        /** 413 CHECKPOINT_BLOB_TOO_LARGE — preview cap exceeded. */
        TOO_LARGE,
        /** 404 CHECKPOINT_NOT_FOUND — the path is absent from the slice tree. */
        FILE_NOT_FOUND,
        /** 503 CHECKPOINT_UNAVAILABLE {reason} — Runtime slice refs unreachable. */
        UNAVAILABLE
    }

    /** Revert projection of the checkpoint view ({state,at,counts,ref}). */
    public record RevertView(String state, Instant at, Map<String, Object> counts, String ref) {}

    /** Public GET projection; {@code state=none} when the run has no row. */
    public record View(String state, String unrollableReason, int changedCount,
                       List<RuntimeCheckpointClient.ChangedFile> changedFiles, Instant sealedAt,
                       RevertView revert) {}

    public record PreviewOutcome(Gate gate, String reason, RuntimeCheckpointClient.RevertPreview preview,
                                 Map<String, Object> details) {}

    public record RevertOutcome(Gate gate, String reason, RuntimeCheckpointClient.RevertResult result,
                                Map<String, Object> details) {}

    public record FileOutcome(Gate gate, String reason, String content, String path,
                              Map<String, Object> details) {}

    public record GitStatusOutcome(Gate gate, String reason, boolean isRepository,
                                   List<RuntimeCheckpointClient.GitStatusEntry> entries) {}

    public record GcOutcome(Gate gate, String reason, Map<String, Object> counts) {}

    /** Retention constants plus the workspace's current run/ref counts (read-only). */
    public record RetentionView(int maxRuns, int ttlDays, boolean unsealedNeverDeleted,
                                long currentRuns, long currentRefs) {}

    /** Read-only projection of the run's checkpoint row (no Runtime call). */
    public View view(String runId, String workspaceId) {
        RunCheckpoint row = findRow(runId, workspaceId);
        if (row == null) {
            return new View(STATE_NONE, null, 0, List.of(), null,
                    new RevertView(RunCheckpoint.REVERT_NONE, null, null, null));
        }
        List<RuntimeCheckpointClient.ChangedFile> changed = parseChangedFiles(row.getChangedFiles());
        List<RuntimeCheckpointClient.ChangedFile> capped = changed.size() > MAX_VIEW_FILES
                ? List.copyOf(changed.subList(0, MAX_VIEW_FILES))
                : changed;
        return new View(row.getState(), row.getUnrollableReason(), changed.size(), capped,
                row.getSealedAt(), revertView(row));
    }

    /**
     * Read-only revert dry-run against the row's slice ref. A Runtime 404 for a row
     * the CP still considers captured flips the row to {@code expired} once
     * (decision #74 first consumer) and answers
     * {@code 409 CHECKPOINT_NOT_AVAILABLE {reason=EXPIRED}}.
     */
    public PreviewOutcome previewRevert(String runId, String workspaceId) {
        RunCheckpoint row = findRow(runId, workspaceId);
        GateVerdict verdict = rowGate(row);
        if (verdict != null) {
            return new PreviewOutcome(verdict.gate(), verdict.reason(), null, Map.of());
        }
        RunCheckpoint capturedRow = Objects.requireNonNull(row);
        String sliceRef = capturedRow.getEndRef();
        if (isBlank(sliceRef)) {
            return new PreviewOutcome(Gate.NOT_AVAILABLE, REASON_MISSING, null, Map.of());
        }
        RuntimeCheckpointClient.RevertPreview preview = runtime.previewRevert(workspaceId, sliceRef);
        return switch (preview.outcome()) {
            case OK -> new PreviewOutcome(Gate.OK, null, preview, Map.of());
            case NOT_SEALED -> new PreviewOutcome(Gate.NOT_SEALED, REASON_NOT_SEALED, null, Map.of());
            case TYPE_CHANGES_UNACKNOWLEDGED -> new PreviewOutcome(Gate.TYPE_CHANGES_UNACKNOWLEDGED,
                    "TYPE_CHANGES_UNACKNOWLEDGED", null, Map.of());
            case RESTORE_LOCKED -> new PreviewOutcome(Gate.RESTORE_LOCKED, "RESTORE_LOCKED", null, Map.of());
            case UNAVAILABLE -> new PreviewOutcome(Gate.UNAVAILABLE,
                    valueOrDefault(preview.reason(), REASON_UNAVAILABLE), null, Map.of());
            case NOT_FOUND -> {
                expireCapturedRow(capturedRow);
                yield new PreviewOutcome(Gate.NOT_AVAILABLE, REASON_EXPIRED, null, Map.of());
            }
            default -> new PreviewOutcome(Gate.UNAVAILABLE, REASON_UNAVAILABLE, null, Map.of());
        };
    }

    /**
     * Executes the restore to the row's slice ref. On success/partial the CP
     * appends the revert ledger item and records
     * {@code revert_state}/{@code revert_ref}/{@code revert_summary}/
     * {@code reverted_at} plus the attempt counter under a captured-state guard;
     * bookkeeping is best-effort and never rewrites the Runtime's result.
     */
    public RevertOutcome revert(String runId, String workspaceId, List<String> acknowledgeTypeChanges) {
        RunCheckpoint row = findRow(runId, workspaceId);
        GateVerdict verdict = rowGate(row);
        if (verdict != null) {
            return new RevertOutcome(verdict.gate(), verdict.reason(), null, Map.of());
        }
        RunCheckpoint capturedRow = Objects.requireNonNull(row);
        String sliceRef = capturedRow.getEndRef();
        if (isBlank(sliceRef)) {
            return new RevertOutcome(Gate.NOT_AVAILABLE, REASON_MISSING, null, Map.of());
        }
        RuntimeCheckpointClient.RevertResult result =
                runtime.revert(workspaceId, sliceRef, acknowledgeTypeChanges);
        return switch (result.outcome()) {
            case OK -> {
                recordRevert(capturedRow, result);
                yield new RevertOutcome(Gate.OK, null, result, Map.of());
            }
            case NOT_SEALED -> new RevertOutcome(Gate.NOT_SEALED, REASON_NOT_SEALED, null, Map.of());
            case TYPE_CHANGES_UNACKNOWLEDGED -> new RevertOutcome(Gate.TYPE_CHANGES_UNACKNOWLEDGED,
                    "TYPE_CHANGES_UNACKNOWLEDGED", null, Map.of());
            case RESTORE_LOCKED -> new RevertOutcome(Gate.RESTORE_LOCKED, "RESTORE_LOCKED", null, Map.of());
            case UNAVAILABLE -> new RevertOutcome(Gate.UNAVAILABLE,
                    valueOrDefault(result.reason(), REASON_UNAVAILABLE), null, Map.of());
            case NOT_FOUND -> {
                expireCapturedRow(capturedRow);
                yield new RevertOutcome(Gate.NOT_AVAILABLE, REASON_EXPIRED, null, Map.of());
            }
            default -> new RevertOutcome(Gate.UNAVAILABLE, REASON_UNAVAILABLE, null, Map.of());
        };
    }

    /**
     * Reads one plain-text file from the run's slice tree. A Runtime
     * {@code NOT_FOUND} is passed through unchanged (it may be a missing path
     * inside a healthy slice — never treated as expiry here).
     */
    public FileOutcome checkpointFile(String runId, String workspaceId, String path, String sliceRef) {
        RunCheckpoint row = findRow(runId, workspaceId);
        GateVerdict verdict = rowGate(row);
        if (verdict != null) {
            return new FileOutcome(verdict.gate(), verdict.reason(), null, null, Map.of());
        }
        RuntimeCheckpointClient.BlobResult blob = runtime.checkpointBlob(workspaceId, sliceRef, path);
        return switch (blob.outcome()) {
            case OK -> new FileOutcome(Gate.OK, null, blob.content(), blob.path(), Map.of());
            case INVALID_REQUEST -> new FileOutcome(Gate.INVALID_REQUEST, REASON_INVALID_REQUEST,
                    null, null, Map.of());
            case TOO_LARGE -> new FileOutcome(Gate.TOO_LARGE, REASON_TOO_LARGE, null, null,
                    problemDetails(blob.problem(), "path", "size", "max"));
            case NOT_SEALED -> new FileOutcome(Gate.NOT_SEALED, REASON_NOT_SEALED, null, null, Map.of());
            case NOT_FOUND -> new FileOutcome(Gate.FILE_NOT_FOUND, "FILE_NOT_FOUND", null, null, Map.of());
            case UNAVAILABLE -> new FileOutcome(Gate.UNAVAILABLE,
                    valueOrDefault(blob.reason(), REASON_UNAVAILABLE), null, null, Map.of());
            default -> new FileOutcome(Gate.UNAVAILABLE, REASON_UNAVAILABLE, null, null, Map.of());
        };
    }

    /** Read-only user-repository status (dual-diff "待提交" side). */
    public GitStatusOutcome gitStatus(String workspaceId) {
        RuntimeCheckpointClient.GitStatusResult result = runtime.workspaceGitStatus(workspaceId);
        return switch (result.outcome()) {
            case OK -> new GitStatusOutcome(Gate.OK, null, result.isRepository(), result.entries());
            case INVALID_REQUEST -> new GitStatusOutcome(Gate.INVALID_REQUEST,
                    REASON_INVALID_REQUEST, false, List.of());
            case UNAVAILABLE -> new GitStatusOutcome(Gate.UNAVAILABLE,
                    valueOrDefault(result.reason(), REASON_UNAVAILABLE), false, List.of());
            default -> new GitStatusOutcome(Gate.UNAVAILABLE, REASON_UNAVAILABLE, false, List.of());
        };
    }

    /** Retention constants plus current run/ref counts of one workspace. */
    public RetentionView retention(String workspaceId) {
        long runs = checkpoints.countByWorkspaceId(workspaceId);
        long refs = checkpoints.countBaseRefs(workspaceId) + checkpoints.countEndRefs(workspaceId);
        return new RetentionView(RETENTION_MAX_RUNS, RETENTION_TTL_DAYS, true, runs, refs);
    }

    /** Runs the Runtime retention sweep and returns its counts. */
    public GcOutcome gc(String workspaceId) {
        RuntimeCheckpointClient.GcResult result = runtime.gc(workspaceId);
        return switch (result.outcome()) {
            case OK -> new GcOutcome(Gate.OK, null, result.counts());
            case UNAVAILABLE -> new GcOutcome(Gate.UNAVAILABLE,
                    valueOrDefault(result.reason(), REASON_UNAVAILABLE), Map.of());
            default -> new GcOutcome(Gate.UNAVAILABLE, REASON_UNAVAILABLE, Map.of());
        };
    }

    /** Gate verdict for row-state dependent operations; null when the row is usable. */
    private GateVerdict rowGate(RunCheckpoint row) {
        if (row == null) {
            return new GateVerdict(Gate.NOT_AVAILABLE, REASON_MISSING);
        }
        if (RunCheckpoint.STATE_DEGRADED.equals(row.getState())) {
            return new GateVerdict(Gate.NOT_AVAILABLE,
                    valueOrDefault(row.getUnrollableReason(), REASON_DEGRADED));
        }
        if (RunCheckpoint.STATE_EXPIRED.equals(row.getState())) {
            return new GateVerdict(Gate.NOT_AVAILABLE, REASON_EXPIRED);
        }
        if (!isCapturedState(row.getState())) {
            return new GateVerdict(Gate.NOT_AVAILABLE, REASON_MISSING);
        }
        return null;
    }

    private record GateVerdict(Gate gate, String reason) {}

    /** Flips a captured row to expired exactly once (conditional update). */
    private void expireCapturedRow(RunCheckpoint row) {
        try {
            int updated = checkpoints.markExpired(row.getId(), Instant.now());
            if (updated > 0) {
                row.setState(RunCheckpoint.STATE_EXPIRED);
                logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_expired runId={} workspaceId={} "
                                + "reason=runtime_refs_missing",
                        row.getRunId(), row.getWorkspaceId());
            }
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_expire_failed runId={} failureType={}",
                    row.getRunId(), e.getClass().getName());
        }
    }

    /**
     * Revert bookkeeping: ledger item first, then the conditional row update. The
     * ledger item carries the frozen summary JSON (also persisted as
     * {@code revert_summary}); suspects are capped at {@link #MAX_SUMMARY_SUSPECTS}.
     */
    private void recordRevert(RunCheckpoint row, RuntimeCheckpointClient.RevertResult result) {
        RuntimeCheckpointClient.ExecuteCounts counts = result.counts();
        boolean clean = counts.failed() == 0;
        String revertState = clean ? RunCheckpoint.REVERT_ROLLED_BACK : RunCheckpoint.REVERT_PARTIAL;
        String reason = revertReason(counts);
        Instant now = Instant.now();
        String summary = buildRevertSummary(row, result, counts, reason);
        appendRevertLedger(row, summary);
        int updated = 0;
        try {
            updated = checkpoints.markReverted(row.getId(), revertState, result.sliceRef(), summary, now);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_revert_bookkeeping_failed runId={} "
                            + "failureType={}",
                    row.getRunId(), e.getClass().getName());
        }
        if (updated == 0) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_revert_bookkeeping_skipped runId={} "
                            + "revertState={} reason=state_changed",
                    row.getRunId(), revertState);
            return;
        }
        row.setRevertState(revertState);
        row.setRevertRef(result.sliceRef());
        row.setRevertSummary(summary);
        row.setRevertedAt(now);
        row.setRevertAttemptCount(row.getRevertAttemptCount() + 1);
        logger.info("[LIFECYCLE] service=cp event=run_checkpoint_reverted runId={} workspaceId={} "
                        + "revertState={} restored={} deleted={} failed={} attempt={}",
                row.getRunId(), row.getWorkspaceId(), revertState, counts.restored(), counts.deleted(),
                counts.failed(), row.getRevertAttemptCount());
        emitRunCheckpoint(row, revertView(row));
    }

    private String buildRevertSummary(RunCheckpoint row, RuntimeCheckpointClient.RevertResult result,
                                      RuntimeCheckpointClient.ExecuteCounts counts, String reason) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("marker", "revert");
        payload.put("checkpointId", row.getId().toString());
        payload.put("runId", row.getRunId());
        // PLAN-0338: the Runtime no longer writes a rollback audit ref; the
        // restored slice ref is recorded instead (until the PLAN-0339 rebuild).
        payload.put("sliceRef", result.sliceRef());
        Map<String, Object> countView = new LinkedHashMap<>();
        countView.put("restored", counts.restored());
        countView.put("deleted", counts.deleted());
        countView.put("failed", counts.failed());
        payload.put("counts", countView);
        List<String> suspects = new ArrayList<>();
        for (String suspect : result.suspects()) {
            if (suspects.size() >= MAX_SUMMARY_SUSPECTS) {
                break;
            }
            suspects.add(suspect);
        }
        payload.put("suspects", suspects);
        payload.put("allowedBy", "user_ui");
        payload.put("reason", reason);
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_revert_summary_failed checkpointId={}",
                    row.getId());
            return null;
        }
    }

    private void appendRevertLedger(RunCheckpoint row, String summary) {
        UUID operationId = null;
        try {
            operationId = operationService.findOperationIdByRunId(row.getRunId());
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_ledger_lookup_failed runId={} marker=revert",
                    row.getRunId());
        }
        if (operationId == null) {
            logger.info("[LIFECYCLE] service=cp event=run_checkpoint_ledger_skipped runId={} checkpointId={} "
                            + "marker=revert reason=operation_missing",
                    row.getRunId(), row.getId());
            return;
        }
        try {
            String toolCallId = UUID.nameUUIDFromBytes(("run-checkpoint:revert:" + row.getId() + ":"
                    + (row.getRevertAttemptCount() + 1)).getBytes(StandardCharsets.UTF_8)).toString();
            OperationItem item = operationService.appendItem(operationId, toolCallId, null, LEDGER_KIND,
                    LEDGER_TOOL_NAME_REVERT, LEDGER_SOURCE_UI, summary, null, null);
            if ("pending".equals(item.getStatus())) {
                operationService.transitionItem(item.getId(), "completed", null, null, summary, null);
            }
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_ledger_failed runId={} marker=revert "
                            + "failureType={}",
                    row.getRunId(), e.getClass().getName());
        }
    }

    private static String revertReason(RuntimeCheckpointClient.ExecuteCounts counts) {
        return counts.failed() > 0 ? "FAILED" : null;
    }

    private RevertView revertView(RunCheckpoint row) {
        Map<String, Object> summary = parseJsonObject(row.getRevertSummary());
        Map<String, Object> counts = summary.get("counts") instanceof Map<?, ?> rawCounts
                ? toObjectMap(rawCounts) : null;
        String ref = row.getRevertRef() != null ? row.getRevertRef() : asString(summary.get("sliceRef"));
        return new RevertView(
                valueOrDefault(row.getRevertState(), RunCheckpoint.REVERT_NONE),
                row.getRevertedAt(), counts, ref);
    }

    /**
     * Emits the {@code run_checkpoint} SSE on the run's session channel. Best-effort:
     * a missing emitter or a send failure never affects the lifecycle transition.
     */
    private void emitRunCheckpoint(RunCheckpoint row, RevertView revert) {
        try {
            String sessionId = sessionIdFor(row.getRunId());
            if (sessionId == null) {
                return;
            }
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("runId", row.getRunId());
            payload.put("sessionId", sessionId);
            payload.put("state", row.getState());
            payload.put("changedCount", parseChangedFiles(row.getChangedFiles()).size());
            if (row.getUnrollableReason() != null) {
                payload.put("unrollableReason", row.getUnrollableReason());
            }
            if (revert != null) {
                payload.put("revert", revertViewPayload(revert));
            }
            sseManager.send(sessionId, SSE_EVENT_RUN_CHECKPOINT, payload);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_sse_failed runId={} failureType={}",
                    row.getRunId(), e.getClass().getName());
        }
    }

    private static Map<String, Object> revertViewPayload(RevertView revert) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("state", revert.state());
        view.put("at", revert.at() == null ? null : revert.at().toString());
        view.put("counts", revert.counts());
        view.put("ref", revert.ref());
        return view;
    }

    private String sessionIdFor(String runId) {
        ChatRun run = findRun(runId);
        return run == null ? null : run.getSessionId();
    }

    private ChatRun findRun(String runId) {
        try {
            return chatRuns.findById(UUID.fromString(runId)).orElse(null);
        } catch (IllegalArgumentException e) {
            return null;
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_run_lookup_failed runId={} failureType={}",
                    runId, e.getClass().getName());
            return null;
        }
    }

    private RunCheckpoint findRow(String runId, String workspaceId) {
        if (isBlank(runId) || isBlank(workspaceId)) {
            return null;
        }
        return checkpoints.findByRunIdAndWorkspaceId(runId, workspaceId).orElse(null);
    }

    private static Map<String, Object> problemDetails(Map<String, Object> problem, String... keys) {
        if (problem == null || problem.isEmpty()) {
            return Map.of();
        }
        Map<String, Object> details = new LinkedHashMap<>();
        for (String key : keys) {
            Object value = problem.get(key);
            if (value != null) {
                details.put(key, value);
            }
        }
        return details;
    }

    private List<RuntimeCheckpointClient.ChangedFile> parseChangedFiles(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            List<Map<String, Object>> raw = objectMapper.readValue(json,
                    new TypeReference<List<Map<String, Object>>>() {});
            List<RuntimeCheckpointClient.ChangedFile> files = new ArrayList<>();
            for (Map<String, Object> entry : raw) {
                files.add(new RuntimeCheckpointClient.ChangedFile(
                        asString(entry.get("status")), asString(entry.get("path"))));
            }
            return List.copyOf(files);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_changed_files_unparsable");
            return List.of();
        }
    }

    private Map<String, Object> parseJsonObject(String json) {
        if (json == null || json.isBlank()) {
            return Map.of();
        }
        try {
            return objectMapper.readValue(json, new TypeReference<Map<String, Object>>() {});
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_summary_unparsable");
            return Map.of();
        }
    }

    private static Map<String, Object> toObjectMap(Map<?, ?> raw) {
        Map<String, Object> mapped = new LinkedHashMap<>();
        raw.forEach((key, value) -> mapped.put(String.valueOf(key), value));
        return mapped;
    }

    private static String asString(Object value) {
        return value instanceof String text && !text.isBlank() ? text : null;
    }

    private static String valueOrDefault(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }

    /** Persists the capture result into the projection row (insert or update). */
    private void persistCaptured(String runId, String workspaceId,
                                 RuntimeCheckpointClient.CaptureResult result, boolean abnormal) {
        Instant now = Instant.now();
        Instant capturedAt = parseInstant(result.capturedAt());
        String state = valueOrDefault(result.state(),
                abnormal ? RunCheckpoint.STATE_ABNORMAL_CAPTURED : RunCheckpoint.STATE_CAPTURED);
        RunCheckpoint row = findRow(runId, workspaceId);
        if (row == null) {
            row = new RunCheckpoint();
            row.setId(UUID.randomUUID());
            row.setRunId(runId);
            row.setWorkspaceId(workspaceId);
            row.setCreatedAt(now);
        }
        row.setState(state);
        // PLAN-0338: the slice ref lives in the legacy end_ref column until the
        // PLAN-0339 slice-table rebuild replaces this projection.
        row.setEndRef(result.sliceRef());
        row.setChangedFiles(serializeChangedFiles(result.changedFiles()));
        row.setUnrollableReason(null);
        row.setSealedWithLiveJobs(false);
        row.setSealedAfterAbnormal(abnormal);
        row.setSealedAt(capturedAt == null ? now : capturedAt);
        row.setUpdatedAt(now);
        try {
            checkpoints.save(row);
        } catch (DataIntegrityViolationException e) {
            logger.info("[LIFECYCLE] service=cp event=run_checkpoint_capture_raced runId={} workspaceId={}",
                    runId, workspaceId);
            return;
        }
        logger.info("[LIFECYCLE] service=cp event=run_checkpoint_captured runId={} workspaceId={} state={} "
                        + "noChange={} changedFiles={}",
                runId, workspaceId, state, result.noChange(), result.changedFiles().size());
        appendLedgerMarker(row, state);
        emitRunCheckpoint(row, null);
    }

    /** Records one failed capture as a degraded row; never overwrites a captured row. */
    private void persistDegraded(String runId, String workspaceId, String reason, String detail) {
        Instant now = Instant.now();
        RunCheckpoint row = findRow(runId, workspaceId);
        if (row != null && isCapturedState(row.getState())) {
            logger.info("[LIFECYCLE] service=cp event=run_checkpoint_degrade_skipped runId={} workspaceId={} "
                            + "reason=already_captured",
                    runId, workspaceId);
            return;
        }
        if (row == null) {
            row = new RunCheckpoint();
            row.setId(UUID.randomUUID());
            row.setRunId(runId);
            row.setWorkspaceId(workspaceId);
            row.setCreatedAt(now);
        }
        row.setState(RunCheckpoint.STATE_DEGRADED);
        row.setUnrollableReason(reason);
        row.setUpdatedAt(now);
        try {
            checkpoints.save(row);
        } catch (DataIntegrityViolationException e) {
            logger.info("[LIFECYCLE] service=cp event=run_checkpoint_capture_raced runId={} workspaceId={}",
                    runId, workspaceId);
            return;
        }
        logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_degraded runId={} workspaceId={} reason={} detail={}",
                runId, workspaceId, reason, detail);
        appendLedgerMarker(row, "degraded");
        emitRunCheckpoint(row, null);
    }

    private void appendLedgerMarker(RunCheckpoint row, String marker) {
        UUID operationId = null;
        try {
            operationId = operationService.findOperationIdByRunId(row.getRunId());
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_ledger_lookup_failed runId={} marker={}",
                    row.getRunId(), marker);
        }
        if (operationId == null) {
            logger.info("[LIFECYCLE] service=cp event=run_checkpoint_ledger_skipped runId={} checkpointId={} "
                            + "marker={} reason=operation_missing",
                    row.getRunId(), row.getId(), marker);
            return;
        }
        try {
            String toolCallId = UUID.nameUUIDFromBytes(
                    ("run-checkpoint:" + marker + ":" + row.getId()).getBytes(StandardCharsets.UTF_8)).toString();
            String preview = ledgerPreview(row, marker);
            OperationItem item = operationService.appendItem(operationId, toolCallId, null, LEDGER_KIND,
                    LEDGER_TOOL_NAME, LEDGER_SOURCE, preview, null, null);
            if ("pending".equals(item.getStatus())) {
                operationService.transitionItem(item.getId(), "completed", null, null, preview, null);
            }
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_ledger_failed runId={} marker={} failureType={}",
                    row.getRunId(), marker, e.getClass().getName());
        }
    }

    private String ledgerPreview(RunCheckpoint row, String marker) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("checkpointId", row.getId().toString());
        payload.put("marker", marker);
        payload.put("state", row.getState());
        payload.put("sliceRef", row.getEndRef());
        payload.put("unrollableReason", row.getUnrollableReason());
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_ledger_preview_failed checkpointId={}",
                    row.getId());
            return null;
        }
    }

    private String serializeChangedFiles(List<RuntimeCheckpointClient.ChangedFile> files) {
        if (files == null || files.isEmpty()) {
            return "[]";
        }
        List<Map<String, Object>> payload = new ArrayList<>();
        for (RuntimeCheckpointClient.ChangedFile file : files) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("status", file.status());
            entry.put("path", file.path());
            payload.add(entry);
        }
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_changed_files_unserializable");
            return "[]";
        }
    }

    private static boolean isCapturedState(String state) {
        return RunCheckpoint.STATE_CAPTURED.equals(state)
                || RunCheckpoint.STATE_ABNORMAL_CAPTURED.equals(state);
    }

    private static boolean isAbnormalStatus(String status) {
        return status == null || !NORMAL_RUN_STATUSES.contains(status);
    }

    private static String captureCallId(String runId) {
        return "run-terminal-capture:" + runId;
    }

    private static Instant parseInstant(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(value);
        } catch (java.time.format.DateTimeParseException e) {
            return null;
        }
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
