package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.context.service.ContextService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.service.ContextTemplateService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/sessions")
public class SessionController {

    private static final Logger logger = LoggerFactory.getLogger(SessionController.class);

    /** PLAN-0352 决策 #2：删除路径等待终态投递的上界 N=2s。 */
    private static final Duration SESSION_DELETE_SSE_WAIT = Duration.ofSeconds(2);

    private final SessionService sessionService;
    private final SessionForkService sessionForkService;
    private final com.cc01cc.p.xihe.cp.service.SessionDerivedStateService derivedStateService;
    private final ContextService contextService;
    private final ChatController chatController;
    private final ChatRunCancellationService chatRunCancellationService;
    private final SseEmitterManager sseEmitterManager;
    private final com.cc01cc.p.xihe.cp.operation.JobScopeClosureService jobScopeClosureService;

    public SessionController(SessionService sessionService,
                             SessionForkService sessionForkService,
                             com.cc01cc.p.xihe.cp.service.SessionDerivedStateService derivedStateService,
                             ContextService contextService,
                             ChatController chatController,
                             ChatRunCancellationService chatRunCancellationService,
                             SseEmitterManager sseEmitterManager,
                             com.cc01cc.p.xihe.cp.operation.JobScopeClosureService jobScopeClosureService) {
        this.sessionService = sessionService;
        this.sessionForkService = sessionForkService;
        this.derivedStateService = derivedStateService;
        this.contextService = contextService;
        this.chatController = chatController;
        this.chatRunCancellationService = chatRunCancellationService;
        this.sseEmitterManager = sseEmitterManager;
        this.jobScopeClosureService = jobScopeClosureService;
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

    @PostMapping("/{sessionId}/fork")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> fork(@PathVariable String sessionId,
                                  @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
                                  @RequestBody(required = false) ForkRequest request) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (request == null
                || request.sourceBranchId() == null || request.sourceBranchId().isBlank()
                || request.anchorMessageId() == null || request.anchorMessageId().isBlank()) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "sourceBranchId and anchorMessageId are required");
        }
        try {
            SessionForkService.ForkResult result = sessionForkService.fork(
                    sessionId, userId, workspaceId,
                    request.sourceBranchId(), request.anchorMessageId(), idempotencyKey);
            String childId = result.session().getId().toString();
            HttpStatus success = result.replayed() ? HttpStatus.OK : HttpStatus.CREATED;
            return ResponseEntity.status(success)
                    .location(URI.create("/api/v1/sessions/" + childId))
                    .body(toForkView(result.session()));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    // PLAN-294 decision #15: user-facing manual compaction. The context
    // controller exposes the same operation on /internal/v1 (service-only);
    // this is the browser-reachable entry with USER ownership checks.
    @PostMapping("/{sessionId}/compact")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> compact(@PathVariable String sessionId,
                                     @RequestBody(required = false) Map<String, Object> body) {
        Session session = sessionService.requireCurrent(sessionId, TenantContext.getUserId(), TenantContext.getWorkspaceId());
        Object rawBranchId = body == null ? null : body.get("branchId");
        if (!(rawBranchId instanceof String branchValue) || branchValue.isBlank()) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "branchId is required");
        }
        String branchId;
        try {
            branchId = UUID.fromString(branchValue).toString();
        } catch (IllegalArgumentException invalidBranchId) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "branchId must be a UUID");
        }
        // PLAN-294 D.4-8 (decision #15/#18): a manual compaction must not
        // tear context out from under an active run (appendix E.4 "no tools
        // in flight during compaction").
        if (chatController.activeRunId(sessionId) != null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.CONFLICT, "BRANCH_LOCK",
                    "A chat run is already active for this session; compaction is deferred until it finishes");
        }
        Long upToSequence = null;
        if (body != null && body.get("upToSequence") != null) {
            try {
                upToSequence = Long.valueOf(body.get("upToSequence").toString());
                if (upToSequence < 0) {
                    throw new NumberFormatException("negative cursor");
                }
            } catch (NumberFormatException invalidCursor) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "upToSequence must be a non-negative integer");
            }
        }
        var event = contextService.compact(
                sessionId, session.getWorkspaceId(), session.getUserId(), upToSequence,
                "manual", null, branchId);
        return ResponseEntity.ok(Map.of(
                "sequence", event.getSequence(),
                "eventType", event.getEventType(),
                "createdAt", event.getCreatedAt().toString()
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

    @GetMapping("/{sessionId}/derived-state")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> derivedState(@PathVariable String sessionId) {
        try {
            UUID.fromString(sessionId);
        } catch (IllegalArgumentException invalidSessionId) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.NOT_FOUND, "SESSION_NOT_FOUND", "Session not found");
        }
        try {
            Session parent = sessionService.requireCurrent(
                    sessionId, TenantContext.getUserId(), TenantContext.getWorkspaceId());
            return ResponseEntity.ok(derivedStateService.project(parent));
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
            String modelProvider = request == null ? null : request.modelProvider();
            String modelName = request == null ? null : request.modelName();
            String providerConnectionId = request == null ? null : request.providerConnectionId();
            String agentPrincipalId = request == null ? null : request.agentPrincipalId();
            ContextTemplateService.TemplateSelection templateSelection = templateSelection(request);
            Session session = sessionService.createAgentSession(userId, workspaceId, title,
                    modelProvider, modelName, providerConnectionId, agentPrincipalId, templateSelection);
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

    @PatchMapping("/{sessionId}/context-template")
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    public ResponseEntity<?> updateContextTemplate(@PathVariable String sessionId,
                                                   @RequestBody ContextTemplateBindingRequest request) {
        try {
            if (request == null || request.layer() == null || request.templateId() == null
                    || request.version() == null) {
                throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                        "layer, templateId and version are required");
            }
            Session session = sessionService.updateContextTemplate(sessionId, TenantContext.getUserId(),
                    TenantContext.getWorkspaceId(), request.layer(), request.templateId(), request.version());
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
            // PLAN-0352 LIF-1（决策 #1/#2/#3）：授权校验 → 删除事务外取消在飞 run +
            // 有界等待终态投递 → 删除事务 → 成功后 complete（删除失败保留连接）。
            // Reject an already-copying fork before cancellation has any side effect,
            // and record the durable delete intent (PLAN-0409 design #22, V47) in the
            // same short lock: later fork claims/mutations get SESSION_DELETING, so the
            // lock-free cancellation window below can no longer race a fork claim.
            // Re-entrant: a retried DELETE resumes from here; the intent has no undo.
            sessionService.beginDeleteIntent(sessionId, userId, workspaceId);
            List<String> inFlightRuns = chatRunCancellationService.cancelInFlightForSession(
                    sessionId, userId, workspaceId, "session_deleted");
            chatRunCancellationService.awaitTerminalDelivery(
                    sessionId, inFlightRuns, SESSION_DELETE_SSE_WAIT);
            // PLAN-0390 T1.3：session 硬删前关闭 scope=session 的 active Job。
            // Close Session-scoped Jobs before deleting the owner Session; purge
            // Session-owned MCP invocations as part of the same deletion lifecycle.
            // Session-scoped Jobs must not outlive their Session.
            try {
                jobScopeClosureService.closeSessionScope(sessionId);
            } catch (RuntimeException e) {
                logger.warn("[LIFECYCLE] service=cp event=job_scope_session_close_failed sessionId={} error={}",
                        sessionId, e.getMessage());
            }
            sessionService.delete(sessionId, userId, workspaceId);
            sseEmitterManager.complete(sessionId);
            logger.info("[LIFECYCLE] service=cp event=session_deleted sessionId={} inFlightRuns={} outcome=ok",
                    sessionId, inFlightRuns.size());
            return ResponseEntity.noContent().build();
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=session_delete_failed sessionId={} error={}",
                    sessionId, e.getMessage(), e);
            throw e;
        }
    }

    private static Map<String, Object> toView(Session session) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", session.getId());
        view.put("workspaceId", session.getWorkspaceId());
        view.put("agentPrincipalId", session.getAgentPrincipalId());
        view.put("title", session.getTitle());
        view.put("modelProvider", session.getModelProvider());
        view.put("modelName", session.getModelName());
        view.put("providerConnectionId", session.getProviderConnectionId());
        view.put("connectionRevision", session.getConnectionRevision());
        view.put("contextTemplateLayer", session.getContextTemplateLayer());
        view.put("contextTemplateId", session.getContextTemplateId());
        view.put("contextTemplateVersion", session.getContextTemplateVersion());
        view.put("archived", session.isArchived());
        view.put("createdAt", session.getCreatedAt() == null ? null : session.getCreatedAt().toString());
        view.put("updatedAt", session.getUpdatedAt() == null ? null : session.getUpdatedAt().toString());
        return view;
    }

    private static Map<String, Object> toForkView(Session session) {
        Map<String, Object> view = toView(session);
        view.put("kind", session.getKind());
        view.put("spawnedFromSessionId", session.getSpawnedFromSessionId());
        view.put("spawnedFromRunId", session.getSpawnedFromRunId());
        view.put("spawnedAt", session.getSpawnedAt() == null ? null : session.getSpawnedAt().toString());
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
        view.put("agentPrincipalId", session.getAgentPrincipalId());
        view.put("contextTemplateLayer", session.getContextTemplateLayer());
        view.put("contextTemplateId", session.getContextTemplateId());
        view.put("contextTemplateVersion", session.getContextTemplateVersion());
        return view;
    }

    public record CreateSessionRequest(String title, String modelProvider, String modelName,
                                       String providerConnectionId, String agentPrincipalId,
                                       String contextTemplateLayer, String contextTemplateId,
                                       Integer contextTemplateVersion) {}
    public record ContextTemplateBindingRequest(String layer, String templateId, Integer version) {}
    public record ForkRequest(String sourceBranchId, String anchorMessageId) {}
    public record UpdateSessionRequest(String title, String modelProvider, String modelName,
                                       String providerConnectionId) {}

    private static ContextTemplateService.TemplateSelection templateSelection(CreateSessionRequest request) {
        if (request == null) return null;
        boolean any = request.contextTemplateLayer() != null || request.contextTemplateId() != null
                || request.contextTemplateVersion() != null;
        if (!any) return null;
        if (request.contextTemplateLayer() == null || request.contextTemplateId() == null
                || request.contextTemplateVersion() == null) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "contextTemplateLayer, contextTemplateId and contextTemplateVersion must be provided together");
        }
        return new ContextTemplateService.TemplateSelection(request.contextTemplateLayer(),
                request.contextTemplateId(), request.contextTemplateVersion());
    }
}
