package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
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

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Workspace-scoped checkpoint slice API. Revert is a user-facing operation and
 * is addressed only by a workspace plus an explicit slice ref.
 */
@RestController
public class RunCheckpointController {

    private static final Logger logger = LoggerFactory.getLogger(RunCheckpointController.class);

    private final RunCheckpointService checkpoints;
    private final WorkspaceService workspaces;

    public RunCheckpointController(RunCheckpointService checkpoints,
                                   WorkspaceService workspaces) {
        this.checkpoints = checkpoints;
        this.workspaces = workspaces;
    }

    // ── Workspace-scoped checkpoint slices ───────────────────────────────────

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/workspaces/{workspaceId}/checkpoints")
    public ResponseEntity<?> list(@PathVariable String workspaceId) {
        ResponseEntity<?> denied = requireWorkspaceAccess(workspaceId);
        if (denied != null) {
            return denied;
        }
        return ResponseEntity.ok(checkpoints.list(workspaceId));
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/workspaces/{workspaceId}/checkpoints/revert/preview")
    public ResponseEntity<?> previewRevert(@PathVariable String workspaceId,
                                           @RequestBody(required = false) Map<String, Object> request) {
        ResponseEntity<?> denied = requireWorkspaceAccess(workspaceId);
        if (denied != null) {
            return denied;
        }
        String sliceRef = requiredSliceRef(request, false);
        if (sliceRef == null) {
            return invalidRequest("sliceRef is required");
        }
        RunCheckpointService.PreviewOutcome outcome = checkpoints.previewRevert(workspaceId, sliceRef);
        if (outcome.gate() != Gate.OK) {
            return gateResponse(outcome.gate(), outcome.reason(), outcome.details());
        }
        RuntimeCheckpointClient.RevertPreview preview = outcome.preview();
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("sliceRef", preview.sliceRef());
        body.put("counts", preview.counts());
        body.put("entries", preview.entries());
        body.put("truncated", preview.truncated());
        return ResponseEntity.ok(body);
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/workspaces/{workspaceId}/checkpoints/revert")
    public ResponseEntity<?> revert(
            @PathVariable String workspaceId,
            @RequestBody(required = false) Map<String, Object> request) {
        ResponseEntity<?> denied = requireWorkspaceAccess(workspaceId);
        if (denied != null) {
            return denied;
        }
        String sliceRef = requiredSliceRef(request, true);
        if (sliceRef == null) {
            return invalidRequest("sliceRef is required");
        }
        Object rawAcknowledgements = request == null ? null : request.get("acknowledgeTypeChanges");
        if (!(rawAcknowledgements instanceof List<?>)) {
            return invalidRequest("acknowledgeTypeChanges is required and must be an array");
        }
        List<String> acknowledgeTypeChanges = stringList(rawAcknowledgements);
        if (rawAcknowledgements instanceof List<?> values && values.size() != acknowledgeTypeChanges.size()) {
            return invalidRequest("acknowledgeTypeChanges must contain only non-empty strings");
        }
        RunCheckpointService.RevertOutcome outcome = checkpoints.revert(
                workspaceId, sliceRef, acknowledgeTypeChanges);
        if (outcome.gate() != Gate.OK) {
            return gateResponse(outcome.gate(), outcome.reason(), outcome.details());
        }
        RuntimeCheckpointClient.RevertResult result = outcome.result();
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("sliceRef", result.sliceRef());
        body.put("counts", result.counts());
        body.put("entries", result.entries());
        body.put("durationMs", result.durationMs());
        body.put("suspects", result.suspects());
        logger.info("[LIFECYCLE] service=cp event=run_checkpoint_revert_completed workspaceId={} sliceRef={} "
                        + "restored={} "
                        + "deleted={} failed={}",
                workspaceId, sliceRef, result.counts().restored(), result.counts().deleted(),
                result.counts().failed());
        return ResponseEntity.ok(body);
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/workspaces/{workspaceId}/checkpoints/blob")
    public ResponseEntity<?> checkpointFile(
            @PathVariable String workspaceId,
            @RequestParam(name = "path") String path,
            @RequestParam(name = "sliceRef") String sliceRef) {
        ResponseEntity<?> denied = requireWorkspaceAccess(workspaceId);
        if (denied != null) {
            return denied;
        }
        RunCheckpointService.FileOutcome outcome = checkpoints.checkpointFile(workspaceId, path, sliceRef);
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

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/workspaces/{workspaceId}/checkpoints/cleanup")
    public ResponseEntity<?> cleanup(@PathVariable String workspaceId,
                                     @RequestBody(required = false) Map<String, Object> request) {
        ResponseEntity<?> denied = requireWorkspaceAccess(workspaceId);
        if (denied != null) {
            return denied;
        }
        if (request == null || request.size() != 1 || !Boolean.TRUE.equals(request.get("acknowledge"))) {
            return invalidRequest("acknowledge must be true to clear all checkpoint history");
        }
        RunCheckpointService.CleanupOutcome outcome = checkpoints.cleanup(workspaceId);
        if (outcome.gate() != Gate.OK) {
            return gateResponse(outcome.gate(), outcome.reason(), outcome.details());
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("removed", outcome.removed());
        return ResponseEntity.ok(body);
    }

    // ── Shared helpers ──────────────────────────────────────────────────────

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
        } catch (IllegalArgumentException e) {
            logger.warn("[SECURITY] service=cp event=workspace_access_invalid_id workspaceId={} failureType={}",
                    workspaceId, e.getClass().getName());
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND", "Workspace not found");
        }
    }

    private ResponseEntity<Map<String, Object>> invalidRequest(String detail) {
        return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                "CHECKPOINT_INVALID_REQUEST", detail);
    }

    private static String requiredSliceRef(Map<String, Object> request, boolean allowAcknowledgements) {
        if (request == null
                || request.keySet().stream().anyMatch(key -> !key.equals("sliceRef")
                && (!allowAcknowledgements || !key.equals("acknowledgeTypeChanges")))) {
            return null;
        }
        Object raw = request.get("sliceRef");
        return raw instanceof String value && !value.isBlank() ? value : null;
    }

    private ResponseEntity<Map<String, Object>> gateResponse(Gate gate, String reason,
                                                             Map<String, Object> details) {
        return switch (gate) {
            case NOT_AVAILABLE -> ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT,
                    "CHECKPOINT_NOT_AVAILABLE",
                    "Checkpoint slice is not available (" + reason + ")", details);
            case TYPE_CHANGES_UNACKNOWLEDGED -> ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT,
                    "CHECKPOINT_TYPE_CHANGES_UNACKNOWLEDGED",
                    "type-change paths must be acknowledged from the preview before reverting", details);
            case RESTORE_LOCKED -> ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT,
                    "CHECKPOINT_RESTORE_LOCKED",
                    "another restore is already running in this workspace", details);
            case INVALID_REQUEST -> ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                    "CHECKPOINT_INVALID_REQUEST", "Invalid checkpoint request", details);
            case TOO_LARGE -> ProblemDetailsHandler.problemResponse(HttpStatus.PAYLOAD_TOO_LARGE,
                    "CHECKPOINT_BLOB_TOO_LARGE", "file exceeds the checkpoint preview cap", details);
            case FILE_NOT_FOUND -> ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND,
                    "CHECKPOINT_NOT_FOUND", "the path is not present in the requested slice tree", details);
            case UNAVAILABLE -> ProblemDetailsHandler.problemResponse(HttpStatus.SERVICE_UNAVAILABLE,
                    "CHECKPOINT_UNAVAILABLE", "Checkpoint service is unavailable", details);
            case CLEANUP_BUSY -> ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT,
                    "CHECKPOINT_BUSY", "checkpoint capture or restore is in progress", details);
            case OK -> ProblemDetailsHandler.problemResponse(HttpStatus.INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR", "Unexpected checkpoint gate");
        };
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
}
