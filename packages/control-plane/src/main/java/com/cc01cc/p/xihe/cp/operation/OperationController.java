package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.LedgerOperation;
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
import org.springframework.web.bind.annotation.PostMapping;
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
            Page<LedgerOperation> result = operationService.listUserOperations(
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
            operationService.requireWorkspaceAccessibleItem(itemUuid, userId);
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

    /**
     * PLAN-0366 T1.3：Workspace access 成员直连取消单个 durable job（与 job-output 同键位）。
     *
     * <p>语义冻结（spec §二）：取消 job ≠ run 终态；已终态幂等 200 + `changed:false`；
     * 终止未确认 → 502 `JOB_CANCEL_UNCONFIRMED`（不改档案）；Runtime 404 → 档案落
     * `orphaned`（`cancelReason=job_missing`）；Runtime 不可达 → 502。带档案的每次
     * 调用写 `operation_events`（`job.cancel` / `actor=user`，决策 #14）。
     */
    @PostMapping("/items/{itemId}/cancel")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> cancelJob(@PathVariable String itemId) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication context is required");
        }
        UUID itemUuid;
        try {
            itemUuid = UUID.fromString(itemId);
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "itemId must be a UUID");
        }
        try {
            operationService.requireWorkspaceAccessibleItem(itemUuid, userId);
            JobStateService.JobArchive archive = jobStateService.find(itemUuid)
                    .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "JOB_ARCHIVE_NOT_FOUND",
                            "No job archive for this operation item"));
            if (archive.terminal()) {
                // 已终态：不改写事实、不调 Runtime（幂等 200 + 原状态）。
                operationService.recordJobCancel(itemId, archive.workspaceId(), archive.jobId(),
                        archive.status(), "rejected_terminal", false);
                return ResponseEntity.ok(cancelBody(itemId, archive.jobId(), archive.status(), false));
            }
            RuntimeJobClient.JobCancelResult result =
                    runtimeJobClient.cancelJob(archive.workspaceId(), archive.jobId());
            if (!result.reachable()) {
                operationService.recordJobCancel(itemId, archive.workspaceId(), archive.jobId(),
                        archive.status(), "unreachable", false);
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.BAD_GATEWAY, "RUNTIME_UNAVAILABLE", "Runtime job cancel failed");
            }
            if (!result.found()) {
                // Runtime 已无该 job（失联/容器重建）：fail-closed 落 orphaned（不臆造已取消）。
                Map<String, Object> incoming = new LinkedHashMap<>();
                incoming.put("status", "orphaned");
                incoming.put("cancelReason", "job_missing");
                jobStateService.upsert(itemUuid, incoming);
                operationService.recordJobCancel(itemId, archive.workspaceId(), archive.jobId(),
                        "orphaned", "orphaned", true);
                return ResponseEntity.ok(cancelBody(itemId, archive.jobId(), "orphaned", true));
            }
            if ("failed".equals(result.status())) {
                // 四阶段后进程仍存活：终止未确认，不改档案（job 可能仍在运行）。
                operationService.recordJobCancel(itemId, archive.workspaceId(), archive.jobId(),
                        archive.status(), "unconfirmed", false);
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.BAD_GATEWAY, "JOB_CANCEL_UNCONFIRMED",
                        "Job termination was not confirmed");
            }
            Map<String, Object> incoming = new LinkedHashMap<>();
            incoming.put("status", "cancelled");
            incoming.put("cancelReason", "user_cancel");
            jobStateService.upsert(itemUuid, incoming);
            operationService.recordJobCancel(itemId, archive.workspaceId(), archive.jobId(),
                    "cancelled", "cancelled", true);
            return ResponseEntity.ok(cancelBody(itemId, archive.jobId(), "cancelled", true));
        } catch (CpApiException e) {
            // spec 冻结：非归属/不存在一律 404 OPERATION_ITEM_NOT_FOUND（不泄露存在性）。
            // requireOwnedItem 对「item 存在但归属不符」抛出的是 OPERATION_NOT_FOUND，
            // 这里只收敛该码（JOB_ARCHIVE_NOT_FOUND 等保持原码）。
            if (HttpStatus.NOT_FOUND.equals(e.getStatus())
                    && "OPERATION_NOT_FOUND".equals(e.getCode())) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.NOT_FOUND, "OPERATION_ITEM_NOT_FOUND", "Operation item not found");
            }
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    private static Map<String, Object> cancelBody(String itemId, String jobId, String status,
                                                  boolean changed) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("itemId", itemId);
        body.put("jobId", jobId);
        body.put("status", status);
        body.put("changed", changed);
        return body;
    }

    static Map<String, Object> toSummary(LedgerOperation operation) {
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
