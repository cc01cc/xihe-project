package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.util.JacksonNodeExit;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/**
 * PLAN-0666 M2: read-only context fingerprint + two-run diff (design D4).
 *
 * <p>Route prefix follows the existing run read surfaces ({@code /api/v1/chat/runs/{runId}/trace});
 * one route carries both behaviours: without {@code against} it returns the envelope, with
 * {@code against} it returns the per-layer diff. Authorization reuses the run-trace path
 * (run identity + {@code SessionService.requireCurrent}) — no new bypass.
 *
 * <p>Jackson-2 nodes never leave the control plane directly: both responses go through
 * {@link JacksonNodeExit#toDocument(JsonNode)} (PLAN-0633 C1).
 */
@RestController
public class RunContextFingerprintController {

    private final ChatRunReadService chatRunReadService;
    private final SessionService sessionService;
    private final ObjectMapper objectMapper;

    public RunContextFingerprintController(ChatRunReadService chatRunReadService,
                                           SessionService sessionService,
                                           ObjectMapper objectMapper) {
        this.chatRunReadService = chatRunReadService;
        this.sessionService = sessionService;
        this.objectMapper = objectMapper;
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/api/v1/chat/runs/{runId}/context-fingerprint")
    public ResponseEntity<?> getFingerprint(@PathVariable String runId,
                                            @RequestParam(required = false) String against) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.workspaceContextRequired();
        }
        try {
            ChatRun run = requireRun(runId, userId, workspaceId);
            ContextFingerprintReadService.View current = viewOf(run);
            if (against == null || against.isBlank()) {
                return ResponseEntity.ok(JacksonNodeExit.toDocument(objectMapper, envelope(current)));
            }
            ChatRun baseline = requireRun(against, userId, workspaceId);
            ContextFingerprintReadService.View againstView = viewOf(baseline);
            if (!baseline.getSessionId().equals(run.getSessionId())) {
                throw new CpApiException(HttpStatus.CONFLICT, "DIFF_SESSION_MISMATCH",
                        "Context fingerprints from different sessions are not comparable");
            }
            ObjectNode diff = ContextFingerprintReadService.diff(againstView, current);
            return ResponseEntity.ok(JacksonNodeExit.toDocument(objectMapper, diff));
        } catch (CpApiException exception) {
            return ProblemDetailsHandler.problemResponse(
                    exception.getStatus(), exception.getCode(), exception.getMessage());
        }
    }

    private ChatRun requireRun(String runId, String userId, String workspaceId) {
        UUID runUuid;
        try {
            runUuid = UUID.fromString(runId);
        } catch (IllegalArgumentException exception) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found");
        }
        // 404-vs-403 order stays inside the service (unknown ⇒ 404 before owner ⇒ 403); the
        // session-level gate stays here because it must run *after* the owner gate, exactly as before.
        ChatRun found = chatRunReadService.requireOwnedRun(runUuid, userId, workspaceId);
        sessionService.requireCurrent(found.getSessionId(), userId, workspaceId);
        return found;
    }

    /** Absence is named here (two-level model): never re-encoded as disabled/error. */
    private ContextFingerprintReadService.View viewOf(ChatRun run) {
        JsonNode stored = run.getContextFingerprint();
        ContextFingerprintReadService.DispatchState state = stored != null
                ? ContextFingerprintReadService.DispatchState.DISPATCHED
                : (chatRunReadService.hasTransportAttempt(run.getId().toString())
                        ? ContextFingerprintReadService.DispatchState.DISPATCHED
                        : ContextFingerprintReadService.DispatchState.NOT_DISPATCHED);
        return ContextFingerprintReadService.view(
                run.getId().toString(), run.getSessionId(), stored, state);
    }

    private static ObjectNode envelope(ContextFingerprintReadService.View view) {
        ObjectNode node = com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode();
        node.put("runId", view.runId());
        node.put("available", view.available());
        if (view.reason() != null) {
            node.put("reason", view.reason());
        }
        if (view.fingerprint() != null) {
            node.set("fingerprint", view.fingerprint());
        }
        return node;
    }
}
