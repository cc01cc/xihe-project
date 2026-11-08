package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ConversationThread;
import com.cc01cc.p.xihe.cp.service.ThreadAccessService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
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
 * PLAN-0646 MVP (D-671): minimal conversation-thread face.
 *
 * <p>Routes: {@code POST /api/v1/conversation-threads} (create), {@code GET .../{id}} (read),
 * {@code POST .../{id}/sessions} (attach one session). The Session creation path itself is deliberately
 * untouched: {@code SessionCreateRequest} carries no thread, and existing sessions stay valid with
 * {@code conversation_thread_id = NULL} (V1/V6).</p>
 */
@RestController
@RequestMapping("/api/v1/conversation-threads")
public class ConversationThreadController {

    private final ThreadAccessService threadAccessService;

    public ConversationThreadController(ThreadAccessService threadAccessService) {
        this.threadAccessService = threadAccessService;
    }

    @PreAuthorize("isAuthenticated()")
    @PostMapping
    public ResponseEntity<?> create(@RequestBody(required = false) Map<String, Object> body) {
        try {
            String actor = requireActor();
            String scopeType = text(body, "scopeType");
            UUID scopeId = uuid(text(body, "scopeId"));
            String title = text(body, "title");
            ConversationThread thread = threadAccessService.create(actor, scopeType, scopeId, title);
            return ResponseEntity.status(HttpStatus.CREATED).body(threadAccessService.view(thread));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PreAuthorize("isAuthenticated()")
    @GetMapping("/{threadId}")
    public ResponseEntity<?> read(@PathVariable String threadId) {
        try {
            String actor = requireActor();
            ConversationThread thread = threadAccessService.requireReadable(actor, uuid(threadId));
            return ResponseEntity.ok(threadAccessService.view(thread));
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    @PreAuthorize("isAuthenticated()")
    @PostMapping("/{threadId}/sessions")
    public ResponseEntity<?> attach(@PathVariable String threadId,
                                    @RequestBody(required = false) Map<String, Object> body) {
        try {
            String actor = requireActor();
            UUID sessionId = uuid(text(body, "sessionId"));
            ThreadAccessService.AttachResult result =
                    threadAccessService.attach(actor, uuid(threadId), sessionId);
            Map<String, Object> response = new LinkedHashMap<>(threadAccessService.view(result.thread()));
            response.put("attachedSessionId", result.sessionId().toString());
            response.put("changed", result.changed());
            return ResponseEntity.ok(response);
        } catch (CpApiException e) {
            return problem(e);
        }
    }

    private String requireActor() {
        String userId = TenantContext.getUserId();
        if (userId == null || userId.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED",
                    "Authenticated user is required");
        }
        return userId;
    }

    private static String text(Map<String, Object> body, String key) {
        if (body == null) {
            return null;
        }
        Object value = body.get(key);
        return value instanceof String string && !string.isBlank() ? string : null;
    }

    private static UUID uuid(String value) {
        if (value == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "THREAD_SCOPE_INVALID",
                    "A UUID value is required");
        }
        try {
            return UUID.fromString(value.trim());
        } catch (IllegalArgumentException e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "THREAD_SCOPE_INVALID",
                    "Malformed UUID value");
        }
    }

    private static ResponseEntity<?> problem(CpApiException e) {
        return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
    }
}
