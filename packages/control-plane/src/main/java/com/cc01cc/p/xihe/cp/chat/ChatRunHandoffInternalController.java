package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Internal service-Bearer surface for an agent-initiated TO (task-40 §3, D-1884 / D-1885).
 *
 * <p>Wire: POST /internal/v1/chat/runs/{runId}/to with Idempotency-Key, body
 * {content, toParticipantIds[], ccParticipantIds[]}. The actor is the RUN in the path: session,
 * workspace, owner and responder principal are all read off the chat_runs row, and the body carries
 * no actor field — an agent that names another participant still speaks as itself, which is why Q2
 * needed no new capability atom.</p>
 *
 * <p>Response is the audience accounting, not a bare accepted flag: {@code to} carries the five
 * buckets the human composer already promises (runIds / deferredTargets / notifiedTargets /
 * suppressedTargets / failedTargets, conservation asserted in {@link WakeFanOutService.TargetedWake})
 * and {@code cc} carries notified vs ignored. {@code messageId} is null exactly when nothing was
 * acted on, so a 200 with every target failed is honest instead of a silent drop.</p>
 *
 * <p>Errors ride the platform's RFC 9457 Problem Details with a stable code: 400
 * HANDOFF_IDEMPOTENCY_KEY_REQUIRED / HANDOFF_IDEMPOTENCY_KEY_TOO_LONG / PARTICIPANT_SELF_TARGET,
 * 404 HANDOFF_RUN_NOT_FOUND, 409 HANDOFF_RUN_NOT_ACTIVE / HANDOFF_RUN_HAS_NO_RESPONDER, 422
 * HANDOFF_CONTENT_REQUIRED / HANDOFF_CONTENT_TOO_LONG / HANDOFF_TARGETS_REQUIRED. A target outside
 * the session is NOT an error here: the durable {@code wake_dispatch} row refuses it with
 * reason=cross_session (agent) or drops it as not_in_roster (cc), mirroring the human face.</p>
 */
@RestController
@RequestMapping("/internal/v1/chat/runs/{runId}/to")
public class ChatRunHandoffInternalController {

    private final AgentHandoffService agentHandoffService;

    public ChatRunHandoffInternalController(AgentHandoffService agentHandoffService) {
        this.agentHandoffService = agentHandoffService;
    }

    /** The body carries no actor: runId in the path is the actor (see class javadoc). */
    public record HandoffRequest(String content, List<UUID> toParticipantIds,
                                 List<UUID> ccParticipantIds) {
    }

    @PostMapping
    public ResponseEntity<?> handoff(@PathVariable String runId,
                                     @RequestHeader(value = "Idempotency-Key", required = false)
                                     String idempotencyKey,
                                     @RequestBody(required = false) HandoffRequest request) {
        try {
            String content = request == null ? null : request.content();
            List<UUID> toIds = request == null ? List.of() : request.toParticipantIds();
            List<UUID> ccIds = request == null ? List.of() : request.ccParticipantIds();
            AgentHandoffService.HandoffOutcome outcome = agentHandoffService.handoff(runId, content,
                    toIds, ccIds, idempotencyKey);
            WakeFanOutService.TargetedWake to = outcome.to();
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("runId", outcome.runId());
            body.put("roundId", outcome.roundId());
            body.put("messageId", outcome.messageId());
            body.put("to", Map.of(
                    "requested", to.targets(),
                    "runIds", to.runIds(),
                    "failedTargets", to.failedTargets(),
                    "deferredTargets", to.deferredTargets(),
                    "notifiedTargets", to.notifiedTargets(),
                    "suppressedTargets", to.suppressedTargets()));
            body.put("cc", Map.of("notified", outcome.ccNotified(), "ignored", outcome.ccIgnored()));
            return ResponseEntity.ok(body);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }
}
