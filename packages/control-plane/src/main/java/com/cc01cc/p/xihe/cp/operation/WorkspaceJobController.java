package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * Workspace-scoped durable Job API（PLAN-0390 M2）。
 *
 * <p>canonical identity 是 `operationItemId`；本 controller 只提供 Workspace 维度的
 * list/start projection，detail/output/cancel 继续复用 `operationItemId` 的既有入口。
 */
@RestController
public class WorkspaceJobController {

    private final OperationService operationService;
    private final WorkspaceJobStartService workspaceJobStartService;
    private final WorkspaceService workspaceService;

    public WorkspaceJobController(OperationService operationService,
                                  WorkspaceJobStartService workspaceJobStartService,
                                  WorkspaceService workspaceService) {
        this.operationService = operationService;
        this.workspaceJobStartService = workspaceJobStartService;
        this.workspaceService = workspaceService;
    }

    @GetMapping("/api/v1/workspaces/{workspaceId}/jobs")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> list(@PathVariable String workspaceId) {
        try {
            workspaceService.requireAccessibleWorkspace(workspaceId, TenantContext.getUserId());
            return ResponseEntity.ok(operationService.listWorkspaceJobs(workspaceId));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    /**
     * 启动一个 Workspace Job。`Idempotency-Key` required；同 key 重复请求返回既有
     * projection（200），不产生第二个进程。
     */
    @PostMapping("/api/v1/workspaces/{workspaceId}/jobs")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> start(
            @PathVariable String workspaceId,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody(required = false) WorkspaceJobStartService.StartRequest request) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Authentication context is required");
        }
        try {
            if (idempotencyKey == null || idempotencyKey.isBlank()) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "IDEMPOTENCY_KEY_REQUIRED",
                        "Idempotency-Key header is required");
            }
            WorkspaceJobStartService.StartOutcome outcome =
                    workspaceJobStartService.start(workspaceId, userId, request, idempotencyKey);
            return outcome.replayed()
                    ? ResponseEntity.ok(outcome.job())
                    : ResponseEntity.accepted().body(outcome.job());
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }
}
