package com.cc01cc.p.xihe.cp.scheduled;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * PLAN-0489 T1.4（contract: PLAN-0486 spec/scheduled-task.md v3.3 §4 API 面）：
 * workspace-scoped scheduled-tasks 公开端点——Bearer + workspace 可达 +
 * RFC 9457 Problem Details（code/requestId），与 CP 既有 Job API 同构。
 *
 * <p>DELETE 只负责 scheduled→cancelled；missed/expired 的处置走
 * {@code /remove}（409 {@code SCHEDULED_TASK_STATE} 指引），OpenAPI 同批注明分工。</p>
 */
@RestController
public class ScheduledTaskController {

    private final ScheduledTaskApiService scheduledTaskApiService;

    public ScheduledTaskController(ScheduledTaskApiService scheduledTaskApiService) {
        this.scheduledTaskApiService = scheduledTaskApiService;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/workspaces/{workspaceId}/scheduled-tasks")
    public ResponseEntity<?> list(@PathVariable String workspaceId,
            @RequestParam(name = "page", defaultValue = "0") int page,
            @RequestParam(name = "size", defaultValue = "100") int size) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication context is required");
        }
        try {
            return ResponseEntity.ok(scheduledTaskApiService.list(workspaceId, userId, page, size));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/workspaces/{workspaceId}/scheduled-tasks")
    public ResponseEntity<?> create(@PathVariable String workspaceId,
            @RequestBody ScheduledTaskApiService.CreateRequest request) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication context is required");
        }
        try {
            return ResponseEntity.status(HttpStatus.CREATED)
                    .body(scheduledTaskApiService.create(workspaceId, userId, request));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/workspaces/{workspaceId}/scheduled-tasks/{taskId}")
    public ResponseEntity<?> get(@PathVariable String workspaceId, @PathVariable String taskId) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication context is required");
        }
        try {
            return ResponseEntity.ok(scheduledTaskApiService.detail(workspaceId, userId, taskId));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    /** scheduled→cancelled；missed/expired 用 POST /remove（409 指引）。 */
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @DeleteMapping("/api/v1/workspaces/{workspaceId}/scheduled-tasks/{taskId}")
    public ResponseEntity<?> delete(@PathVariable String workspaceId, @PathVariable String taskId,
            @RequestBody(required = false) ScheduledTaskApiService.DisposeRequest request) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication context is required");
        }
        try {
            ScheduledTaskApiService.DisposeResult result = scheduledTaskApiService.delete(
                    workspaceId, userId, taskId, agentPrincipalId(request));
            return ResponseEntity.ok(disposeBody(result));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/workspaces/{workspaceId}/scheduled-tasks/{taskId}/rerun")
    public ResponseEntity<?> rerun(@PathVariable String workspaceId, @PathVariable String taskId,
            @RequestBody(required = false) ScheduledTaskApiService.DisposeRequest request) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication context is required");
        }
        try {
            return ResponseEntity.ok(scheduledTaskApiService.rerun(
                    workspaceId, userId, taskId, agentPrincipalId(request)));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/workspaces/{workspaceId}/scheduled-tasks/{taskId}/remove")
    public ResponseEntity<?> remove(@PathVariable String workspaceId, @PathVariable String taskId,
            @RequestBody(required = false) ScheduledTaskApiService.DisposeRequest request) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication context is required");
        }
        try {
            ScheduledTaskApiService.DisposeResult result = scheduledTaskApiService.remove(
                    workspaceId, userId, taskId, agentPrincipalId(request));
            return ResponseEntity.ok(disposeBody(result));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/workspaces/{workspaceId}/scheduled-tasks/{taskId}/postpone")
    public ResponseEntity<?> postpone(@PathVariable String workspaceId, @PathVariable String taskId,
            @RequestBody ScheduledTaskApiService.PostponeRequest request) {
        String userId = TenantContext.getUserId();
        if (userId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Authentication context is required");
        }
        try {
            return ResponseEntity.ok(scheduledTaskApiService.postpone(workspaceId, userId, taskId,
                    request == null ? null : request.at(),
                    request == null ? null : request.agentPrincipalId()));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    private static String agentPrincipalId(ScheduledTaskApiService.DisposeRequest request) {
        return request == null ? null : request.agentPrincipalId();
    }

    private static Map<String, Object> disposeBody(ScheduledTaskApiService.DisposeResult result) {
        return Map.of(
                "taskId", result.taskId(),
                "status", result.status(),
                "changed", result.changed(),
                "task", result.task());
    }

    private static ResponseEntity<?> problem(CpApiException e) {
        if (e.getRequestId() != null) {
            return ProblemDetailsHandler.problemResponse(
                    e.getStatus(), e.getCode(), e.getMessage(), e.getRequestId());
        }
        return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
    }
}
