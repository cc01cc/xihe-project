package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ChatRunGuidance;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * PLAN-0528 public Guidance surface for the run's owning user (frozen wire:
 * spec/cp-guidance-contract.md §3). No SSE events by ruling: clients refetch
 * this snapshot after submit and on run terminal events.
 */
@RestController
@RequestMapping("/api/v1/chat/runs/{runId}/guidance")
public class ChatRunGuidanceController {

    private final ChatRunGuidanceService service;

    public ChatRunGuidanceController(ChatRunGuidanceService service) {
        this.service = service;
    }

    public record GuidanceCreateRequest(String content) {
    }

    @PostMapping
    public ResponseEntity<?> submit(
            @PathVariable String runId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody GuidanceCreateRequest request) {
        try {
            ChatRunGuidanceService.SubmitResult result = service.submit(runId,
                    TenantContext.getUserId(), TenantContext.getWorkspaceId(),
                    idempotencyKey, request == null ? null : request.content());
            Map<String, Object> body = Map.of(
                    "id", result.record().getId().toString(),
                    "runId", result.record().getRunId().toString(),
                    "sessionId", result.record().getSessionId().toString(),
                    "sequence", result.record().getSequence(),
                    "status", result.record().getStatus(),
                    "createdAt", result.record().getCreatedAt().toString());
            return ResponseEntity.status(result.replayed() ? HttpStatus.OK : HttpStatus.CREATED).body(body);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @GetMapping
    public ResponseEntity<?> snapshot(@PathVariable String runId) {
        try {
            List<ChatRunGuidance> records = service.snapshot(runId,
                    TenantContext.getUserId(), TenantContext.getWorkspaceId());
            List<Map<String, Object>> items = records.stream().map(ChatRunGuidanceController::toItem).toList();
            long latestSequence = records.isEmpty() ? 0 : records.get(records.size() - 1).getSequence();
            return ResponseEntity.ok(Map.of("items", items, "latestSequence", latestSequence));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    static Map<String, Object> toItem(ChatRunGuidance record) {
        var item = new java.util.LinkedHashMap<String, Object>();
        item.put("id", record.getId().toString());
        item.put("sequence", record.getSequence());
        item.put("sourceKind", record.getSourceKind());
        item.put("status", record.getStatus());
        item.put("createdAt", record.getCreatedAt().toString());
        if (record.getConsumedAt() != null) {
            item.put("consumedAt", record.getConsumedAt().toString());
        }
        if (record.getTerminalExpiredAt() != null) {
            item.put("terminalExpiredAt", record.getTerminalExpiredAt().toString());
        }
        item.put("authorPrincipalId", record.getAuthorPrincipalId().toString());
        item.put("content", record.getBodyMarkdown());
        return item;
    }
}
