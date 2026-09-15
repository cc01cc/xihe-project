package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.RunCheckpoint;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.RunCheckpointRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeCheckpointClient;
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

    static final String LEDGER_KIND = "checkpoint";
    static final String LEDGER_TOOL_NAME = "run_checkpoint";
    static final String LEDGER_SOURCE = "runtime";

    /** ChatRun terminal statuses (mirrors {@code ChatController} terminal transitions). */
    private static final List<String> TERMINAL_RUN_STATUSES = List.of(
            "succeeded", "failed", "partial", "ambiguous", "cancelled");

    private final RunCheckpointRepository checkpoints;
    private final RuntimeCheckpointClient runtime;
    private final OperationService operationService;
    private final ChatRunRepository chatRuns;
    private final ObjectMapper objectMapper;
    private final AtomicLong sealSequence = new AtomicLong();
    private final java.util.Set<String> sealInFlight = ConcurrentHashMap.newKeySet();
    private final ExecutorService sealExecutor;

    public RunCheckpointService(RunCheckpointRepository checkpoints,
                                RuntimeCheckpointClient runtime,
                                OperationService operationService,
                                ChatRunRepository chatRuns,
                                ObjectMapper objectMapper) {
        this.checkpoints = checkpoints;
        this.runtime = runtime;
        this.operationService = operationService;
        this.chatRuns = chatRuns;
        this.objectMapper = objectMapper;
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
