package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.context.service.ContextSourceRefreshService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
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
import java.util.UUID;
import java.util.Map;
import java.util.UUID;
import java.util.Optional;
import java.util.UUID;

@RestController
    @RequestMapping("/internal/v1/context")
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
        rejectBranchOverride(body);
        String eventType = (String) body.get("type");
        Object payload = body.getOrDefault("payload", Map.of());
        var event = contextService.appendEvent(
                sessionId, resolveWorkspaceId(sessionId), resolveUserId(sessionId), eventType, payload,
                correlationIdOf(body));
        return ResponseEntity.ok(Map.of(
                "sequence", event.getSequence(),
                "eventType", event.getEventType(),
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
                .map(e -> {
                    rejectBranchOverride(e);
                    return new EventStoreService.EventPayload(
                            (String) e.get("type"), e.getOrDefault("payload", Map.of()),
                            correlationIdOf(e));
                })
                .toList();
        var saved = contextService.appendBatch(
                sessionId, resolveWorkspaceId(sessionId), resolveUserId(sessionId), payloads);
        List<Long> sequences = saved.stream().map(e -> e.getSequence()).toList();
        return ResponseEntity.ok(Map.of("sequences", sequences));
    }

    /**
     * PLAN-0410 field-matrix §6: the request body never chooses the branch —
     * CP derives it from a durable {@code correlation_id} run binding.
     */
    private void rejectBranchOverride(Map<String, Object> body) {
        if (body.containsKey("branch_id")) {
            throw new com.cc01cc.p.xihe.cp.config.CpApiException(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "branch_id is derived by CP and cannot be supplied by the caller");
        }
    }

    private String correlationIdOf(Map<String, Object> body) {
        Object correlationId = body.get("correlation_id");
        if (correlationId == null) {
            return null;
        }
        String value = String.valueOf(correlationId).trim();
        return value.isEmpty() || "null".equals(value) ? null : value;
    }


    /**
     * PLAN-0410 T2.3 (field-matrix §6): the snapshot selector is either a
     * CP-validated {@code branchId} or a {@code runId} whose durable branch
     * resolves it — when both are supplied they must agree (409). Invalid or
     * foreign selectors fail closed (404/409) and never fall back to the
     * Session root. Omitting both keeps the legacy Session-root snapshot.
     */
    @PreAuthorize("hasAnyRole('USER', 'ADMIN', 'INTERNAL_SERVICE')")
    @GetMapping("/{sessionId}/snapshot")
    public ResponseEntity<?> getSnapshot(
            @PathVariable String sessionId,
            @RequestParam(name = "afterSequence", defaultValue = "0") Long afterSequence,
            @RequestParam(name = "branchId", required = false) String branchId,
            @RequestParam(name = "runId", required = false) String runId) {
        if (!verifyAccess(sessionId)) {
            return forbidden();
        }
        ObjectNode snapshot = contextService.getSnapshot(
                sessionId, resolveWorkspaceId(sessionId), resolveUserId(sessionId), afterSequence,
                branchId, runId);
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
        String status = sourceRefreshService.refresh(
                sessionId, resolveWorkspaceId(sessionId), resolveUserId(sessionId));
        return ResponseEntity.ok(Map.of(
                "status", status,
                "sourceKey", "AGENTS.md"));
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

    /**
     * PLAN-0410 T2.2 (field-matrix §6): manual compaction accepts the
     * CP-validated {@code branchId} — the whole flow (input projection,
     * prior summary, recovery band, written events) stays on that branch path.
     */
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
        Object rawBranchId = body.get("branchId");
        String branchId = rawBranchId == null ? null : String.valueOf(rawBranchId).trim();
        if (branchId != null && branchId.isEmpty()) {
            branchId = null;
        }
        var event = contextService.compact(
                sessionId, resolveWorkspaceId(sessionId), resolveUserId(sessionId), upToSequence,
                "auto", null, branchId);
        return ResponseEntity.ok(Map.of(
                "sequence", event.getSequence(),
                "eventType", event.getEventType(),
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
                .findByIdWorkspaceIdAndIdUserId(UUID.fromString(workspaceId), UUID.fromString(userId))
                .isPresent();
    }

    private String resolveUserId(String sessionId) {
        String tokenUserId = TenantContext.getUserId();
        if (tokenUserId != null) return tokenUserId;
        // Internal service calls carry no JWT; resolve from the Session row.
        // No implicit default: unknown session means no user context.
        return sessionRepository.findById(UUID.fromString(sessionId)).map(s -> s.getUserId()).orElse(null);
    }

    private String resolveWorkspaceId(String sessionId) {
        String tokenWorkspaceId = TenantContext.getWorkspaceId();
        if (tokenWorkspaceId != null) return tokenWorkspaceId;
        // No silent "default" workspace fallback; unknown session fails access check.
        return sessionRepository.findById(UUID.fromString(sessionId)).map(s -> s.getWorkspaceId()).orElse(null);
    }

    private ResponseEntity<?> forbidden() {
        return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", "Access denied");
    }
}
