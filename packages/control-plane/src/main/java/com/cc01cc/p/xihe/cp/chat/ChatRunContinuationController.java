package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.Map;

/** Public admission surface for the two frozen ChatRun continuation modes. */
@RestController
class ChatRunContinuationController {
    private final ChatRunContinuationService continuations;

    ChatRunContinuationController(ChatRunContinuationService continuations) {
        this.continuations = continuations;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/chat/runs/{sourceRunId}/continue")
    ResponseEntity<Map<String, Object>> continueRun(
            @PathVariable String sourceRunId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyHeader,
            @RequestBody JsonNode body) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }

        ChatRunContinuationRequest request;
        String idempotencyKey;
        try {
            request = ChatRunContinuationRequest.parse(body);
            idempotencyKey = ChatRunContinuationRequest.requireIdempotencyKey(idempotencyHeader);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }

        try {
            ChatRunContinuationService.ContinuationResult result = continuations.continueRun(
                    sourceRunId, userId, workspaceId, idempotencyKey, request);
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("runId", result.runId());
            response.put("mode", result.mode());
            return ResponseEntity.accepted().body(response);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }
}
