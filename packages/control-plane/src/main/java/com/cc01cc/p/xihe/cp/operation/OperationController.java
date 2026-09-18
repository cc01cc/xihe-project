package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.SessionOperation;
import com.cc01cc.p.xihe.cp.runtime.RuntimeJobClient;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * User-facing read-only Operation Ledger API (PLAN-281 task 1.3).
 * Ownership is derived from TenantContext, never from client input, and the
 * projection is redacted: no error_ref, result_ref or arguments_preview.
 */
@RestController
@RequestMapping("/api/v1/operations")
public class OperationController {

    private static final int MAX_PAGE_SIZE = 100;
    /** PLAN-0344 T1.2：续看分页缺省 64KiB、上限 1MiB（与 Runtime JOB_CAP 一致）。 */
    private static final long DEFAULT_OUTPUT_LIMIT = 64 * 1024;
    private static final long MAX_OUTPUT_LIMIT = 1024 * 1024;

    private final OperationService operationService;
    private final JobStateService jobStateService;
    private final RuntimeJobClient runtimeJobClient;

    public OperationController(OperationService operationService,
                               JobStateService jobStateService,
                               RuntimeJobClient runtimeJobClient) {
        this.operationService = operationService;
        this.jobStateService = jobStateService;
        this.runtimeJobClient = runtimeJobClient;
    }

    @GetMapping
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> list(
            @RequestParam(name = "sessionId", required = false) String sessionId,
            @RequestParam(name = "workspaceId", required = false) String workspaceId,
            @RequestParam(name = "status", required = false) String status,
            @RequestParam(name = "page", defaultValue = "0") int page,
            @RequestParam(name = "size", defaultValue = "50") int size) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication context is required");
        }
        try {
            int clampedSize = Math.min(Math.max(size, 1), MAX_PAGE_SIZE);
            Pageable pageable = PageRequest.of(Math.max(page, 0), clampedSize,
                    Sort.by(Sort.Direction.DESC, "createdAt"));
            Page<SessionOperation> result = operationService.listUserOperations(
                    userId, sessionId, workspaceId, status, pageable);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("operations", result.getContent().stream().map(OperationController::toSummary).toList());
            body.put("page", result.getNumber());
            body.put("size", result.getSize());
            body.put("totalElements", result.getTotalElements());
            body.put("totalPages", result.getTotalPages());
            return ResponseEntity.ok(body);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @GetMapping("/{operationId}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> get(@PathVariable String operationId) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication context is required");
        }
        UUID id;
        try {
            id = UUID.fromString(operationId);
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "operationId must be a UUID");
        }
        try {
            operationService.requireOwnedOperation(id, userId);
            Map<String, Object> trace = operationService.getOperationTrace(id);
            return ResponseEntity.ok(OperationViews.toUserTrace(trace));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /**
     * PLAN-0344 T1.2：durable job 输出续看（字节游标分页）。
     * 输出真源在容器文件；此处按 item 归属校验后经 Runtime 代理读取。
     * 不可读时显式区分：job 仍有 running 档案 → {@code JOB_OUTPUT_LOST}；
     * 已有终态但文件被 TTL 清理 → {@code JOB_OUTPUT_EXPIRED}（fail-visible）。
     */
    @GetMapping("/items/{itemId}/job-output")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> jobOutput(
            @PathVariable String itemId,
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
        UUID itemUuid;
        try {
            itemUuid = UUID.fromString(itemId);
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "itemId must be a UUID");
        }
        try {
            operationService.requireOwnedItem(itemUuid, userId);
            JobStateService.JobArchive archive = jobStateService.find(itemUuid)
                    .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "JOB_ARCHIVE_NOT_FOUND",
                            "No job archive for this operation item"));
            RuntimeJobClient.JobOutputResult result = runtimeJobClient.jobOutput(
                    archive.workspaceId(), archive.jobId(), stream, offset == null ? 0L : offset,
                    effectiveLimit);
            if (result.unreachable()) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", "Runtime job read failed");
            }
            if (!result.available()) {
                // PLAN-0344：LOST = 容器销毁/job 失联（含 orphaned 收口）；
                // EXPIRED = 正常终态（succeeded/cancelled/timeout）但文件已被 TTL 清理。
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
            body.put("jobId", archive.jobId());
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

    static Map<String, Object> toSummary(SessionOperation operation) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", operation.getId().toString());
        view.put("sessionId", operation.getSessionId());
        view.put("workspaceId", operation.getWorkspaceId());
        view.put("runId", operation.getRunId());
        view.put("kind", operation.getKind());
        view.put("source", operation.getSource());
        view.put("actorType", operation.getActorType());
        view.put("status", operation.getStatus());
        view.put("summary", operation.getSummary());
        view.put("errorCode", operation.getErrorCode());
        view.put("startedAt", operation.getStartedAt() == null ? null : operation.getStartedAt().toString());
        view.put("finishedAt", operation.getFinishedAt() == null ? null : operation.getFinishedAt().toString());
        view.put("createdAt", operation.getCreatedAt() == null ? null : operation.getCreatedAt().toString());
        return view;
    }
}
