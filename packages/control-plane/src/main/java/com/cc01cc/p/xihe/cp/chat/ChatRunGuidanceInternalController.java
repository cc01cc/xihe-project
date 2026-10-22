package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.entity.ChatRunGuidance;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * Internal service-Bearer Guidance surface for the Agent runner (frozen wire:
 * spec/session/chat-run-operation.md §Run Guidance). Pending read + consume
 * acknowledgement; consume-after-terminal-expired is an explicit 409 so the
 * agent stops retrying and does not inject.
 */
@RestController
@RequestMapping("/internal/v1/chat/runs/{runId}/guidance")
public class ChatRunGuidanceInternalController {

    private final ChatRunGuidanceService service;

    public ChatRunGuidanceInternalController(ChatRunGuidanceService service) {
        this.service = service;
    }

    @GetMapping("/pending")
    public ResponseEntity<?> pending(@PathVariable String runId) {
        try {
            List<ChatRunGuidance> records = service.pendingForAgent(runId);
            List<Map<String, Object>> items = records.stream()
                    .map(record -> Map.<String, Object>of(
                            "id", record.getId().toString(),
                            "sequence", record.getSequence(),
                            "sourceKind", record.getSourceKind(),
                            "content", record.getBodyMarkdown()))
                    .toList();
            return ResponseEntity.ok(Map.of("runId", runId, "items", items));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    public record ConsumeRequest(String consumedBy) {
    }

    @PostMapping("/{guidanceId}/consume")
    public ResponseEntity<?> consume(
            @PathVariable String runId,
            @PathVariable String guidanceId,
            @RequestBody(required = false) ConsumeRequest request) {
        try {
            ChatRunGuidanceService.ConsumeResult result = service.consume(runId, guidanceId);
            return ResponseEntity.ok(Map.of(
                    "id", result.record().getId().toString(),
                    "status", result.record().getStatus(),
                    "consumedAt", result.record().getConsumedAt().toString(),
                    "firstConsumption", result.firstConsumption()));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }
}
