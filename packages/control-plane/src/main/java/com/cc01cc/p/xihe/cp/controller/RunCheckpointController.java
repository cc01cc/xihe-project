package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.runtime.RuntimeCheckpointClient;
import com.cc01cc.p.xihe.cp.service.RunCheckpointService;
import com.cc01cc.p.xihe.cp.service.RunCheckpointService.Gate;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0328 M3 W2: public Run-checkpoint surface.
 *
 * <p>Run-scoped routes ({@code /api/v1/chat/runs/{runId}/checkpoint...}) project the
 * CP {@code run_checkpoints} row and proxy the Runtime revert contract behind the
 * same ownership check as {@code ChatController} (404 RUN_NOT_FOUND / 403 FORBIDDEN).
 * Preview and execute additionally require a terminal Run (409 RUN_ACTIVE); revert
 * is only reachable by an authenticated UI user (decision #12), never by the Agent.
 * The projection and file routes stay available while a Run is active so the UI can
 * render the live checkpoint state.</p>
 *
 * <p>Workspace-scoped routes back the dual-diff "待提交" side and the retention
 * panel. Custom retention values are an explicit scope cut (decision #10 constants):
 * supervision is informational only, the sweep itself runs in the Runtime.</p>
 */
@RestController
public class RunCheckpointController {

    private static final Logger logger = LoggerFactory.getLogger(RunCheckpointController.class);

    /** Mirrors {@code ChatController} terminal statuses for the RUN_ACTIVE gate. */
    private static final List<String> TERMINAL_RUN_STATUSES = List.of(
            "succeeded", "failed", "partial", "ambiguous", "cancelled");

    private final ChatRunRepository chatRuns;
    private final RunCheckpointService checkpoints;
    private final WorkspaceService workspaces;

    public RunCheckpointController(ChatRunRepository chatRuns,
                                   RunCheckpointService checkpoints,
                                   WorkspaceService workspaces) {
        this.chatRuns = chatRuns;
        this.checkpoints = checkpoints;
        this.workspaces = workspaces;
    }

    // ── Run-scoped checkpoint projection and revert ──────────────────────────

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/chat/runs/{runId}/checkpoint")
    public ResponseEntity<?> getCheckpoint(@PathVariable String runId) {
        RunRef ref = resolveRun(runId);
        if (ref.error() != null) {
            return ref.error();
        }
        RunCheckpointService.View view = checkpoints.view(runId, ref.run().getWorkspaceId());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("runId", runId);
        body.put("state", view.state());
        body.put("unrollableReason", view.unrollableReason());
        body.put("changedCount", view.changedCount());
        body.put("changedFiles", view.changedFiles());
        body.put("sealedAt", timestamp(view.sealedAt()));
        body.put("revert", revertView(view.revert()));
        return ResponseEntity.ok(body);
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/chat/runs/{runId}/checkpoint/revert/preview")
    public ResponseEntity<?> previewRevert(@PathVariable String runId) {
        RunRef ref = resolveRun(runId);
        if (ref.error() != null) {
            return ref.error();
        }
        ResponseEntity<?> active = requireTerminalRun(ref.run());
        if (active != null) {
            return active;
        }
        RunCheckpointService.PreviewOutcome outcome =
                checkpoints.previewRevert(runId, ref.run().getWorkspaceId());
        if (outcome.gate() != Gate.OK) {
            return gateResponse(outcome.gate(), outcome.reason(), outcome.details());
        }
        RuntimeCheckpointClient.RevertPreview preview = outcome.preview();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("runId", preview.runId());
        body.put("state", preview.state());
        body.put("counts", preview.counts());
        body.put("entries", preview.entries());
        body.put("headFingerprint", preview.headFingerprint());
        body.put("sealedWithLiveJobs", preview.sealedWithLiveJobs());
        body.put("truncated", preview.truncated());
        return ResponseEntity.ok(body);
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/chat/runs/{runId}/checkpoint/revert")
    public ResponseEntity<?> revert(
            @PathVariable String runId,
            @RequestBody(required = false) Map<String, Object> request) {
        RunRef ref = resolveRun(runId);
        if (ref.error() != null) {
            return ref.error();
        }
        ResponseEntity<?> active = requireTerminalRun(ref.run());
        if (active != null) {
            return active;
        }
        List<String> acknowledgeConflicts = stringList(
                request == null ? null : request.get("acknowledgeConflicts"));
        boolean acknowledgeHeadChange = request != null
                && Boolean.TRUE.equals(request.get("acknowledgeHeadChange"));
        RunCheckpointService.RevertOutcome outcome = checkpoints.revert(
                runId, ref.run().getWorkspaceId(), acknowledgeConflicts, acknowledgeHeadChange);
        if (outcome.gate() != Gate.OK) {
            return gateResponse(outcome.gate(), outcome.reason(), outcome.details());
        }
        RuntimeCheckpointClient.RevertResult result = outcome.result();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("runId", result.runId());
        body.put("revertRef", result.revertRef());
        body.put("counts", result.counts());
        body.put("entries", result.entries());
        body.put("durationMs", result.durationMs());
        logger.info("[LIFECYCLE] service=cp event=run_checkpoint_revert_completed runId={} restored={} "
                        + "deleted={} skippedConflict={} failed={}",
                runId, result.counts().restored(), result.counts().deleted(),
                result.counts().skippedConflict(), result.counts().failed());
        return ResponseEntity.ok(body);
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/chat/runs/{runId}/checkpoint/file")
    public ResponseEntity<?> checkpointFile(
            @PathVariable String runId,
            @RequestParam(name = "path") String path,
            @RequestParam(name = "ref") String ref) {
        RunRef runRef = resolveRun(runId);
        if (runRef.error() != null) {
            return runRef.error();
        }
        RunCheckpointService.FileOutcome outcome =
                checkpoints.checkpointFile(runId, runRef.run().getWorkspaceId(), path, ref);
        if (outcome.gate() != Gate.OK) {
            return gateResponse(outcome.gate(), outcome.reason(), outcome.details());
        }
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("text/plain; charset=utf-8"))
                .body(outcome.content());
    }

    // ── Workspace-scoped git status, retention and sweep ─────────────────────

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/workspaces/{workspaceId}/git-status")
    public ResponseEntity<?> workspaceGitStatus(@PathVariable String workspaceId) {
        ResponseEntity<?> denied = requireWorkspaceAccess(workspaceId);
        if (denied != null) {
            return denied;
        }
        RunCheckpointService.GitStatusOutcome outcome = checkpoints.gitStatus(workspaceId);
        if (outcome.gate() != Gate.OK) {
            return gateResponse(outcome.gate(), outcome.reason(), Map.of());
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("isRepository", outcome.isRepository());
        body.put("entries", outcome.entries());
        return ResponseEntity.ok(body);
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/workspaces/{workspaceId}/checkpoints/retention")
    public ResponseEntity<?> retention(@PathVariable String workspaceId) {
        ResponseEntity<?> denied = requireWorkspaceAccess(workspaceId);
        if (denied != null) {
            return denied;
        }
        RunCheckpointService.RetentionView view = checkpoints.retention(workspaceId);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("maxRuns", view.maxRuns());
        body.put("ttlDays", view.ttlDays());
        body.put("unsealedNeverDeleted", view.unsealedNeverDeleted());
        body.put("currentRuns", view.currentRuns());
        body.put("currentRefs", view.currentRefs());
        return ResponseEntity.ok(body);
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/workspaces/{workspaceId}/checkpoints/gc")
    public ResponseEntity<?> gc(@PathVariable String workspaceId) {
        ResponseEntity<?> denied = requireWorkspaceAccess(workspaceId);
        if (denied != null) {
            return denied;
        }
        RunCheckpointService.GcOutcome outcome = checkpoints.gc(workspaceId);
        if (outcome.gate() != Gate.OK) {
            return gateResponse(outcome.gate(), outcome.reason(), Map.of());
        }
        return ResponseEntity.ok(Map.of("counts", outcome.counts()));
    }

    // ── Shared helpers ──────────────────────────────────────────────────────

    /** Ownership-checked run lookup; the error response is non-null when blocked. */
    private RunRef resolveRun(String runId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return new RunRef(null, ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required"));
        }
        UUID runUuid;
        try {
            runUuid = UUID.fromString(runId);
        } catch (IllegalArgumentException e) {
            return new RunRef(null, ProblemDetailsHandler.problemResponse(
                    HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found"));
        }
        ChatRun run = chatRuns.findById(runUuid).orElse(null);
        if (run == null) {
            return new RunRef(null, ProblemDetailsHandler.problemResponse(
                    HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found"));
        }
        if (!userId.equals(run.getUserId()) || !workspaceId.equals(run.getWorkspaceId())) {
            return new RunRef(null, ProblemDetailsHandler.problemResponse(
                    HttpStatus.FORBIDDEN, "FORBIDDEN",
                    "Chat run does not belong to current user/workspace"));
        }
        return new RunRef(run, null);
    }

    /** Revert entry gate: only a terminal Run may preview or execute a revert. */
    private ResponseEntity<Map<String, Object>> requireTerminalRun(ChatRun run) {
        if (TERMINAL_RUN_STATUSES.contains(run.getStatus())) {
            return null;
        }
        return ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT, "RUN_ACTIVE",
                "Run is still active: " + run.getStatus());
    }

    /** Workspace ownership gate; the error response is non-null when blocked. */
    private ResponseEntity<?> requireWorkspaceAccess(String workspaceId) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication required");
        }
        try {
            workspaces.requireAccessibleWorkspace(workspaceId, userId);
            return null;
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    private ResponseEntity<Map<String, Object>> gateResponse(Gate gate, String reason,
                                                             Map<String, Object> details) {
        return switch (gate) {
            case NOT_SEALED -> ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT,
                    "CHECKPOINT_NOT_SEALED", "Run checkpoint is not sealed", details);
            case NOT_AVAILABLE -> ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT,
                    "CHECKPOINT_NOT_AVAILABLE",
                    "Run checkpoint is not available (" + reason + ")", details);
            case LEASE_HELD -> ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT,
                    "CHECKPOINT_LEASE_HELD",
                    "another run holds the workspace mutation lease", details);
            case HEAD_CHANGED -> ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT,
                    "CHECKPOINT_HEAD_CHANGED",
                    "the workspace HEAD/branch fingerprint changed since the checkpoint base; "
                            + "acknowledge it to revert anyway", details);
            case CONFLICTS_UNACKNOWLEDGED -> ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT,
                    "CHECKPOINT_CONFLICTS_UNACKNOWLEDGED",
                    "conflict paths must be acknowledged from the preview before reverting", details);
            case INVALID_REQUEST -> ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                    "CHECKPOINT_INVALID_REQUEST", "Invalid checkpoint file request", details);
            case TOO_LARGE -> ProblemDetailsHandler.problemResponse(HttpStatus.PAYLOAD_TOO_LARGE,
                    "CHECKPOINT_BLOB_TOO_LARGE", "file exceeds the checkpoint preview cap", details);
            case FILE_NOT_FOUND -> ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND,
                    "CHECKPOINT_NOT_FOUND", "the path is not present in the requested base/end tree", details);
            case UNAVAILABLE -> ProblemDetailsHandler.problemResponse(HttpStatus.SERVICE_UNAVAILABLE,
                    "CHECKPOINT_UNAVAILABLE", "Run checkpoint is unavailable", details);
            case OK -> ProblemDetailsHandler.problemResponse(HttpStatus.INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR", "Unexpected checkpoint gate");
        };
    }

    private Map<String, Object> revertView(RunCheckpointService.RevertView revert) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("state", revert.state());
        view.put("at", timestamp(revert.at()));
        view.put("counts", revert.counts());
        view.put("ref", revert.ref());
        return view;
    }

    private static String timestamp(Instant instant) {
        return instant == null ? null : instant.toString();
    }

    private static List<String> stringList(Object raw) {
        if (!(raw instanceof List<?> list)) {
            return List.of();
        }
        List<String> values = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof String text && !text.isBlank()) {
                values.add(text);
            }
        }
        return List.copyOf(values);
    }

    private record RunRef(ChatRun run, ResponseEntity<Map<String, Object>> error) {}
}
