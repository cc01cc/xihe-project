package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Service-to-service Operation Ledger entry points (PLAN-281 task 1.3).
 * Authenticated as INTERNAL_SERVICE via SecurityConfig; callers are Agent,
 * Runtime and internal diagnostics.
 */
@RestController
@RequestMapping("/internal/v1/operations")
public class InternalOperationController {

    private static final Logger logger = LoggerFactory.getLogger(InternalOperationController.class);

    private final OperationService operationService;

    public InternalOperationController(OperationService operationService) {
        this.operationService = operationService;
    }

    @PostMapping
    public ResponseEntity<?> start(@RequestBody StartOperationRequest request) {
        // PLAN-0464 V1: the Chat lifecycle root is chat_runs. This route must
        // never mint a new kind=chat LedgerOperation again.
        if (request != null && "chat".equalsIgnoreCase(request.kind())) {
            logger.warn("Internal operation start rejected: kind=chat roots are retired (PLAN-0464)");
            return ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT,
                    "CHAT_OPERATION_ROOT_RETIRED",
                    "kind=chat roots are owned by chat_runs since PLAN-0464");
        }
        try {
            OperationService.OperationStartResult result = operationService.startOperation(
                    request.userId(), request.sessionId(), request.workspaceId(),
                    request.runId(), request.requestId(), request.kind(), request.source(),
                    request.actorType(), request.actorId(), request.idempotencyKey(),
                    request.summary());
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("operationId", result.operationId().toString());
            body.put("alreadyRecorded", result.alreadyRecorded());
            return ResponseEntity.status(result.alreadyRecorded()
                    ? HttpStatus.OK : HttpStatus.CREATED).body(body);
        } catch (CpApiException e) {
            logger.warn("Internal operation start rejected: {}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        } catch (IllegalArgumentException e) {
            logger.warn("Internal operation start rejected: {}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", e.getMessage());
        }
    }

    /**
     * Service-Bearer ledger trace.
     *
     * @deprecated PLAN-0466 T1.3 — replaced by
     *     {@code GET /internal/v1/audit/entries/{type}/{id}} (domain detail +
     *     history timeline with the internal field tier); removal tracked by
     *     PLAN-0467 (OpenAPI marks it {@code deprecated: true}).
     */
    @Deprecated
    @GetMapping("/{operationId}/trace")
    public ResponseEntity<?> trace(@PathVariable String operationId) {
        UUID id;
        try {
            id = UUID.fromString(operationId);
        } catch (IllegalArgumentException e) {
            logger.warn("Internal operation trace rejected: invalid operationId");
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "operationId must be a UUID");
        }
        try {
            return ResponseEntity.ok(OperationViews.toInternalTrace(operationService.getOperationTrace(id)));
        } catch (CpApiException e) {
            logger.warn("Internal operation trace rejected: {}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        } catch (IllegalArgumentException e) {
            logger.warn("Internal operation trace rejected: {}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.NOT_FOUND, "OPERATION_NOT_FOUND", "Operation not found");
        }
    }

    /**
     * PLAN-0317 T2.9（决策 #14）：Runtime 追偿成功后的迟到终止事件入口。
     * 只追加事件、不改 item 终态（账本保留"当时未确认"的事实）。
     *
     * @deprecated PLAN-0463 T2.2 — prefer
     *     {@code POST /internal/v1/mcp/invocations/{invocationId}/late-termination};
     *     this item target stays for callers without an invocation id and is
     *     removed by PLAN-0467 (OpenAPI marks it {@code deprecated: true}).
     */
    @Deprecated
    @PostMapping("/items/{itemId}/late-termination")
    public ResponseEntity<?> lateTermination(@PathVariable String itemId,
                                             @RequestBody(required = false) LateTerminationRequest request) {
        try {
            boolean confirmed = request != null && request.confirmed();
            operationService.recordLateTermination(itemId, confirmed);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("status", "recorded");
            return ResponseEntity.ok(body);
        } catch (CpApiException e) {
            logger.warn("Late termination rejected: {}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        } catch (IllegalArgumentException e) {
            logger.warn("Late termination rejected: invalid itemId");
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "itemId must be a UUID");
        }
    }

    public record StartOperationRequest(
            String userId,
            String sessionId,
            String workspaceId,
            String runId,
            String requestId,
            String kind,
            String source,
            String actorType,
            String actorId,
            String idempotencyKey,
            String summary) {}

    public record LateTerminationRequest(boolean confirmed) {}
}
