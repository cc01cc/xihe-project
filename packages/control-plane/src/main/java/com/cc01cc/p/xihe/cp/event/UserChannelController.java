package com.cc01cc.p.xihe.cp.event;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * PLAN-0660 T5.4 — {@code GET /api/v1/user-events}: the **user-level** SSE channel.
 *
 * <p>Contract ({@code spec/session/user-channel.md} §4): authenticated by the user's Bearer token
 * only — **no {@code X-Workspace-Id} is required** (the channel is per user and survives workspace
 * switching). The first frame is {@code connected} with {@code serverTime}; there is no replay. The
 * event names are the closed public set {@code connected} / {@code participant_notified} /
 * {@code user_question} — intentionally independent of the internal {@code wake_*} names.</p>
 */
@RestController
public class UserChannelController {

    private final UserChannelSseManager channel;

    public UserChannelController(UserChannelSseManager channel) {
        this.channel = channel;
    }

    @GetMapping(path = "/api/v1/user-events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    @PreAuthorize("isAuthenticated()")
    public ResponseEntity<?> subscribe() {
        String userId = TenantContext.getUserId();
        if (userId == null || userId.isBlank()) {
            return ProblemDetailsHandler.missingPrincipal("Authentication required");
        }
        try {
            SseEmitter emitter = channel.register(userId);
            return ResponseEntity.ok(emitter);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }
}
