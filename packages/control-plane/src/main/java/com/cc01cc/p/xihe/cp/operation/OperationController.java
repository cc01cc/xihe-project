package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.SessionOperation;
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

    private final OperationService operationService;

    public OperationController(OperationService operationService) {
        this.operationService = operationService;
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
