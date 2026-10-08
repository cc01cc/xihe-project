package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Workspace-scoped Job API（PLAN-0390 M2 / PLAN-0465 T2.1）。
 *
 * <p>Responses use domain {@code jobId} (`workspace_jobs.id`) as the only public
 * Job identity; `runtimeJobId` remains an internal Runtime backend handle.
 * Canonical job-output/cancel routes are
 * {@code GET/POST /api/v1/workspaces/{workspaceId}/jobs/{jobId}/…}；
 * legacy operation/item routes are retired by PLAN-0467.</p>
 */
@RestController
public class WorkspaceJobController {

    /** PLAN-0344 T1.2：续看分页缺省 64KiB / 上限 1MiB（与 Runtime JOB_CAP 一致）。 */
    private static final long DEFAULT_OUTPUT_LIMIT = 64 * 1024;
    private static final long MAX_OUTPUT_LIMIT = 1024 * 1024;

    private final JobStateService jobStateService;
    private final WorkspaceJobStartService workspaceJobStartService;
    private final WorkspaceService workspaceService;
    private final RuntimeJobClient runtimeJobClient;

    public WorkspaceJobController(JobStateService jobStateService,
                                  WorkspaceJobStartService workspaceJobStartService,
                                  WorkspaceService workspaceService,
                                  RuntimeJobClient runtimeJobClient) {
        this.jobStateService = jobStateService;
        this.workspaceJobStartService = workspaceJobStartService;
        this.workspaceService = workspaceService;
        this.runtimeJobClient = runtimeJobClient;
    }

    @GetMapping("/api/v1/workspaces/{workspaceId}/jobs")
    public ResponseEntity<?> list(@PathVariable String workspaceId) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication context is required");
        }
        try {
            workspaceService.requireAccessibleWorkspace(workspaceId, userId);
            List<Map<String, Object>> jobs = jobStateService.listView(workspaceId);
            return ResponseEntity.ok(jobs);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PostMapping("/api/v1/workspaces/{workspaceId}/jobs")
    public ResponseEntity<?> start(@PathVariable String workspaceId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody WorkspaceJobStartService.StartRequest request) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication context is required");
        }
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                    "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required to start a Workspace job");
        }
        try {
            WorkspaceJobStartService.StartOutcome outcome = workspaceJobStartService.start(
                    workspaceId, userId, request, idempotencyKey);
            if (outcome.replayed()) {
                return ResponseEntity.ok(outcome.job());
            }
            return ResponseEntity.accepted().body(outcome.job());
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage(),
                    e.getRequestId());
        }
    }

    /**
     * Read archived output for the canonical domain Job identity. Output source remains
     * the Runtime container files;
     * 归属按 domain jobId + workspace 双键校验。
     */
    @GetMapping("/api/v1/workspaces/{workspaceId}/jobs/{jobId}/output")
    public ResponseEntity<?> jobOutput(
            @PathVariable String workspaceId,
            @PathVariable String jobId,
            @RequestParam(name = "stream", required = false, defaultValue = "stdout") String stream,
            @RequestParam(name = "offset", required = false) Long offset,
            @RequestParam(name = "limit", required = false) Long limit) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication context is required");
        }
        if (!"stdout".equals(stream) && !"stderr".equals(stream)) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "stream must be stdout or stderr");
        }
        if (offset != null && offset < 0) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "offset must be >= 0");
        }
        long effectiveLimit = Math.min(Math.max(limit == null ? DEFAULT_OUTPUT_LIMIT : limit, 1L),
                MAX_OUTPUT_LIMIT);
        UUID domainJobId = parseJobId(jobId);
        if (domainJobId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "jobId must be a UUID");
        }
        try {
            workspaceService.requireAccessibleWorkspace(workspaceId, userId);
            JobStateService.JobArchive archive = jobStateService.findOwned(domainJobId, workspaceId)
                    .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "JOB_ARCHIVE_NOT_FOUND",
                            "No job archive for this job"));
            RuntimeJobClient.JobOutputResult result = runtimeJobClient.jobOutput(
                    archive.workspaceId(), archive.jobId(), stream, offset == null ? 0L : offset,
                    effectiveLimit);
            if (result.unreachable()) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", "Runtime job read failed");
            }
            if (result.errorCode() != null && result.statusCode() != 404) {
                return runtimeProblem(result.errorCode(), result.reason(), result.requestId(),
                        result.statusCode());
            }
            if (!result.available()) {
                // LOST = 容器销毁/job 失联（含 orphaned 收口）；
                // EXPIRED = 正常终态但文件已被 TTL 清理。
                boolean expired = archive.terminal() && !"orphaned".equals(archive.status());
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.CONFLICT,
                        expired ? "JOB_OUTPUT_EXPIRED" : "JOB_OUTPUT_LOST",
                        expired
                                ? "Job output has expired (cleaned after TTL)"
                                : "Job output is no longer available (container destroyed or job missing)");
            }
            JsonNode chunk = result.chunk();
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("jobId", domainJobId.toString());
            body.put("runtimeJobId", archive.jobId());
            body.put("stream", stream);
            body.put("offset", chunk.path("offset").asLong());
            body.put("nextOffset", chunk.path("nextOffset").asLong());
            body.put("sizeBytes", chunk.path("sizeBytes").asLong());
            body.put("truncated", chunk.path("truncated").asBoolean(false));
            body.put("data", chunk.path("data").asText(""));
            body.put("jobStatus", archive.status());
            return ResponseEntity.ok(body);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /**
     * Cancel one durable Workspace Job by canonical {@code jobId}. Its state
     * transition and history row are the sole durable cancellation record.
     */
    @PostMapping("/api/v1/workspaces/{workspaceId}/jobs/{jobId}/cancel")
    public ResponseEntity<?> cancelJob(@PathVariable String workspaceId, @PathVariable String jobId) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication context is required");
        }
        UUID domainJobId = parseJobId(jobId);
        if (domainJobId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "jobId must be a UUID");
        }
        try {
            workspaceService.requireAccessibleWorkspace(workspaceId, userId);
            JobStateService.JobArchive archive = jobStateService.findOwned(domainJobId, workspaceId)
                    .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "JOB_ARCHIVE_NOT_FOUND",
                            "No job archive for this job"));
            if (archive.terminal()) {
                // 已终态：不改写事实、不调 Runtime（幂等 200 + 原状态）。
                return ResponseEntity.ok(cancelBody(domainJobId, archive.status(), false));
            }
            RuntimeJobClient.JobCancelResult result =
                    runtimeJobClient.cancelJob(archive.workspaceId(), archive.jobId());
            if (!result.reachable()) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", "Runtime job cancel failed");
            }
            if (result.errorCode() != null && result.statusCode() != 404) {
                return runtimeProblem(result.errorCode(), result.reason(), result.requestId(),
                        result.statusCode());
            }
            if (!result.found()) {
                // Runtime 已无该 job：fail-closed 落 orphaned（不臆造已取消）。
                Map<String, Object> incoming = new LinkedHashMap<>();
                incoming.put("status", "orphaned");
                incoming.put("cancelReason", "job_missing");
                jobStateService.upsertById(domainJobId, incoming);
                return ResponseEntity.ok(cancelBody(domainJobId, "orphaned", true));
            }
            if ("failed".equals(result.status())) {
                // 四阶段后进程仍存活：终止未确认，不改档案。
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.BAD_GATEWAY, "JOB_CANCEL_UNCONFIRMED",
                        "Job termination was not confirmed");
            }
            Map<String, Object> incoming = new LinkedHashMap<>();
            incoming.put("status", "cancelled");
            incoming.put("cancelReason", "user_cancel");
            jobStateService.upsertById(domainJobId, incoming);
            return ResponseEntity.ok(cancelBody(domainJobId, "cancelled", true));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    private static Map<String, Object> cancelBody(UUID domainJobId, String status, boolean changed) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("jobId", domainJobId.toString());
        body.put("status", status);
        body.put("changed", changed);
        return body;
    }

    private static ResponseEntity<Map<String, Object>> runtimeProblem(
            String code, String reason, String requestId, int statusCode) {
        HttpStatus status = HttpStatus.resolve(statusCode);
        if (status == null || status.is2xxSuccessful()) {
            status = HttpStatus.BAD_GATEWAY;
        }
        return ProblemDetailsHandler.problemResponse(status, code == null ? "UNMAPPED_ERROR" : code,
                reason == null || reason.isBlank() ? "Runtime job request failed" : reason, requestId);
    }

    private static UUID parseJobId(String jobId) {
        if (jobId == null || jobId.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(jobId);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
