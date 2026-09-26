package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

@RestController
@RequestMapping("/internal/v1/agents")
public class AgentSpawnController {

    private static final Set<String> ALLOWED_FIELDS = Set.of("parentRunId", "toolCallId");

    private final ChatSubmissionService chatSubmissionService;
    private final AgentSpawnAuthorizationService authorizationService;
    private final AgentSpawnExecutionService executionService;

    public AgentSpawnController(ChatSubmissionService chatSubmissionService,
                                AgentSpawnAuthorizationService authorizationService,
                                AgentSpawnExecutionService executionService) {
        this.chatSubmissionService = chatSubmissionService;
        this.authorizationService = authorizationService;
        this.executionService = executionService;
    }

    @PostMapping("/spawn")
    public ResponseEntity<?> spawn(
            @RequestBody Map<String, Object> body,
            @RequestHeader(value = AgentSpawnAuthorizationService.APPROVAL_GRANT_HEADER, required = false)
            String approvalRequestId) {
        if (body == null) {
            throw invalidSpawnRequest("Request body is required");
        }
        if (!body.keySet().equals(ALLOWED_FIELDS)) {
            throw invalidSpawnRequest("Request must contain only parentRunId and toolCallId");
        }
        String parentRunId = requiredText(body.get("parentRunId"), "parentRunId");
        String toolCallId = requiredText(body.get("toolCallId"), "toolCallId");
        ChatSubmissionService.SpawnInvocation invocation =
                chatSubmissionService.prepareSpawnInvocation(parentRunId, toolCallId);
        AgentSpawnAuthorizationService.GateResult gate =
                authorizationService.authorize(invocation, approvalRequestId);
        if (!gate.allowed()) {
            Map<String, Object> extra = new LinkedHashMap<>();
            extra.put("tool", ChatSubmissionService.SPAWN_TOOL_NAME);
            extra.put("retryHeader", AgentSpawnAuthorizationService.APPROVAL_GRANT_HEADER);
            extra.put("approvalRequestId", gate.approvalRequestId());
            extra.put("expiresAt", gate.expiresAt().toString());
            return ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT, "APPROVAL_REQUIRED",
                    "Spawn requires approval", extra);
        }

        return ResponseEntity.ok(executionService.execute(invocation, gate.authorization()));
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
