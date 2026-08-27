package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.context.service.ContextSourceRefreshService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
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
    private final ContextSourceRefreshService sourceRefreshService;
    private final WorkspaceUserRepository workspaceUserRepository;
    private final SessionRepository sessionRepository;

    public ContextController(ContextService contextService,
                             ContextSourceRefreshService sourceRefreshService,
                             WorkspaceUserRepository workspaceUserRepository,
                             SessionRepository sessionRepository) {
        this.contextService = contextService;
        this.sourceRefreshService = sourceRefreshService;
        this.workspaceUserRepository = workspaceUserRepository;
        this.sessionRepository = sessionRepository;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN', 'INTERNAL_SERVICE')")
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
                sessionId, resolveWorkspaceId(sessionId), resolveUserId(sessionId), eventType, payload);
        return ResponseEntity.ok(Map.of(
                "sequence", event.getSequence(),
                "event_type", event.getEventType(),
                "created_at", event.getCreatedAt().toString()
        ));
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN', 'INTERNAL_SERVICE')")
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
                sessionId, resolveWorkspaceId(sessionId), resolveUserId(sessionId), payloads);
        List<Long> sequences = saved.stream().map(e -> e.getSequence()).toList();
        return ResponseEntity.ok(Map.of("sequences", sequences));
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN', 'INTERNAL_SERVICE')")
    @GetMapping("/{sessionId}/snapshot")
    public ResponseEntity<?> getSnapshot(
            @PathVariable String sessionId,
            @RequestParam(name = "afterSequence", defaultValue = "0") Long afterSequence) {
        if (!verifyAccess(sessionId)) {
            return forbidden();
        }
        ObjectNode snapshot = contextService.getSnapshot(
                sessionId, resolveWorkspaceId(sessionId), resolveUserId(sessionId), afterSequence);
        // Jackson tree types from the legacy mapper are serialized as bean
        // metadata by the Spring Boot 4 converter. Return the JSON payload
        // explicitly so Agent receives the projected context object.
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_JSON)
                .body(snapshot.toString());
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN', 'INTERNAL_SERVICE')")
    @PostMapping("/{sessionId}/refresh-sources")
    public ResponseEntity<?> refreshSources(@PathVariable String sessionId) {
        if (!verifyAccess(sessionId)) {
            return forbidden();
        }
        Optional<String> hash = sourceRefreshService.refresh(
                sessionId, resolveWorkspaceId(sessionId), resolveUserId(sessionId));
        if (hash.isPresent()) {
            return ResponseEntity.ok(Map.of(
                    "status", "refreshed",
                    "source_key", "AGENTS.md",
                    "hash", hash.get()));
        }
        return ResponseEntity.ok(Map.of(
                "status", "unchanged",
                "source_key", "AGENTS.md"));
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN', 'INTERNAL_SERVICE')")
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

    @PreAuthorize("hasAnyRole('USER', 'ADMIN', 'INTERNAL_SERVICE')")
    @GetMapping("/{sessionId}/events/latest")
    public ResponseEntity<?> latestSequence(@PathVariable String sessionId) {
        if (!verifyAccess(sessionId)) {
            return forbidden();
        }
        Long sequence = contextService.getLatestSequence(sessionId);
        return ResponseEntity.ok(Map.of("sequence", sequence));
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN', 'INTERNAL_SERVICE')")
    @PostMapping("/{sessionId}/replay")
    public ResponseEntity<?> replay(
            @PathVariable String sessionId,
            @RequestBody Map<String, Object> body) {
        if (!verifyAccess(sessionId)) {
            return forbidden();
        }
        Long afterSequence = Long.valueOf(body.getOrDefault("afterSequence", "0").toString());
        var result = contextService.replay(
                sessionId, resolveWorkspaceId(sessionId), resolveUserId(sessionId), afterSequence);
        return ResponseEntity.ok(result);
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN', 'INTERNAL_SERVICE')")
    @PostMapping("/{sessionId}/compact")
    public ResponseEntity<?> compact(
            @PathVariable String sessionId,
            @RequestBody Map<String, Object> body) {
        if (!verifyAccess(sessionId)) {
            return forbidden();
        }
        Long upToSequence = body.get("upToSequence") != null
                ? Long.valueOf(body.get("upToSequence").toString())
                : null;
        var event = contextService.compact(
                sessionId, resolveWorkspaceId(sessionId), resolveUserId(sessionId), upToSequence);
        return ResponseEntity.ok(Map.of(
                "sequence", event.getSequence(),
                "event_type", event.getEventType(),
                "created_at", event.getCreatedAt().toString()
        ));
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN', 'INTERNAL_SERVICE')")
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
                sourceSessionId, atSequence, newSessionId, resolveWorkspaceId(sourceSessionId), resolveUserId(sourceSessionId));
        return ResponseEntity.ok(Map.of("sequence", latestSequence));
    }

    private boolean verifyAccess(String sessionId) {
        String userId = resolveUserId(sessionId);
        String workspaceId = resolveWorkspaceId(sessionId);
        if (userId == null || workspaceId == null) {
            return false;
        }
        // Workspace membership is required. Session ownership is not verified here
        // because the session may be created concurrently by the Agent module.
        return workspaceUserRepository
                .findByIdWorkspaceIdAndIdUserId(workspaceId, userId)
                .isPresent();
    }

    private String resolveUserId(String sessionId) {
        String tokenUserId = TenantContext.getUserId();
        if (tokenUserId != null) return tokenUserId;
        return sessionRepository.findById(sessionId).map(session -> session.getUserId()).orElse("anonymous");
    }

    private String resolveWorkspaceId(String sessionId) {
        String tokenWorkspaceId = TenantContext.getWorkspaceId();
        if (tokenWorkspaceId != null) return tokenWorkspaceId;
        return sessionRepository.findById(sessionId).map(session -> session.getWorkspaceId()).orElse("default");
    }

    private ResponseEntity<?> forbidden() {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(Map.of("status", "error", "message", "Access denied"));
    }
}
