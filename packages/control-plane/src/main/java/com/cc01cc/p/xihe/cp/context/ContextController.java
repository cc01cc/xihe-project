package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.Optional;

@RestController
@RequestMapping("/api/v1/context")
public class ContextController {

    private static final Logger logger = LoggerFactory.getLogger(ContextController.class);

    private final ContextService contextService;
    private final WorkspaceUserRepository workspaceUserRepository;

    public ContextController(ContextService contextService,
                             WorkspaceUserRepository workspaceUserRepository) {
        this.contextService = contextService;
        this.workspaceUserRepository = workspaceUserRepository;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/{sessionId}/events")
    public ResponseEntity<?> appendEvent(
            @PathVariable String sessionId,
            @RequestBody Map<String, Object> body) {
        if (!verifyAccess(sessionId)) {
            return forbidden();
        }
        String eventType = (String) body.get("type");
        Object payload = body.getOrDefault("payload", Map.of());
        var event = contextService.appendEvent(
                sessionId, resolveWorkspaceId(), resolveUserId(), eventType, payload);
        return ResponseEntity.ok(Map.of(
                "sequence", event.getSequence(),
                "event_type", event.getEventType(),
                "created_at", event.getCreatedAt().toString()
        ));
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/{sessionId}/events/batch")
    public ResponseEntity<?> appendBatch(
            @PathVariable String sessionId,
            @RequestBody List<Map<String, Object>> events) {
        if (!verifyAccess(sessionId)) {
            return forbidden();
        }
        List<EventStoreService.EventPayload> payloads = events.stream()
                .map(e -> new EventStoreService.EventPayload(
                        (String) e.get("type"), e.getOrDefault("payload", Map.of())))
                .toList();
        var saved = contextService.appendBatch(
                sessionId, resolveWorkspaceId(), resolveUserId(), payloads);
        List<Long> sequences = saved.stream().map(e -> e.getSequence()).toList();
        return ResponseEntity.ok(Map.of("sequences", sequences));
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/{sessionId}/snapshot")
    public ResponseEntity<?> getSnapshot(
            @PathVariable String sessionId,
            @RequestParam(name = "afterSequence", defaultValue = "0") Long afterSequence) {
        if (!verifyAccess(sessionId)) {
            return forbidden();
        }
        ObjectNode snapshot = contextService.getSnapshot(
                sessionId, resolveWorkspaceId(), resolveUserId(), afterSequence);
        return ResponseEntity.ok(snapshot);
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/{sessionId}/events")
    public ResponseEntity<?> readEvents(
            @PathVariable String sessionId,
            @RequestParam(name = "afterSequence", defaultValue = "0") Long afterSequence) {
        if (!verifyAccess(sessionId)) {
            return forbidden();
        }
        var events = contextService.readEvents(sessionId, afterSequence);
        return ResponseEntity.ok(events);
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/{sessionId}/events/latest")
    public ResponseEntity<?> latestSequence(@PathVariable String sessionId) {
        if (!verifyAccess(sessionId)) {
            return forbidden();
        }
        Long sequence = contextService.getLatestSequence(sessionId);
        return ResponseEntity.ok(Map.of("sequence", sequence));
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/{sourceSessionId}/fork")
    public ResponseEntity<?> fork(
            @PathVariable String sourceSessionId,
            @RequestBody Map<String, Object> body) {
        if (!verifyAccess(sourceSessionId)) {
            return forbidden();
        }
        Long atSequence = Long.valueOf(body.get("atSequence").toString());
        String newSessionId = (String) body.get("newAggregateId");
        Long latestSequence = contextService.fork(
                sourceSessionId, atSequence, newSessionId, resolveWorkspaceId(), resolveUserId());
        return ResponseEntity.ok(Map.of("sequence", latestSequence));
    }

    private boolean verifyAccess(String sessionId) {
        String userId = resolveUserId();
        String workspaceId = resolveWorkspaceId();
        if (userId == null || workspaceId == null) {
            return false;
        }
        // Workspace membership is required. Session ownership is not verified here
        // because the session may be created concurrently by the Agent module.
        return workspaceUserRepository
                .findByIdWorkspaceIdAndIdUserId(workspaceId, userId)
                .isPresent();
    }

    private String resolveUserId() {
        String tokenUserId = TenantContext.getUserId();
        return tokenUserId != null ? tokenUserId : "anonymous";
    }

    private String resolveWorkspaceId() {
        String tokenWorkspaceId = TenantContext.getWorkspaceId();
        return tokenWorkspaceId != null ? tokenWorkspaceId : "default";
    }

    private ResponseEntity<?> forbidden() {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(Map.of("status", "error", "message", "Access denied"));
    }
}
