package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.Set;

@RestController
@RequestMapping("/internal/v1/agents")
public class AgentSpawnController {

    private static final Set<String> ALLOWED_FIELDS = Set.of("parentRunId", "toolCallId");

    private final ChatSubmissionService chatSubmissionService;

    public AgentSpawnController(ChatSubmissionService chatSubmissionService) {
        this.chatSubmissionService = chatSubmissionService;
    }

    @PostMapping("/spawn")
    public ResponseEntity<ChatSubmissionService.SpawnResult> spawn(@RequestBody Map<String, Object> body) {
        if (body == null) {
            throw invalidSpawnRequest("Request body is required");
        }
        for (String field : body.keySet()) {
            if (!ALLOWED_FIELDS.contains(field)) {
                throw invalidSpawnRequest("Request may only contain parentRunId and toolCallId");
            }
        }
        String parentRunId = requiredText(body.get("parentRunId"), "parentRunId");
        String toolCallId = requiredText(body.get("toolCallId"), "toolCallId");
        return ResponseEntity.ok(chatSubmissionService.createSpawnFromParent(parentRunId, toolCallId));
    }

    private static String requiredText(Object value, String field) {
        if (!(value instanceof String text) || text.isBlank()) {
            throw invalidSpawnRequest(field + " is required");
        }
        return text;
    }

    private static CpApiException invalidSpawnRequest(String detail) {
        return new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", detail);
    }
}
