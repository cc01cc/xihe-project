package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/sessions")
public class SessionController {

    private final SessionService sessionService;
    private final ContextService contextService;

    public SessionController(SessionService sessionService, ContextService contextService) {
        this.sessionService = sessionService;
        this.contextService = contextService;
    }

    @GetMapping
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> list() {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        List<Map<String, Object>> sessions = sessionService.list(userId, workspaceId).stream()
                .map(SessionController::toSummary)
                .toList();
        return ResponseEntity.ok(Map.of("sessions", sessions));
    }

    // PLAN-294 decision #15: user-facing manual compaction. The context
    // controller exposes the same operation on /internal/v1 (service-only);
    // this is the browser-reachable entry with USER ownership checks.
    @PostMapping("/{sessionId}/compact")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> compact(@PathVariable String sessionId,
                                     @RequestBody(required = false) Map<String, Object> body) {
        Session session = sessionService.requireCurrent(sessionId, TenantContext.getUserId(), TenantContext.getWorkspaceId());
        Long upToSequence = body != null && body.get("upToSequence") != null
                ? Long.valueOf(body.get("upToSequence").toString())
                : null;
        var event = contextService.compact(
                sessionId, session.getWorkspaceId(), session.getUserId(), upToSequence);
        return ResponseEntity.ok(Map.of(
                "sequence", event.getSequence(),
                "eventType", event.getEventType(),
                "created_at", event.getCreatedAt().toString()
        ));
    }

    @GetMapping("/{sessionId}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> get(@PathVariable String sessionId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        try {
            return ResponseEntity.ok(toView(sessionService.requireCurrent(sessionId, userId, workspaceId)));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PostMapping
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> create(@RequestBody(required = false) CreateSessionRequest request) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        try {
            String title = request == null ? null : request.title();
            String providerConnectionId = request == null ? null : request.providerConnectionId();
            Session session = sessionService.create(userId, workspaceId, title, null, null, providerConnectionId);
            return ResponseEntity.status(HttpStatus.CREATED).body(toView(session));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @PatchMapping("/{sessionId}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> update(
            @PathVariable String sessionId,
            @RequestBody(required = false) UpdateSessionRequest request) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        try {
            String title = request == null ? null : request.title();
            String modelProvider = request == null ? null : request.modelProvider();
            String modelName = request == null ? null : request.modelName();
            String providerConnectionId = request == null ? null : request.providerConnectionId();
            Session session = sessionService.update(sessionId, userId, workspaceId,
                    title, modelProvider, modelName, providerConnectionId);
            return ResponseEntity.ok(toView(session));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    @DeleteMapping("/{sessionId}")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> delete(@PathVariable String sessionId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        try {
            sessionService.delete(sessionId, userId, workspaceId);
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    private static Map<String, Object> toView(Session session) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", session.getId());
        view.put("workspaceId", session.getWorkspaceId());
        view.put("title", session.getTitle());
        view.put("modelProvider", session.getModelProvider());
        view.put("modelName", session.getModelName());
        view.put("providerConnectionId", session.getProviderConnectionId());
        view.put("connectionRevision", session.getConnectionRevision());
        view.put("archived", session.isArchived());
        view.put("createdAt", session.getCreatedAt() == null ? null : session.getCreatedAt().toString());
        view.put("updatedAt", session.getUpdatedAt() == null ? null : session.getUpdatedAt().toString());
        return view;
    }

    private static Map<String, Object> toSummary(Session session) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", session.getId());
        view.put("title", session.getTitle());
        // WorkspaceView uses the list projection to select an existing session
        // when entering a workspace. Omitting this field makes direct workspace
        // navigation create a duplicate session.
        view.put("workspaceId", session.getWorkspaceId());
        return view;
    }

    public record CreateSessionRequest(String title, String modelProvider, String modelName,
                                       String providerConnectionId) {}
    public record UpdateSessionRequest(String title, String modelProvider, String modelName,
                                       String providerConnectionId) {}
}
