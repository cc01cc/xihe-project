package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0463 T2.2: internal late-termination entry point targeting the MCP
 * execution domain.
 *
 * <p>Contract (see {@code plans/PLAN-0463-xh-mcp-execution-domain/evidence/wire-contract.md} §3):
 * append-only history event, {@code unknown → late_confirmed} when Runtime
 * confirms, never a rewrite of an already settled invocation. The legacy item
 * target stays available (deprecated) and is removed by PLAN-0467.</p>
 */
@RestController
@RequestMapping("/internal/v1/mcp/invocations")
public class McpInvocationInternalController {

    private static final Logger logger = LoggerFactory.getLogger(McpInvocationInternalController.class);

    private final McpInvocationService mcpInvocationService;

    public McpInvocationInternalController(McpInvocationService mcpInvocationService) {
        this.mcpInvocationService = mcpInvocationService;
    }

    @PostMapping("/{invocationId}/late-termination")
    public ResponseEntity<?> lateTermination(@PathVariable String invocationId,
                                             @RequestBody(required = false) LateTerminationRequest request) {
        UUID id;
        try {
            id = UUID.fromString(invocationId);
        } catch (IllegalArgumentException e) {
            logger.warn("Late termination rejected: invocationId must be a UUID");
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "invocationId must be a UUID");
        }
        boolean confirmed = request != null && request.confirmed();
        UUID attemptId = null;
        if (request != null && request.attemptId() != null && !request.attemptId().isBlank()) {
            try {
                attemptId = UUID.fromString(request.attemptId());
            } catch (IllegalArgumentException e) {
                logger.warn("Late termination rejected: attemptId must be a UUID");
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "attemptId must be a UUID");
            }
        }
        try {
            mcpInvocationService.recordLateTermination(id, attemptId, confirmed);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("status", "recorded");
            return ResponseEntity.ok(body);
        } catch (CpApiException e) {
            logger.warn("Late termination rejected: {}", e.getMessage());
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=mcp_late_termination_failed invocationId={} failureType={}",
                    invocationId, e.getClass().getName(), e);
            throw e;
        }
    }

    public record LateTerminationRequest(boolean confirmed, String attemptId) {}
}
