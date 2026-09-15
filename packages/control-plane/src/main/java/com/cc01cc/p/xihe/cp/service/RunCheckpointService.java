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
 * PLAN-0328 M2 W3: Run checkpoint lifecycle on the CP side.
 *
 * <p>The Runtime owns the checkpoint refs; this service keeps the durable CP
 * projection and wires it to the chat Run lifecycle:</p>
 * <ul>
 *   <li>{@link #ensureCheckpoint} — before the first mutation-capable dispatch of a
 *       run (idempotent per run; degrades to {@code degraded} + {@code unrollableReason}
 *       instead of blocking the call);</li>
 *   <li>{@link #requestSeal} — fired (asynchronously) by every terminal path; a
 *       failed seal never fails the terminal transition and leaves the row in
 *       {@code base} for the Runtime sweep / next startup reconcile;</li>
 *   <li>{@link #sealTerminalCheckpoints} — startup sweep: runs already terminal
 *       without a sealed checkpoint (spec §3.1 "base 存在而 end 缺失").</li>
 * </ul>
 *
 * <p>Ledger markers use the existing operation ledger ({@code kind=checkpoint},
 * {@code source=runtime}); when the run has no durable operation the marker is
 * skipped with a lifecycle log — the ledger is never fabricated.</p>
 */
@Service
public class RunCheckpointService {

    private static final Logger logger = LoggerFactory.getLogger(RunCheckpointService.class);

    public static final String REASON_LEASE_HELD = "LEASE_HELD";
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
    /** Conflict entries kept in the revert summary/ledger item. */
    static final int MAX_SUMMARY_CONFLICTS = 20;

    static final String LEDGER_KIND = "checkpoint";
    static final String LEDGER_TOOL_NAME = "run_checkpoint";
    static final String LEDGER_TOOL_NAME_REVERT = "revert_snapshot";
    static final String LEDGER_SOURCE = "runtime";
    static final String LEDGER_SOURCE_CP = "cp";

    /** SSE event announcing checkpoint lifecycle changes on the session channel. */
    static final String SSE_EVENT_RUN_CHECKPOINT = "run_checkpoint";

    /** ChatRun terminal statuses (mirrors {@code ChatController} terminal transitions). */
    private static final List<String> TERMINAL_RUN_STATUSES = List.of(
            "succeeded", "failed", "partial", "ambiguous", "cancelled");

    private final RunCheckpointRepository checkpoints;
    private final RuntimeCheckpointClient runtime;
    private final OperationService operationService;
    private final ChatRunRepository chatRuns;
    private final ObjectMapper objectMapper;
    private final SseEmitterManager sseManager;
    private final AtomicLong sealSequence = new AtomicLong();
    private final java.util.Set<String> sealInFlight = ConcurrentHashMap.newKeySet();
    private final ExecutorService sealExecutor;

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
        this.sealExecutor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "xihe-checkpoint-seal-" + sealSequence.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        });
    }

    @PreDestroy
    public void shutdown() {
        sealExecutor.shutdownNow();
    }

    /**
     * Idempotent per run: an existing row for {@code (runId, workspaceId)} is left
     * untouched. A failed establishment records a {@code degraded} row with the
     * frozen reason ({@code LEASE_HELD} / {@code UNAVAILABLE}) and returns — the
     * caller continues dispatching (frozen non-strict default).
     */
    public void ensureCheckpoint(String runId, String workspaceId, String actor, String callId) {
        if (isBlank(runId) || isBlank(workspaceId)) {
            return;
        }
        try {
            if (checkpoints.findByRunIdAndWorkspaceId(runId, workspaceId).isPresent()) {
                logger.debug("[LIFECYCLE] service=cp event=run_checkpoint_exists runId={} workspaceId={}",
                        runId, workspaceId);
                return;
            }
            RuntimeCheckpointClient.CreateResult result = runtime.create(workspaceId, runId, actor, callId);
            switch (result.outcome()) {
                case OK -> persistBase(runId, workspaceId, result);
                case LEASE_HELD -> persistDegraded(runId, workspaceId, REASON_LEASE_HELD, result.reason());
                case UNAVAILABLE -> persistDegraded(runId, workspaceId, REASON_UNAVAILABLE, result.reason());
                case TRANSPORT -> persistDegraded(runId, workspaceId, REASON_UNAVAILABLE, result.reason());
                case NOT_FOUND -> persistDegraded(runId, workspaceId, REASON_UNAVAILABLE, result.reason());
            }
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_ensure_failed runId={} workspaceId={} failureType={}",
                    runId, workspaceId, e.getClass().getName());
        }
    }

    /** Fire-and-forget seal used by terminal transitions; never throws or blocks them. */
    public void requestSeal(String runId) {
        if (isBlank(runId)) {
            return;
        }
        try {
            sealExecutor.execute(() -> sealCheckpoint(runId));
        } catch (RejectedExecutionException e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_seal_rejected runId={}", runId);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_seal_request_failed runId={} failureType={}",
                    runId, e.getClass().getName());
        }
    }

    /**
     * Synchronous idempotent seal of every {@code base} row of the run. Failures
     * leave the row in {@code base} (Runtime sweep / next startup retries) and are
     * reported as {@code false} — callers must not fail their own transition.
     */
    public boolean sealCheckpoint(String runId) {
        if (isBlank(runId)) {
            return false;
        }
        if (!sealInFlight.add(runId)) {
            logger.info("[LIFECYCLE] service=cp event=run_checkpoint_seal_skipped runId={} reason=in_flight",
                    runId);
            return false;
        }
        try {
            boolean sealed = false;
            for (RunCheckpoint row : checkpoints.findByRunId(runId)) {
                if (!RunCheckpoint.STATE_BASE.equals(row.getState())) {
                    continue;
                }
                if (sealOne(row)) {
                    sealed = true;
                }
            }
            return sealed;
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_seal_failed runId={} failureType={}",
                    runId, e.getClass().getName());
            return false;
        } finally {
            sealInFlight.remove(runId);
        }
    }

    /**
     * Startup sweep (spec §3.1 补 seal): seal {@code base} rows whose run already
     * reached a terminal status. Returns the number of rows sealed in this pass;
     * each seal is idempotent, so repeating the sweep is safe.
     */
    public int sealTerminalCheckpoints() {
        int sealed = 0;
        for (RunCheckpoint row : checkpoints.findByState(RunCheckpoint.STATE_BASE)) {
            try {
                if (isRunTerminal(row.getRunId()) && sealCheckpoint(row.getRunId())) {
                    sealed++;
                }
            } catch (Exception e) {
                logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_sweep_failed runId={} failureType={}",
                        row.getRunId(), e.getClass().getName());
            }
        }
        if (sealed > 0) {
            logger.info("[LIFECYCLE] service=cp event=run_checkpoint_sweep_completed sealed={}", sealed);
        }
        return sealed;
    }

    // ── PLAN-0328 M3 W2: public checkpoint surface (view / revert / file / git) ──

    /** Service-level gate verdict; the controller maps each value to one HTTP shape. */
    public enum Gate {
        OK,
        /** 409 CHECKPOINT_NOT_SEALED (Runtime code) — the end ref does not exist. */
        NOT_SEALED,
        /** 409 CHECKPOINT_NOT_AVAILABLE {reason} — missing/expired/degraded row. */
        NOT_AVAILABLE,
        /** 409 CHECKPOINT_LEASE_HELD — a live run holds the workspace mutation lease. */
        LEASE_HELD,
        /** 409 CHECKPOINT_HEAD_CHANGED — user HEAD/branch moved since the base. */
        HEAD_CHANGED,
        /** 409 CHECKPOINT_CONFLICTS_UNACKNOWLEDGED — preview conflicts not acknowledged. */
        CONFLICTS_UNACKNOWLEDGED,
        /** 400 CHECKPOINT_INVALID_REQUEST — malformed blob request. */
        INVALID_REQUEST,
        /** 413 CHECKPOINT_BLOB_TOO_LARGE — preview cap exceeded. */
        TOO_LARGE,
        /** 404 CHECKPOINT_NOT_FOUND — the path is absent from the base/end tree. */
        FILE_NOT_FOUND,
        /** 503 CHECKPOINT_UNAVAILABLE {reason} — Runtime refs unreachable. */
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
     * Read-only revert dry-run. A Runtime 404 for a row the CP still considers
     * sealed flips the row to {@code expired} once (decision #74 first consumer)
     * and answers {@code 409 CHECKPOINT_NOT_AVAILABLE {reason=EXPIRED}}.
     */
    public PreviewOutcome previewRevert(String runId, String workspaceId) {
        RunCheckpoint row = findRow(runId, workspaceId);
        GateVerdict verdict = rowGate(row);
        if (verdict != null) {
            return new PreviewOutcome(verdict.gate(), verdict.reason(), null, Map.of());
        }
        RunCheckpoint sealedRow = Objects.requireNonNull(row);
        RuntimeCheckpointClient.RevertPreview preview = runtime.previewRevert(workspaceId, runId);
        return switch (preview.outcome()) {
            case OK -> new PreviewOutcome(Gate.OK, null, preview, Map.of());
            case NOT_SEALED -> new PreviewOutcome(Gate.NOT_SEALED, REASON_NOT_SEALED, null, Map.of());
            case LEASE_HELD -> new PreviewOutcome(Gate.LEASE_HELD, REASON_LEASE_HELD, null,
                    problemDetails(preview.problem(), "heldByRunId", "expiresAtMs"));
            case HEAD_CHANGED -> new PreviewOutcome(Gate.HEAD_CHANGED, "HEAD_CHANGED", null,
                    problemDetails(preview.problem(), "recorded", "observed"));
            case CONFLICTS_UNACKNOWLEDGED -> new PreviewOutcome(Gate.CONFLICTS_UNACKNOWLEDGED,
                    "CONFLICTS_UNACKNOWLEDGED", null, problemDetails(preview.problem(), "paths"));
            case UNAVAILABLE -> new PreviewOutcome(Gate.UNAVAILABLE,
                    valueOrDefault(preview.reason(), REASON_UNAVAILABLE), null, Map.of());
            case NOT_FOUND -> {
                expireSealedRow(sealedRow);
                yield new PreviewOutcome(Gate.NOT_AVAILABLE, REASON_EXPIRED, null, Map.of());
            }
            default -> new PreviewOutcome(Gate.UNAVAILABLE, REASON_UNAVAILABLE, null, Map.of());
        };
    }

    /**
     * Executes the revert of one sealed run. On success/partial the CP appends the
     * revert ledger item and records {@code revert_state}/{@code revert_ref}/
     * {@code revert_summary}/{@code reverted_at} plus the attempt counter under a
     * {@code state='sealed'} guard; bookkeeping is best-effort and never rewrites
     * the Runtime's result.
     */
    public RevertOutcome revert(String runId, String workspaceId,
                                List<String> acknowledgeConflicts, boolean acknowledgeHeadChange) {
        RunCheckpoint row = findRow(runId, workspaceId);
        GateVerdict verdict = rowGate(row);
        if (verdict != null) {
            return new RevertOutcome(verdict.gate(), verdict.reason(), null, Map.of());
        }
        RunCheckpoint sealedRow = Objects.requireNonNull(row);
        RuntimeCheckpointClient.RevertResult result =
                runtime.revert(workspaceId, runId, acknowledgeConflicts, acknowledgeHeadChange);
        return switch (result.outcome()) {
            case OK -> {
                recordRevert(sealedRow, result);
                yield new RevertOutcome(Gate.OK, null, result, Map.of());
            }
            case NOT_SEALED -> new RevertOutcome(Gate.NOT_SEALED, REASON_NOT_SEALED, null, Map.of());
            case LEASE_HELD -> new RevertOutcome(Gate.LEASE_HELD, REASON_LEASE_HELD, null,
                    problemDetails(result.problem(), "heldByRunId", "expiresAtMs"));
            case HEAD_CHANGED -> new RevertOutcome(Gate.HEAD_CHANGED, "HEAD_CHANGED", null,
                    problemDetails(result.problem(), "recorded", "observed"));
            case CONFLICTS_UNACKNOWLEDGED -> new RevertOutcome(Gate.CONFLICTS_UNACKNOWLEDGED,
                    "CONFLICTS_UNACKNOWLEDGED", null, problemDetails(result.problem(), "paths"));
            case UNAVAILABLE -> new RevertOutcome(Gate.UNAVAILABLE,
                    valueOrDefault(result.reason(), REASON_UNAVAILABLE), null, Map.of());
            case NOT_FOUND -> {
                expireSealedRow(sealedRow);
                yield new RevertOutcome(Gate.NOT_AVAILABLE, REASON_EXPIRED, null, Map.of());
            }
            default -> new RevertOutcome(Gate.UNAVAILABLE, REASON_UNAVAILABLE, null, Map.of());
        };
    }

    /**
     * Reads one plain-text file from the run's {@code base|end} tree. A Runtime
     * {@code NOT_FOUND} is passed through unchanged (it may be a missing path
     * inside a healthy checkpoint — never treated as expiry here).
     */
    public FileOutcome checkpointFile(String runId, String workspaceId, String path, String ref) {
        RunCheckpoint row = findRow(runId, workspaceId);
        GateVerdict verdict = rowGate(row);
        if (verdict != null) {
            return new FileOutcome(verdict.gate(), verdict.reason(), null, null, Map.of());
        }
        RuntimeCheckpointClient.BlobResult blob = runtime.checkpointBlob(workspaceId, runId, ref, path);
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
        if (!RunCheckpoint.STATE_SEALED.equals(row.getState())) {
            return new GateVerdict(Gate.NOT_SEALED, REASON_NOT_SEALED);
        }
        return null;
    }

    private record GateVerdict(Gate gate, String reason) {}

    /** Flips a sealed row to expired exactly once (conditional update). */
    private void expireSealedRow(RunCheckpoint row) {
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
     * {@code revert_summary}); conflicts are capped at
     * {@link #MAX_SUMMARY_CONFLICTS}.
     */
    private void recordRevert(RunCheckpoint row, RuntimeCheckpointClient.RevertResult result) {
        RuntimeCheckpointClient.ExecuteCounts counts = result.counts();
        boolean clean = counts.failed() == 0 && counts.skippedConflict() == 0;
        String revertState = clean ? RunCheckpoint.REVERT_ROLLED_BACK : RunCheckpoint.REVERT_PARTIAL;
        String reason = revertReason(counts);
        Instant now = Instant.now();
        String summary = buildRevertSummary(row, result, counts, reason);
        appendRevertLedger(row, summary);
        int updated = 0;
        try {
            updated = checkpoints.markReverted(row.getId(), revertState, result.revertRef(), summary, now);
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
        row.setRevertRef(result.revertRef());
        row.setRevertSummary(summary);
        row.setRevertedAt(now);
        row.setRevertAttemptCount(row.getRevertAttemptCount() + 1);
        logger.info("[LIFECYCLE] service=cp event=run_checkpoint_reverted runId={} workspaceId={} "
                        + "revertState={} restored={} deleted={} skippedConflict={} failed={} attempt={}",
                row.getRunId(), row.getWorkspaceId(), revertState, counts.restored(), counts.deleted(),
                counts.skippedConflict(), counts.failed(), row.getRevertAttemptCount());
        emitRunCheckpoint(row, revertView(row));
    }

    private String buildRevertSummary(RunCheckpoint row, RuntimeCheckpointClient.RevertResult result,
                                      RuntimeCheckpointClient.ExecuteCounts counts, String reason) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("marker", "revert");
        payload.put("checkpointId", row.getId().toString());
        payload.put("runId", row.getRunId());
        payload.put("revertRef", result.revertRef());
        Map<String, Object> countView = new LinkedHashMap<>();
        countView.put("restored", counts.restored());
        countView.put("deleted", counts.deleted());
        countView.put("skippedConflict", counts.skippedConflict());
        countView.put("failed", counts.failed());
        countView.put("noop", counts.noop());
        payload.put("counts", countView);
        List<Map<String, Object>> conflicts = new ArrayList<>();
        for (RuntimeCheckpointClient.ExecuteEntry entry : result.entries()) {
            if (conflicts.size() >= MAX_SUMMARY_CONFLICTS) {
                break;
            }
            if ("skippedConflict".equals(entry.result())) {
                Map<String, Object> conflict = new LinkedHashMap<>();
                conflict.put("path", entry.path());
                conflict.put("reason", valueOrDefault(entry.reason(), "CONTENT_CHANGED"));
                conflicts.add(conflict);
            }
        }
        payload.put("conflicts", conflicts);
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
                    LEDGER_TOOL_NAME_REVERT, LEDGER_SOURCE_CP, summary, null, null);
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
        if (counts.failed() > 0 && counts.skippedConflict() > 0) {
            return "FAILED_AND_CONFLICTS";
        }
        if (counts.failed() > 0) {
            return "FAILED";
        }
        if (counts.skippedConflict() > 0) {
            return "CONFLICTS";
        }
        return null;
    }

    private RevertView revertView(RunCheckpoint row) {
        Map<String, Object> summary = parseJsonObject(row.getRevertSummary());
        Map<String, Object> counts = summary.get("counts") instanceof Map<?, ?> rawCounts
                ? toObjectMap(rawCounts) : null;
        String ref = row.getRevertRef() != null ? row.getRevertRef() : asString(summary.get("revertRef"));
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
        try {
            return chatRuns.findById(UUID.fromString(runId)).map(ChatRun::getSessionId).orElse(null);
        } catch (IllegalArgumentException e) {
            return null;
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_session_lookup_failed runId={} "
                            + "failureType={}",
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

    private boolean sealOne(RunCheckpoint row) {
        RuntimeCheckpointClient.SealResult result = runtime.seal(row.getWorkspaceId(), row.getRunId());
        if (result.outcome() != RuntimeCheckpointClient.Outcome.OK) {
            // Never fail the terminal transition; the Runtime sweep (or the next
            // startup reconcile) retries a base row without an end ref.
            logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_seal_deferred runId={} outcome={} reason={}",
                    row.getRunId(), result.outcome(), result.reason());
            return false;
        }
        String changedFiles = serializeChangedFiles(result.changedFiles());
        int updated = checkpoints.markSealed(row.getId(), result.endRef(), changedFiles,
                result.sealedWithLiveJobs(), result.sealedAfterAbnormal(), Instant.now());
        if (updated == 0) {
            logger.info("[LIFECYCLE] service=cp event=run_checkpoint_seal_skipped runId={} reason=state_changed",
                    row.getRunId());
            return false;
        }
        row.setState(RunCheckpoint.STATE_SEALED);
        row.setEndRef(result.endRef());
        row.setChangedFiles(changedFiles);
        row.setSealedWithLiveJobs(result.sealedWithLiveJobs());
        row.setSealedAfterAbnormal(result.sealedAfterAbnormal());
        logger.info("[LIFECYCLE] service=cp event=run_checkpoint_sealed runId={} workspaceId={} changedFiles={} "
                        + "sealedWithLiveJobs={} sealedAfterAbnormal={}",
                row.getRunId(), row.getWorkspaceId(), result.changedFiles().size(),
                result.sealedWithLiveJobs(), result.sealedAfterAbnormal());
        appendLedgerMarker(row, "seal");
        emitRunCheckpoint(row, null);
        return true;
    }

    private void persistBase(String runId, String workspaceId, RuntimeCheckpointClient.CreateResult result) {
        RunCheckpoint row = new RunCheckpoint();
        row.setId(checkpointId(result.checkpointId()));
        row.setRunId(runId);
        row.setWorkspaceId(workspaceId);
        row.setState(RunCheckpoint.STATE_BASE);
        row.setBaseRef(result.baseRef());
        Instant now = Instant.now();
        Instant runtimeCreatedAt = parseInstant(result.createdAt());
        row.setCreatedAt(runtimeCreatedAt == null ? now : runtimeCreatedAt);
        row.setUpdatedAt(now);
        try {
            checkpoints.save(row);
        } catch (DataIntegrityViolationException e) {
            logger.info("[LIFECYCLE] service=cp event=run_checkpoint_create_raced runId={} workspaceId={}",
                    runId, workspaceId);
            return;
        }
        logger.info("[LIFECYCLE] service=cp event=run_checkpoint_created runId={} workspaceId={} checkpointId={}",
                runId, workspaceId, row.getId());
        appendLedgerMarker(row, "base");
    }

    private void persistDegraded(String runId, String workspaceId, String reason, String detail) {
        RunCheckpoint row = new RunCheckpoint();
        row.setId(UUID.randomUUID());
        row.setRunId(runId);
        row.setWorkspaceId(workspaceId);
        row.setState(RunCheckpoint.STATE_DEGRADED);
        row.setUnrollableReason(reason);
        Instant now = Instant.now();
        row.setCreatedAt(now);
        row.setUpdatedAt(now);
        try {
            checkpoints.save(row);
        } catch (DataIntegrityViolationException e) {
            logger.info("[LIFECYCLE] service=cp event=run_checkpoint_create_raced runId={} workspaceId={}",
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
        payload.put("baseRef", row.getBaseRef());
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

    private boolean isRunTerminal(String runId) {
        try {
            return chatRuns.findById(UUID.fromString(runId))
                    .map(ChatRun::getStatus)
                    .map(TERMINAL_RUN_STATUSES::contains)
                    .orElse(false);
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    private static UUID checkpointId(String raw) {
        if (raw != null && !raw.isBlank()) {
            try {
                return UUID.fromString(raw);
            } catch (IllegalArgumentException e) {
                logger.warn("[LIFECYCLE] service=cp event=run_checkpoint_id_not_uuid");
            }
        }
        return UUID.randomUUID();
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
