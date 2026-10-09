package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.status.HealthMonitor;
import com.cc01cc.p.xihe.cp.status.RequestQueue;
import com.cc01cc.p.xihe.cp.status.CircuitBreaker;
import com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService;
import com.cc01cc.p.xihe.cp.files.ChatAttachmentService;
import com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.EventListener;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

@RestController
public class ChatController {

    private static final Logger logger = LoggerFactory.getLogger(ChatController.class);
    private static final String FOLLOW_UP_DISPATCH_RESERVATION_PREFIX = "follow-up-dispatch:";

    private final HttpClient agentHttpClient;
    private final ObjectMapper objectMapper;
    private final SseEmitterManager sseManager;
    private final ApprovalService approvalService;
    private final com.cc01cc.p.xihe.cp.context.service.ContextService contextService;
    private final ChatSubmissionService chatSubmissionService;
    private final FollowUpQueueService followUpQueueService;
    private final SessionService sessionService;
    private final AgentPrincipalService agentPrincipalService;
    private final MessageRepository messageRepository;
    private final ChatRunRepository chatRunRepository;
    private final ChatAttachmentService chatAttachmentService;
    private final HealthMonitor healthMonitor;
    private final RequestQueue requestQueue;
    private final ProviderCredentialLeaseService credentialLeases;
    private final ConfigService configService;
    private final com.cc01cc.p.xihe.cp.mcp.McpRelayToolRecorder mcpRelayToolRecorder;
    private final com.cc01cc.p.xihe.cp.mcp.McpToolTimeoutService mcpToolTimeoutService;
    private final com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy toolTimeoutPolicy;
    private final ChatRunCancellationService chatRunCancellationService;
    private final ChatRunTerminalService chatRunTerminalService;
    private final ChatRunReadService chatRunReadService;
    private final MessageReadService messageReadService;
    private final com.cc01cc.p.xihe.cp.context.service.ContextSourceRefreshService contextSourceRefreshService;
    private final com.cc01cc.p.xihe.cp.usage.UsageCostMapper usageCostMapper;
    private final com.cc01cc.p.xihe.cp.service.ContextTemplateSourceService contextTemplateSourceService;
    private final ApplicationEventPublisher eventPublisher;
    private final ChatActiveRunRegistry activeRunRegistry;

    private static final java.time.Duration LEASE_TTL = java.time.Duration.ofMinutes(10);
    private static final String INSTANCE_ID = UUID.randomUUID().toString();

    /**
     * PLAN-0328 M2 W3: statuses whose transition ends the Run and therefore must
     * pass through the single ChatRunTerminalService owner.
     */
    private static final List<String> TERMINAL_RUN_STATUSES = List.of(
            "succeeded", "failed", "partial", "ambiguous", "cancelled");

    /**
     * PLAN-0307 T2.7 (decision #3): domains with per-run Agent consumers, delivered
     * as payload overrides. rag/embedding are process-level consumers covered by the
     * workspace-bound effective pull; instance-only domains stay pull-only.
     */
    private static final List<String> AGENT_RUN_OVERRIDE_DOMAINS =
        List.of("llm-provider", "agent-profile", "embedding", "rag", "agent-runtime",
                "context-policy");

    @Value("${cp.agent-url:http://localhost:12632/chat}")
    private String agentUrl;

    @Value("${cp.agent-api-token:dev-token-not-secure}")
    private String agentApiToken;

    public ChatController(
            ObjectMapper objectMapper,
            SseEmitterManager sseManager,
            ApprovalService approvalService,
            com.cc01cc.p.xihe.cp.context.service.ContextService contextService,
            ChatSubmissionService chatSubmissionService,
            FollowUpQueueService followUpQueueService,
            SessionService sessionService,
            AgentPrincipalService agentPrincipalService,
            MessageRepository messageRepository,
            ChatRunRepository chatRunRepository,
            ChatAttachmentService chatAttachmentService,
            ChatActiveRunRegistry activeRunRegistry,
            HealthMonitor healthMonitor,
            RequestQueue requestQueue,
            ProviderCredentialLeaseService credentialLeases,
            ConfigService configService,
            com.cc01cc.p.xihe.cp.mcp.McpRelayToolRecorder mcpRelayToolRecorder,
            com.cc01cc.p.xihe.cp.mcp.McpToolTimeoutService mcpToolTimeoutService,
            com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy toolTimeoutPolicy,
            ChatRunCancellationService chatRunCancellationService,
            ChatRunTerminalService chatRunTerminalService,
            ChatRunReadService chatRunReadService,
            MessageReadService messageReadService,
             com.cc01cc.p.xihe.cp.context.service.ContextSourceRefreshService contextSourceRefreshService,
              com.cc01cc.p.xihe.cp.usage.UsageCostMapper usageCostMapper,
              com.cc01cc.p.xihe.cp.service.ContextTemplateSourceService contextTemplateSourceService,
              ApplicationEventPublisher eventPublisher) {
        this.agentHttpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        this.objectMapper = objectMapper;
        this.sseManager = sseManager;
        this.approvalService = approvalService;
        this.contextService = contextService;
        this.chatSubmissionService = chatSubmissionService;
        this.followUpQueueService = followUpQueueService;
        this.sessionService = sessionService;
        this.agentPrincipalService = agentPrincipalService;
        this.messageRepository = messageRepository;
        this.chatRunRepository = chatRunRepository;
        this.chatAttachmentService = chatAttachmentService;
        this.activeRunRegistry = activeRunRegistry;
        this.healthMonitor = healthMonitor;
        this.requestQueue = requestQueue;
        this.credentialLeases = credentialLeases;
        this.configService = configService;
        this.mcpRelayToolRecorder = mcpRelayToolRecorder;
        this.mcpToolTimeoutService = mcpToolTimeoutService;
        this.toolTimeoutPolicy = toolTimeoutPolicy;
        this.chatRunCancellationService = chatRunCancellationService;
        this.chatRunTerminalService = chatRunTerminalService;
        this.chatRunReadService = chatRunReadService;
        this.messageReadService = messageReadService;
        this.contextSourceRefreshService = contextSourceRefreshService;
        this.usageCostMapper = usageCostMapper;
        this.contextTemplateSourceService = contextTemplateSourceService;
        this.eventPublisher = eventPublisher;

        // Wire drain callback: when agent recovers, drain queued requests
        healthMonitor.setOnServiceRecovered(serviceName -> {
            if ("agent".equals(serviceName)) {
                requestQueue.drain(req -> {
                    String requestId = nonBlankOrGenerated(req.requestId());
                    String runId = nonBlankOrGenerated(req.runId());
                    if (!acquireRun(req.sessionId(), runId)
                            || !acquireLeaseForExistingRun(runId)) {
                        logger.warn("[LIFECYCLE] service=cp event=chat_sse_rejected requestId={} sessionId={} runId={} errorCode=CHAT_IN_PROGRESS",
                                requestId, req.sessionId(), runId);
                        markQueuedRequestFailed(req, requestId, "CHAT_IN_PROGRESS", "A chat run is already active for this session");
                        return;
                    }
                    logger.info("[LIFECYCLE] service=cp event=requestRedelivered requestId={} sessionId={} runId={} outcome=accepted",
                            requestId, req.sessionId(), runId);
                    execAsync(req.sessionId(), req.content(), req.provider(), req.model(), req.toolMode(),
                            req.toolTimeouts(), req.attachments(),
                            req.userId(), req.workspaceId(), requestId, runId);
                }, req -> markQueuedRequestFailed(
                        req,
                        nonBlankOrGenerated(req.requestId()),
                        "AGENT_UNAVAILABLE",
                        "Queued chat request could not be delivered"));
            }
        });
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/sessions/{sessionId}/follow-ups")
    public ResponseEntity<FollowUpQueueSnapshot> getFollowUpQueue(@PathVariable String sessionId) {
        return ResponseEntity.ok(followUpQueueService.snapshot(
                sessionId, TenantContext.getUserId(), TenantContext.getWorkspaceId()));
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @DeleteMapping("/api/v1/sessions/{sessionId}/follow-ups/{itemId}")
    public ResponseEntity<FollowUpQueueSnapshot> withdrawFollowUp(
            @PathVariable String sessionId, @PathVariable UUID itemId) {
        return ResponseEntity.ok(followUpQueueService.withdraw(
                sessionId, TenantContext.getUserId(), TenantContext.getWorkspaceId(), itemId));
    }

    @EventListener
    void onFollowUpQueueWakeup(FollowUpQueueWakeupEvent event) {
        // Reserve the local single-flight slot across the Session-locked DB admission.
        String reservationId = FOLLOW_UP_DISPATCH_RESERVATION_PREFIX + UUID.randomUUID();
        if (activeRunRegistry.putIfAbsent(event.sessionId(), reservationId) != null) {
            return;
        }
        boolean retryAdmission = false;
        try {
            followUpQueueService.admitHead(event.sessionId(), admission -> {
                Session session = admission.session();
                com.cc01cc.p.xihe.cp.entity.SessionFollowUpItem item = admission.item();
                Map<String, Integer> timeouts = objectMapper.convertValue(item.getToolTimeouts(),
                        new TypeReference<LinkedHashMap<String, Integer>>() {});
                String provider = session.getProviderConnectionId() == null
                        ? item.getProvider() : session.getModelProvider();
                String model = session.getProviderConnectionId() == null
                        ? item.getModel() : session.getModelName();
                String principalId = session.getAgentPrincipalId();
                String branchId = item.getBranchId().toString();
                String requestHash = ChatRequestHash.calculate(objectMapper, item.getContent(), provider, model,
                        item.getToolMode(), admission.attachments().fileIds(), timeouts, principalId, branchId);
                List<Map<String, Object>> attachmentRefs = new ArrayList<>();
                for (AttachmentInfo attachment : admission.attachments().references()) {
                    Map<String, Object> ref = new LinkedHashMap<>();
                    ref.put("fileId", attachment.getId());
                    ref.put("name", attachment.getName());
                    ref.put("type", attachment.getType());
                    ref.put("size", attachment.getSize());
                    attachmentRefs.add(ref);
                }
                String attachmentsJson;
                try {
                    attachmentsJson = objectMapper.writeValueAsString(attachmentRefs);
                } catch (Exception e) {
                    throw new IllegalStateException("Unable to serialize admitted Follow-up attachments", e);
                }
                String runId = UUID.randomUUID().toString();
                ChatSubmissionService.Submission created = chatSubmissionService.createFollowUp(
                        runId, event.sessionId(), session.getUserId(), session.getWorkspaceId(), branchId,
                        item.getIdempotencyKey(), requestHash, provider, model, item.getToolMode(),
                        session.getProviderConnectionId(), session.getConnectionRevision(), instanceId(),
                        UUID.randomUUID().toString(), item.getContent(), attachmentsJson,
                        admission.attachments().fileIds(), principalId);
                return new FollowUpQueueService.ChildAdmission(
                        created.run().getId(), created.userMessage().getId());
            });
        } catch (Exception e) {
            logger.error("[LIFECYCLE] service=cp event=follow_up_queue_dispatch_failed "
                            + "sessionId={} retryAttempt={} failureType={}",
                    event.sessionId(), event.retryAttempt(), e.getClass().getSimpleName(), e);
            retryAdmission = true;
        } finally {
            activeRunRegistry.remove(event.sessionId(), reservationId);
        }
        if (retryAdmission) {
            followUpQueueService.scheduleAdmissionRetry(event);
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/sessions/{sessionId}/follow-ups")
    public ResponseEntity<FollowUpQueueSnapshot> enqueueFollowUp(
            @PathVariable String sessionId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @RequestBody FollowUpCreateRequest request) {
        FollowUpQueueService.EnqueueResult result = followUpQueueService.enqueue(
                sessionId, TenantContext.getUserId(), TenantContext.getWorkspaceId(),
                idempotencyKey == null ? null : idempotencyKey.trim(), request);
        return ResponseEntity.status(result.replayed() ? HttpStatus.OK : HttpStatus.ACCEPTED)
                .body(result.snapshot());
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/sessions/{sessionId}/follow-ups/continue")
    public ResponseEntity<FollowUpQueueSnapshot> continueFollowUpQueue(@PathVariable String sessionId) {
        FollowUpQueueService.ContinueResult result = followUpQueueService.continueQueue(
                sessionId, TenantContext.getUserId(), TenantContext.getWorkspaceId());
        return ResponseEntity.status(result.changed() ? HttpStatus.ACCEPTED : HttpStatus.OK)
                .body(result.snapshot());
    }

    @EventListener
    void onFollowUpChildAdmitted(FollowUpChildAdmittedEvent event) {
        String runId = event.childRunId();
        ChatRunReadService.DispatchRun run = chatRunReadService.findDispatchRun(runId).orElse(null);
        if (run == null) {
            logger.error("[LIFECYCLE] service=cp event=follow_up_child_dispatch_failed sessionId={} runId={} reason=run_missing",
                    event.sessionId(), runId);
            return;
        }
        try {
            MessageReadService.DispatchMessage message = messageReadService.findDispatchMessage(run.userMessageId())
                    .orElseThrow(() -> new IllegalStateException("Admitted Follow-up Message is missing"));
            List<com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo> attachments =
                    resolveAdmittedAttachments(message.attachments());
            String localRun = activeRunRegistry.get(event.sessionId());
            boolean ownsReservation = localRun != null
                    && localRun.startsWith(FOLLOW_UP_DISPATCH_RESERVATION_PREFIX)
                    && activeRunRegistry.replace(event.sessionId(), localRun, runId);
            if (!ownsReservation && runId.equals(localRun)) {
                return;
            }
            if (!ownsReservation && !acquireRun(event.sessionId(), runId)) {
                failFollowUpDispatch(event.sessionId(), runId);
                return;
            }
            logger.info("[LIFECYCLE] service=cp event=follow_up_child_dispatch_started sessionId={} runId={} queueItemId={} attachments={}",
                    event.sessionId(), runId, event.queueItemId(), attachments.size());
            execAsync(event.sessionId(), message.content(), run.provider(), run.model(), run.toolMode(),
                    event.toolTimeouts(), attachments, run.userId(), run.workspaceId(),
                    UUID.randomUUID().toString(), runId);
        } catch (Exception e) {
            logger.error("[LIFECYCLE] service=cp event=follow_up_child_dispatch_failed sessionId={} runId={} failureType={}",
                    event.sessionId(), runId, e.getClass().getSimpleName(), e);
            failFollowUpDispatch(event.sessionId(), runId);
        }
    }

    private List<com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo> resolveAdmittedAttachments(String attachmentsJson)
            throws java.io.IOException {
        return chatAttachmentService.resolveAdmittedMessageAttachments(attachmentsJson);
    }

    private void failFollowUpDispatch(String sessionId, String runId) {
        try {
            chatRunTerminalService.terminalize(new ChatRunTerminalService.TerminalRequest(
                    runId, List.of("accepted"), "ambiguous", "ambiguous", "FOLLOW_UP_DISPATCH_FAILED",
                    "The admitted Follow-up could not be dispatched; it will not be replayed",
                    0, 0, ChatRunTerminalService.TerminalSource.RECONCILIATION, List.of()));
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=follow_up_dispatch_failure_terminalization_failed sessionId={} runId={} failureType={}",
                    sessionId, runId, e.getClass().getSimpleName(), e);
        } finally {
            releaseRun(sessionId, runId, "follow_up_dispatch_failed");
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping(path = "/api/v1/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@RequestParam(name = "sessionId") String sessionId) {
        if (sessionId == null || sessionId.isBlank()) {
            throw new com.cc01cc.p.xihe.cp.config.CpApiException(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "sessionId is required");
        }
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            throw new com.cc01cc.p.xihe.cp.config.CpApiException(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        sessionService.requireCurrent(sessionId, userId, workspaceId);
        SseEmitter emitter = sseManager.createEmitter(sessionId);
        sseManager.send(sessionId, "connected", Map.of("sessionId", sessionId, "type", "connected"));
        for (Map<String, Object> approval : approvalService.replayPending(sessionId, userId, workspaceId)) {
            sseManager.send(sessionId, "approval_request", approval);
        }
        logger.info("[LIFECYCLE] service=cp event=chat_sse_connected requestId={} sessionId={} workspaceId={} connectionGeneration={} outcome=ok",
                currentRequestId(), sessionId, workspaceId, sseManager.connectionGeneration(sessionId));
        return emitter;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/chat")
    public ResponseEntity<Map<String, Object>> chat(
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyHeader,
            @RequestBody Map<String, Object> request) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        String sessionId = (String) request.get("sessionId");
        if (sessionId == null || sessionId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "sessionId is required");
        }
        Object rawBranchId = request.get("branchId");
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
        String content = (String) request.getOrDefault("content", "");
        Object rawPrincipalId = request.get("agentPrincipalId");
        if (rawPrincipalId != null && !(rawPrincipalId instanceof String)) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST,
                    "INVALID_REQUEST", "agentPrincipalId must be a UUID string");
        }
        String agentPrincipalId = (String) rawPrincipalId;
        String provider = (String) request.get("provider");
        String model = (String) request.get("model");
        String toolMode = (String) request.getOrDefault("toolMode", "none");
        // PLAN-0308 M1 T1.9（决策 #28/#29，spec S2.2 规则 6）：run 请求可携带 per-tool 超时
        // （per-call，最高优先输入）。非法/超上限 → 400 拒绝并署名，不静默截断。
        com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy.PerCallMap perCallTimeouts =
                toolTimeoutPolicy.validatePerCallMap(request.get("toolTimeouts"));
        if (!perCallTimeouts.valid()) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", perCallTimeouts.error());
        }
        String idempotencyKey = idempotencyHeader == null || idempotencyHeader.isBlank()
                ? UUID.randomUUID().toString()
                : idempotencyHeader.trim();
        if (idempotencyKey.length() > 128) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Idempotency-Key exceeds 128 characters");
        }

        try {
            sessionService.requireWorkspace(userId, workspaceId);
        } catch (com.cc01cc.p.xihe.cp.config.CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }

        String requestId = currentRequestId();
        String runId = UUID.randomUUID().toString();
        if (!sseManager.hasEmitter(sessionId)) {
            logger.warn("[LIFECYCLE] service=cp event=chat_sse_rejected requestId={} sessionId={} runId={} errorCode=SSE_SUBSCRIPTION_REQUIRED",
                    requestId, sessionId, runId);
            return ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT, "SSE_SUBSCRIPTION_REQUIRED", "An active SSE subscription is required");
        }

        // Circuit breaker check
        CircuitBreaker agentBreaker = healthMonitor.getAgentBreaker();
        if (!agentBreaker.allowRequest()) {
            logger.warn("[LIFECYCLE] service=cp event=chat_run_rejected requestId={} sessionId={} runId={} errorCode=AGENT_CIRCUIT_OPEN",
                    requestId, sessionId, runId);
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .header("Retry-After", "30")
                .contentType(MediaType.parseMediaType("application/problem+json"))
                .header("X-Request-Id", requestId)
                .body(Map.of(
                    "type", "https://xihe.dev/problems/agent-circuit-open",
                    "title", "Agent service temporarily unavailable",
                    "status", 503,
                    "code", "AGENT_CIRCUIT_OPEN",
                    "detail", "Agent service is temporarily unavailable, retry after 30 seconds",
                    "requestId", requestId
                ));
        }

        // LLM readiness is separate from HTTP liveness. Do not let an
        // unknown/non-ready Agent enter the async or transport queue path.
        HealthMonitor.ServiceHealth agentHealth = healthMonitor.getAgentHealth();
        boolean transportOnlyFailure = "down".equals(agentHealth.status())
                && "ready".equals(agentHealth.llmReady());
        if (!transportOnlyFailure && !healthMonitor.isAgentLlmReady()) {
            return llmNotReadyResponse(requestId, runId, healthMonitor.getAgentLlmReady());
        }

        Session session;
        try {
            session = sessionService.requireCurrent(sessionId, userId, workspaceId);
        } catch (com.cc01cc.p.xihe.cp.config.CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        if (session.getDeleteRequestedAt() != null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.CONFLICT, "SESSION_DELETING", "Session deletion is in progress");
        }
        if (session.getProviderConnectionId() != null) {
            // A bound Session is authoritative. Do not allow the browser's display
            // hints to switch the credential or model used by this run.
            provider = session.getModelProvider();
            model = session.getModelName();
        }

        List<String> attachmentIds = extractAttachmentIds(request);
        List<AttachmentInfo> attachmentInfos;
        try {
            attachmentInfos = chatAttachmentService.resolveForChatSubmission(
                    attachmentIds, sessionId, workspaceId, userId, session.getUserId());
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }

        String attachmentsJson = null;
        if (!attachmentInfos.isEmpty()) {
            try {
                List<Map<String, Object>> refs = new ArrayList<>();
                for (AttachmentInfo info : attachmentInfos) {
                    Map<String, Object> ref = new java.util.LinkedHashMap<>();
                    ref.put("fileId", info.getId());
                    ref.put("name", info.getName());
                    ref.put("type", info.getType());
                    ref.put("size", info.getSize());
                    refs.add(ref);
                }
                attachmentsJson = objectMapper.writeValueAsString(refs);
            } catch (Exception e) {
                logger.error("Failed to serialize attachments session={}", sessionId, e);
                return ProblemDetailsHandler.problemResponse(HttpStatus.INTERNAL_SERVER_ERROR, "SERIALIZATION_FAILED", "Attachment serialization failed");
            }
        }

        String requestHash = requestHash(content, provider, model, toolMode, attachmentIds,
                perCallTimeouts.values(), agentPrincipalId, branchId);
        ChatRun existingRun = chatRunRepository
                .findByUserIdAndSessionIdAndIdempotencyKey(userId, sessionId, idempotencyKey)
                .orElse(null);
        if (existingRun != null) {
            if (!ChatRun.ORIGIN_USER_SUBMISSION.equals(existingRun.getOrigin())) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.CONFLICT,
                        "IDEMPOTENCY_KEY_CONFLICT",
                        "Idempotency-Key belongs to a derived run");
            }
            if (!requestHash.equals(existingRun.getRequestHash())) {
                return ProblemDetailsHandler.problemResponse(
                        HttpStatus.CONFLICT,
                        "IDEMPOTENCY_KEY_CONFLICT",
                        "Idempotency-Key was already used for a different request");
            }
            return ResponseEntity.accepted().body(runResponse(existingRun));
        }

        if (!acquireRun(sessionId, runId)) {
            logger.warn("[LIFECYCLE] service=cp event=chat_sse_rejected requestId={} sessionId={} runId={} errorCode=CHAT_IN_PROGRESS",
                    requestId, sessionId, runId);
            return ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT, "CHAT_IN_PROGRESS", "A chat run is already active for this session");
        }

        boolean handedOff = false;
        try {
            ChatSubmissionService.Submission submission = chatSubmissionService.create(
                    runId, sessionId, userId, workspaceId, branchId, agentPrincipalId, idempotencyKey, requestHash,
                    provider, model, toolMode, session.getProviderConnectionId(), session.getConnectionRevision(),
                    instanceId(), requestId, content, attachmentsJson, attachmentIds);
            ChatRun chatRun = submission.run();
            Message userMessage = submission.userMessage();

            if (!attachmentIds.isEmpty()) {
                logger.debug("[LIFECYCLE] service=cp event=chat_attachments_linked runId={} count={}",
                        runId, attachmentIds.size());
            }

            logger.info("[LIFECYCLE] service=cp event=chat_message_persisted requestId={} sessionId={} runId={} messageId={} attachments={}",
                    requestId, sessionId, runId, userMessage.getId(), attachmentIds.size());

            // Agent down with a previously ready LLM -> queue transport recovery.
            if (transportOnlyFailure) {
                chatRun.setStatus("queued");
                chatRunRepository.save(chatRun);
                boolean queued = requestQueue.enqueue(
                        sessionId, content, provider, model, toolMode, attachmentInfos,
                        userId, workspaceId, requestId, runId, perCallTimeouts.values());
                if (queued) {
                    logger.info("[LIFECYCLE] service=cp event=chat_run_queued requestId={} sessionId={} runId={} reason=agent_down",
                            requestId, sessionId, runId);
                    handedOff = true;
                    return ResponseEntity.accepted().body(Map.of(
                        "status", "queued",
                        "origin", chatRun.getOrigin(),
                        "sessionId", sessionId,
                        "messageId", userMessage.getId(),
                        "runId", runId,
                        "reason", "agent_down"
                    ));
                }
                chatRun.setStatus("accepted");
                chatRunRepository.save(chatRun);
            }

            execAsync(sessionId, content, provider, model, toolMode, perCallTimeouts.values(),
                    attachmentInfos, userId, workspaceId, requestId, runId);
            handedOff = true;
            return ResponseEntity.accepted().body(Map.of(
                "status", "accepted",
                "origin", chatRun.getOrigin(),
                "sessionId", sessionId,
                "messageId", userMessage.getId(),
                "runId", runId
            ));
        } finally {
            if (!handedOff) {
                releaseRun(sessionId, runId, "chat_handoff_failed");
            }
        }
    }

    // ── PLAN-292 M3 (C2): run status recovery ──────────────────────────────

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/chat/runs/{runId}")
    public ResponseEntity<Map<String, Object>> getRunStatus(@PathVariable String runId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        UUID runUuid;
        try {
            runUuid = UUID.fromString(runId);
        } catch (IllegalArgumentException e) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found");
        }
        try {
            return ResponseEntity.ok(chatRunReadService.getStatus(runUuid, runId, userId, workspaceId));
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
    }

    // ── PLAN-0464 T2.1: session-scoped run list (waiting/status read surface) ──

    /**
     * Runs of one Session with their status and spawn waiting link. This is the
     * recovery source ChatPanel uses after a refresh: the child run row itself
     * carries {@code waitingOnRunId}/{@code waitingToolCallId}, so no Operation
     * read is involved.
     */
    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping("/api/v1/chat/sessions/{sessionId}/runs")
    public ResponseEntity<Map<String, Object>> listSessionRuns(
            @PathVariable String sessionId,
            @RequestParam(name = "page", defaultValue = "0") int page,
            @RequestParam(name = "size", defaultValue = "100") int size) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED,
                    "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        Session session = sessionService.requireCurrent(sessionId, userId, workspaceId);
        int safePage = Math.max(page, 0);
        int safeSize = Math.min(Math.max(size, 1), 200);
        return ResponseEntity.ok(chatRunReadService.listSessionRuns(
                session.getId().toString(), safePage, safeSize));
    }

    // ── PLAN-275 M1 Task 1.3: Cancel contract ──────────────────────────────

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/chat/runs/{runId}/cancel")
    public ResponseEntity<Map<String, Object>> cancelRun(
            @PathVariable String runId,
            @RequestBody(required = false) Map<String, Object> request) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }

        String reason = request != null ? (String) request.getOrDefault("reason", "user_requested") : "user_requested";
        // PLAN-0407 T2.5：序列化认领（条件更新，与 spawn 的 parent Run 行锁同一行）
        // → 认领获胜者收口根 run → 沿 kind=spawn 停止传播 + 有界等待。
        ChatRunCancellationService.CancelClaim claim;
        try {
            claim = chatRunCancellationService.cancelForCurrentOwner(runId, userId, workspaceId, reason);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        return switch (claim.outcome()) {
            case CLAIMED, ALREADY_CANCELLING ->
                    ResponseEntity.ok(Map.of("status", "cancel_accepted", "runId", runId));
            case NOT_CANCELLABLE ->
                    ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT, "RUN_NOT_CANCELLABLE",
                            "Run is in terminal state: " + claim.status());
            case NOT_FOUND ->
                    ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found");
        };
    }

    @GetMapping("/api/v1/health")
    public Map<String, Object> health() {
        return Map.of(
            "status", "UP",
            "service", "xihe-control-plane",
            "timestamp", System.currentTimeMillis()
        );
    }

    @EventListener
    void onSpawnRunDispatchRequested(SpawnRunDispatchRequestedEvent event) {
        boolean dispatched = dispatchSpawnRun(event.childRunId());
        logger.info("[LIFECYCLE] service=cp event=spawn_dispatch_result parentRunId={} childRunId={} dispatched={}",
                event.parentRunId(), event.childRunId(), dispatched);
    }

    /** Dispatches a committed spawn Run through the same local worker and lease path as user Runs. */
    public boolean dispatchSpawnRun(String runId) {
        ChatRunReadService.DispatchRun run = chatRunReadService.findDispatchRun(runId).orElse(null);
        if (run == null || !ChatRun.ORIGIN_SPAWN.equals(run.origin()) || !"accepted".equals(run.status())) {
            return false;
        }
        Session session;
        try {
            session = sessionService.requireCurrent(run.sessionId(), run.userId(), run.workspaceId());
        } catch (com.cc01cc.p.xihe.cp.config.CpApiException e) {
            throw new IllegalStateException("Committed spawn Session is no longer dispatchable", e);
        }
        MessageReadService.DispatchMessage userMessage = run.userMessageId() == null
                ? null : messageReadService.findDispatchMessage(run.userMessageId()).orElse(null);
        if (session == null || userMessage == null
                || !Session.KIND_SPAWN.equals(session.getKind())
                || !run.id().equals(userMessage.runId())
                || !run.sessionId().equals(userMessage.sessionId())
                || !run.userId().equals(session.getUserId())
                || !run.workspaceId().equals(session.getWorkspaceId())) {
            throw new IllegalStateException("Committed spawn Run is missing its child Session or user Message");
        }

        String sessionId = run.sessionId();
        if (activeRunRegistry.putIfAbsent(sessionId, runId) != null) {
            return false;
        }
        if (!acquireLeaseForExistingRun(runId)) {
            activeRunRegistry.remove(sessionId, runId);
            return false;
        }
        try {
            execAsync(sessionId, userMessage.content(), run.provider(), run.model(), run.toolMode(),
                    Map.of(), List.of(), run.userId(), run.workspaceId(), runId, runId);
            return true;
        } catch (RuntimeException e) {
            releaseRun(sessionId, runId, "spawn_dispatch_handoff_failed");
            throw e;
        }
    }

    private void execAsync(String sessionId, String content, String provider, String model, String toolMode,
                           Map<String, Integer> toolTimeouts,
                           List<com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo> attachments,
                           String userId, String workspaceId, String requestId, String runId) {
        Thread worker = new Thread(() -> {
            MDC.put("requestId", requestId);
            MDC.put("chatRunId", runId);
            AtomicBoolean terminalSent = new AtomicBoolean(false);
            // Set inside relayAgentStream when an approval_request has been
            // relayed; read by the IO-interrupt catch below (PLAN-292 C1).
            AtomicBoolean approvalInFlight = new AtomicBoolean(false);
            try {
                // PLAN-294 M3 (decisions #4/#18): pre-run compaction gate —
                // inside the session serialization scope (activeRunRegistry), the
                // gate compresses history before the run consumes it. Context
                // service owns the cooldown/anti-thrash rules.
                try {
                    // PLAN-0410 T2.2: the gate resolves THIS Run's branch path —
                    // sibling Run usage/summary/circuit never drive the decision.
                    if (contextService.shouldAutoCompact(sessionId, runId)) {
                        contextService.compact(sessionId, workspaceId, userId, null, "auto", runId);
                        logger.info("[LIFECYCLE] service=cp event=chat_pre_run_compaction sessionId={} runId={}", sessionId, runId);
                    }
                } catch (Exception gateError) {
                    // The gate never blocks a run: failed compaction degrades
                    // to no compaction and the overflow fallback (runner)
                    // remains the safety net.
                    logger.warn("[LIFECYCLE] service=cp event=chat_pre_run_compaction_failed sessionId={} runId={} error={}",
                            sessionId, runId, gateError.getMessage());
                }
                ChatRun persistedRun = chatRunRepository.findById(UUID.fromString(runId))
                        .orElseThrow(() -> new IllegalStateException("Chat run not found"));
                boolean refreshRootAgentsMd = shouldRefreshRootAgentsMd(persistedRun);
                // PLAN-0340/0415: the source policy is fixed by the admission
                // template. per_chat_run refreshes each turn; per_session pins
                // the first successful source snapshot for this Session.
                try {
                    String sourceStatus = contextSourceRefreshService.refreshForRun(
                            sessionId, workspaceId, userId, refreshRootAgentsMd);
                    logger.info("[LIFECYCLE] service=cp event=chat_pre_run_source_refresh sessionId={} runId={} status={}",
                            sessionId, runId, sourceStatus);
                    // PLAN-0340 U2: only AGENTS.md chain created/updated (not env, not unchanged/failed).
                    if ("created".equals(sourceStatus) || "updated".equals(sourceStatus)) {
                        sseManager.send(sessionId, "context_sources_changed", Map.of(
                                "type", "context_sources_changed",
                                "sourceKey", "AGENTS.md",
                                "status", sourceStatus));
                    }
                } catch (Exception sourceError) {
                    logger.warn("[LIFECYCLE] service=cp event=chat_pre_run_source_refresh_failed sessionId={} runId={} error={}",
                            sessionId, runId, sourceError.getMessage());
                    // Env refresh can fail while per_session L1 is deliberately
                    // frozen; only mark L1 unavailable when this Run attempted it.
                    if (refreshRootAgentsMd) {
                        contextSourceRefreshService.markSourceUnavailable(sessionId, workspaceId, userId);
                    }
                }
                transitionRun(runId, List.of("accepted", "queued"), "running", null, null, null, 0, 0);
                String effectiveProvider = persistedRun.getProvider() == null
                        ? provider : persistedRun.getProvider();
                String effectiveModel = persistedRun.getModel() == null
                        ? model : persistedRun.getModel();
                ProviderCredentialLeaseService.IssuedLease credentialLease = null;
                if (persistedRun.getProviderConnectionId() != null) {
                    credentialLease = credentialLeases.issue(
                            userId,
                            workspaceId,
                            sessionId,
                            runId,
                            persistedRun.getProviderConnectionId(),
                            effectiveProvider,
                            effectiveModel,
                            persistedRun.getConnectionRevision());
                }
                Map<String, Object> agentRequest = new java.util.LinkedHashMap<>();
                agentRequest.put("sessionId", sessionId);
                agentRequest.put("content", content);
                agentRequest.put("userId", userId);
                agentRequest.put("workspaceId", workspaceId);
                agentRequest.put("requestId", requestId);
                agentRequest.put("runId", runId);
                agentRequest.put("stream", true);
                if (effectiveProvider != null && !effectiveProvider.isBlank()) {
                    agentRequest.put("provider", effectiveProvider);
                }
                agentRequest.put("toolMode", toolMode == null || toolMode.isBlank() ? "none" : toolMode);
                if (effectiveModel != null && !effectiveModel.isEmpty()) {
                    agentRequest.put("model", effectiveModel);
                }
                if (credentialLease != null) {
                    agentRequest.put("credentialLease", credentialLease.token());
                    agentRequest.put("providerConnectionId", persistedRun.getProviderConnectionId());
                    agentRequest.put("connectionRevision", persistedRun.getConnectionRevision());
                }
                // PLAN-0415 M1: only the admission-frozen template snapshot and,
                // when present, the CP-selected model instructions cross to Agent.
                // The existing AgentChatIntegrationTest security contract keeps
                // principal IDs and permission snapshots strictly CP-local.
                Session boundSession = sessionService.requireCurrent(sessionId, userId, workspaceId);
                if (boundSession.getAgentPrincipalId() == null || boundSession.getAgentPrincipalId().isBlank()) {
                    throw new IllegalStateException("ChatRun Session is missing its AgentPrincipal binding");
                }
                agentRequest.put("contextTemplateSnapshot", persistedRun.getContextTemplateSnapshot());
                Map<String, Object> componentSources = contextTemplateSourceService.resolve(persistedRun, boundSession);
                if (!componentSources.isEmpty()) {
                    agentRequest.put("componentSources", componentSources);
                }
                String agentInstructions = agentPrincipalService.resolveSystemInstructionsForRun(
                        boundSession.getAgentPrincipalId());
                if (agentInstructions != null) {
                    agentRequest.put("instructions", agentInstructions);
                }
                // PLAN-0307 T2.7 (decision #3=#3a): run-scoped layer overrides are
                // resolved per run from this request's workspace/user context and
                // pushed with the payload; Agent merges without side effects.
                Map<String, Map<String, String>> userOverrides = configService.overrides(
                        "user", AGENT_RUN_OVERRIDE_DOMAINS,
                        uuidOrNull(userId), uuidOrNull(workspaceId));
                Map<String, Map<String, String>> workspaceOverrides = configService.overrides(
                        "workspace", AGENT_RUN_OVERRIDE_DOMAINS,
                        uuidOrNull(userId), uuidOrNull(workspaceId));
                if (!userOverrides.isEmpty()) {
                    agentRequest.put("userOverrides", userOverrides);
                }
                if (!workspaceOverrides.isEmpty()) {
                    agentRequest.put("workspaceOverrides", workspaceOverrides);
                }
                // PLAN-0308 M1（spec S2.1）：CP 计算好的等待值随 run 下发（Agent 只消费）；
                // per-call 原始值（T1.9）同批下发，供 Agent 随工具调用附带入站头。
                agentRequest.putAll(mcpToolTimeoutService.toolTimeoutPayload(workspaceId, userId, toolTimeouts));
                if (!attachments.isEmpty()) {
                    List<Map<String, Object>> agentAttachments = new ArrayList<>();
                    for (com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo info : attachments) {
                        Map<String, Object> a = new java.util.LinkedHashMap<>();
                        a.put("fileId", info.getId());
                        a.put("name", info.getName());
                        a.put("type", info.getType());
                        a.put("url", info.getUrl());
                        agentAttachments.add(a);
                    }
                    agentRequest.put("attachments", agentAttachments);
                }

                String agentRequestBody = objectMapper.writeValueAsString(agentRequest);

                // PLAN-0341 T1.1 (decision #2/#3): at-most-once overflow retry.
                // On CONTEXT_OVERFLOW: force-compact (bypass cooldown) → preflight →
                // re-dispatch the same runId before any terminal transition.
                boolean overflowRetried = false;
                StreamRelayResult relayResult;

                while (true) {
                    HttpRequest.Builder dispatchBuilder = HttpRequest.newBuilder(URI.create(agentUrl))
                        .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                        .header(HttpHeaders.ACCEPT, MediaType.TEXT_EVENT_STREAM_VALUE)
                        .header("Authorization", "Bearer " + agentApiToken)
                        .header("X-Request-Id", requestId)
                        .header("X-Chat-Run-Id", runId)
                        .header("X-User-Id", userId)
                        .header("X-Workspace-Id", workspaceId)
                        .header("X-Session-Id", sessionId);
                    if (overflowRetried) {
                        dispatchBuilder.header("X-Overflow-Retry", "1");
                    }
                    HttpRequest agentRequestMessage = dispatchBuilder
                        .timeout(Duration.ofSeconds(30))
                        .POST(HttpRequest.BodyPublishers.ofString(agentRequestBody, StandardCharsets.UTF_8))
                        .build();

                    long startMs = System.currentTimeMillis();
                    HttpResponse<InputStream> response = agentHttpClient.send(
                        agentRequestMessage,
                        HttpResponse.BodyHandlers.ofInputStream()
                    );
                    long elapsedMs = System.currentTimeMillis() - startMs;

                    if (response.statusCode() >= 400) {
                        String upstreamBody;
                        try (InputStream errorBody = response.body()) {
                            upstreamBody = new String(errorBody.readAllBytes(), StandardCharsets.UTF_8);
                        }
                        Map<?, ?> upstreamProblem = asMap(parsePayload("error", upstreamBody));
                        String upstreamCode = safeErrorCode(stringValue(upstreamProblem, "code"));
                        if ("CONTEXT_OVERFLOW".equals(upstreamCode) && !overflowRetried
                                && tryOverflowRecovery(sessionId, workspaceId, userId, requestId, runId,
                                        effectiveModel, terminalSent)) {
                            overflowRetried = true;
                            continue;
                        }
                        String detail = safeErrorDetail(upstreamCode);
                        logger.error("[LIFECYCLE] service=cp event=chat_run_failed requestId={} sessionId={} runId={} errorCode={} upstreamStatus={} durationMs={}",
                                requestId, sessionId, runId, upstreamCode, response.statusCode(), elapsedMs);
                        healthMonitor.getAgentBreaker().recordFailure();
                        sendRunErrorAndDone(sessionId, requestId, runId, upstreamCode, detail, "error", terminalSent);
                        return;
                    }

                    healthMonitor.getAgentBreaker().recordSuccess();
                    logger.info("[LIFECYCLE] service=cp event=chat_run_forwarded requestId={} sessionId={} runId={} status={} durationMs={}",
                            requestId, sessionId, runId, response.statusCode(), elapsedMs);
                    try (InputStream agentStream = response.body()) {
                        relayResult = relayAgentStream(
                                sessionId, agentStream, requestId, runId, userId, workspaceId,
                                approvalInFlight, !overflowRetried);
                    }

                    if ("CONTEXT_OVERFLOW".equals(relayResult.errorCode()) && !overflowRetried) {
                        terminalSent.set(false);
                        if (tryOverflowRecovery(sessionId, workspaceId, userId, requestId, runId,
                                effectiveModel, terminalSent)) {
                            overflowRetried = true;
                            continue;
                        }
                        logger.error("[LIFECYCLE] service=cp event=chat_run_failed requestId={} sessionId={} runId={} errorCode=CONTEXT_OVERFLOW reason=preflight_failed",
                                requestId, sessionId, runId);
                        sendRunErrorAndDone(sessionId, requestId, runId, "CONTEXT_OVERFLOW",
                                safeErrorDetail("CONTEXT_OVERFLOW"), "error", terminalSent);
                        return;
                    }
                    break;
                }

                String assistantContent = relayResult.assistantContent();
                logger.info("[LIFECYCLE] service=cp event=chat_run_finished requestId={} sessionId={} runId={} assistantChars={}",
                        requestId, sessionId, runId, assistantContent == null ? 0 : assistantContent.length());

                if (assistantContent != null && !assistantContent.isBlank()) {
                    Message assistantMessage = new Message(sessionId, MessageRole.ASSISTANT, assistantContent);
                    assistantMessage.setRunId(runId);
                    // PLAN-0410 T1.3: bind the assistant message to the durable
                    // branch of its Run before insert (root while M1 has no selector).
                    var ownerRun = chatRunRepository.findById(UUID.fromString(runId));
                    ownerRun.ifPresent(run -> assistantMessage.setBranchId(run.getBranchId()));
                    messageRepository.save(assistantMessage);
                    ownerRun.ifPresent(run -> {
                        run.setAssistantMessageId(assistantMessage.getId().toString());
                        chatRunRepository.save(run);
                    });
                    logger.info("[LIFECYCLE] service=cp event=chat_assistant_persisted requestId={} sessionId={} runId={} messageId={} assistantChars={}",
                            requestId, sessionId, runId, assistantMessage.getId(), assistantContent.length());
                }

                String outcome = relayResult.outcome();
                String status = "success".equals(outcome)
                        ? "succeeded"
                        : "partial".equals(outcome) ? "partial" : "ambiguous".equals(outcome) ? "ambiguous" : "failed";
                boolean terminalCommitted = transitionRun(
                        runId,
                        List.of("running", "streaming", "awaiting_approval"),
                        status,
                        outcome,
                        relayResult.errorCode(),
                        null,
                        relayResult.tokenCount(),
                        assistantContent == null ? 0 : assistantContent.length(),
                        relayResult.usageEnvelope());
                // PLAN-0352 V1: the session SSE must observe the terminal error/done
                // BEFORE the connection closes. Two real orders exist around session
                // delete (claim `cancelling` → settleCancellation durable `cancelled`):
                // ① settle already committed → our transition is a no-op but the events
                //    must still be delivered; ② relay ends first while the run sits in
                //    `cancelling` → the durable terminal is owned by the settle path,
                //    and our job is only client delivery. The terminalSent CAS keeps
                //    delivery emit-once in both orders.
                String currentRunStatus = runStatus(runId);
                boolean durableTerminal = terminalCommitted
                        || (currentRunStatus != null && TERMINAL_RUN_STATUSES.contains(currentRunStatus));
                boolean cancelOwnsTerminal = "cancelling".equals(currentRunStatus);
                if ((durableTerminal || cancelOwnsTerminal)
                        && terminalSent.compareAndSet(false, true)) {
                    for (RelayedTerminalEvent terminalEvent : relayResult.terminalEvents()) {
                        dispatchRelayedEvent(sessionId, terminalEvent.name(), terminalEvent.data(),
                                runId, requestId, userId, workspaceId, relayResult.runState());
                    }
                } else if (terminalCommitted) {
                    logger.warn("[LIFECYCLE] service=cp event=chat_terminal_sse_suppressed requestId={} runId={} reason=terminal_already_sent",
                            requestId, runId);
                } else {
                    logger.warn("[LIFECYCLE] service=cp event=chat_terminal_sse_suppressed requestId={} runId={} status={} reason=terminal_owner_unknown",
                            requestId, runId, currentRunStatus);
                }

            } catch (java.net.http.HttpTimeoutException e) {
                logger.warn("[LIFECYCLE] service=cp event=chat_run_failed requestId={} sessionId={} runId={} errorCode=AGENT_TIMEOUT timeoutMs=30000",
                        requestId, sessionId, runId, e);
                healthMonitor.getAgentBreaker().recordFailure();
                sendRunErrorAndDone(sessionId, requestId, runId, "AGENT_TIMEOUT", "Agent request timed out after 30 seconds", "ambiguous", terminalSent);
            } catch (java.io.IOException e) {
                // PLAN-292 C1: a relay-stream break while the Agent is waiting
                // for a user decision is recoverable, not a run failure — the
                // approval row + GET run status keep the decision reachable
                // after a reconnect. Fail the run only when no approval was
                // in flight.
                if (approvalInFlight.get()) {
                    logger.warn("[LIFECYCLE] service=cp event=chat_relay_interrupted requestId={} sessionId={} runId={} reason=approval_in_flight outcome=ambiguous",
                            requestId, sessionId, runId);
                    sendRunErrorAndDone(sessionId, requestId, runId, "AGENT_STREAM_INTERRUPTED",
                            "Connection interrupted while awaiting approval; the pending decision stays recoverable",
                            "ambiguous", terminalSent);
                } else {
                    logger.error("[LIFECYCLE] service=cp event=chat_run_failed requestId={} sessionId={} runId={} errorCode=CHAT_EXECUTION_FAILED",
                            requestId, sessionId, runId, e);
                    healthMonitor.getAgentBreaker().recordFailure();
                    sendRunErrorAndDone(sessionId, requestId, runId, "CHAT_EXECUTION_FAILED", "Chat execution failed", "error", terminalSent);
                }
            } catch (Exception e) {
                logger.error("[LIFECYCLE] service=cp event=chat_run_failed requestId={} sessionId={} runId={} errorCode=CHAT_EXECUTION_FAILED",
                        requestId, sessionId, runId, e);
                healthMonitor.getAgentBreaker().recordFailure();
                sendRunErrorAndDone(sessionId, requestId, runId, "CHAT_EXECUTION_FAILED", "Chat execution failed", "error", terminalSent);
            } finally {
                releaseRun(sessionId, runId, "run_finished");
                MDC.remove("requestId");
                MDC.remove("chatRunId");
            }
        }, "xihe-chat-" + runId);
        try {
            worker.start();
        } catch (RuntimeException e) {
            releaseRun(sessionId, runId, "worker_start_failed");
            throw e;
        }
    }

    private boolean shouldRefreshRootAgentsMd(ChatRun run) {
        com.fasterxml.jackson.databind.JsonNode snapshot = run.getContextTemplateSnapshot();
        com.fasterxml.jackson.databind.JsonNode components = snapshot == null
                ? null : snapshot.path("template").path("components");
        // Pre-template/legacy ChatRuns retain the existing per-run refresh.
        if (components == null || !components.isArray()) {
            return true;
        }
        boolean hasRootComponent = false;
        boolean hasPerSession = false;
        for (com.fasterxml.jackson.databind.JsonNode component : components) {
            if (!component.path("enabled").asBoolean(false)
                    || !"root_agents_md".equals(component.path("type").asText())) {
                continue;
            }
            hasRootComponent = true;
            String policy = component.path("config").path("refreshPolicy").asText("");
            if ("per_chat_run".equals(policy)) {
                return true;
            }
            if ("per_session".equals(policy)) {
                hasPerSession = true;
            } else {
                // Unknown persisted value fails safe toward the established
                // fresh-per-run source rather than pinning stale rules.
                return true;
            }
        }
        if (!hasRootComponent) {
            return false;
        }
        return hasPerSession && !contextSourceRefreshService.hasSuccessfulSessionL1Snapshot(run.getSessionId());
    }

    /**
     * PLAN-0341 T1.1: force-compact on overflow (bypass cooldown), emit U3,
     * then preflight. Returns true when the caller should re-dispatch.
     */
    private boolean tryOverflowRecovery(String sessionId, String workspaceId, String userId,
                                        String requestId, String runId, String model,
                                        AtomicBoolean terminalSent) {
        try {
            Long maxInputTokens = resolveMaxInputTokens(userId, workspaceId, model);
            contextService.compactForOverflow(sessionId, workspaceId, userId, runId);
            // PLAN-0410 T2.3 (matrix §4): overflow_retry is run-scoped — the
            // durable correlation lets CP derive its branch on append.
            contextService.appendEvent(sessionId, workspaceId, userId, "context.overflow_retry", Map.of(
                    "runId", runId == null ? "" : runId,
                    "requestId", requestId == null ? "" : requestId,
                    "maxInputTokens", maxInputTokens == null ? 0 : maxInputTokens), runId);
            sseManager.send(sessionId, "context_overflow_retry", Map.of(
                    "type", "context_overflow_retry",
                    "requestId", requestId == null ? "" : requestId,
                    "runId", runId == null ? "" : runId,
                    "message", "上下文超限，已压缩并重试一次"));
            logger.info("[LIFECYCLE] service=cp event=chat_overflow_recovery sessionId={} runId={} maxInputTokens={}",
                    sessionId, runId, maxInputTokens);
            return contextService.preflightRetryAfterOverflow(sessionId, maxInputTokens, runId);
        } catch (Exception e) {
            logger.error("[LIFECYCLE] service=cp event=chat_overflow_recovery_failed sessionId={} runId={}",
                    sessionId, runId, e);
            return false;
        }
    }

    /**
     * Resolve model window from context-policy (T1.6). Priority:
     * models.&lt;model&gt;.maxInputTokens → defaults.maxInputTokens → null (caller falls back).
     */
    private Long resolveMaxInputTokens(String userId, String workspaceId, String model) {
        try {
            Map<String, String> domain = configService.resolveDomain(
                    "context-policy", uuidOrNull(userId), uuidOrNull(workspaceId));
            if (domain == null || domain.isEmpty()) {
                return null;
            }
            if (model != null && !model.isBlank()) {
                String modelsJson = domain.get("models");
                if (modelsJson != null && !modelsJson.isBlank()) {
                    var models = objectMapper.readTree(modelsJson);
                    var modelNode = models.path(model);
                    if (modelNode.hasNonNull("maxInputTokens")) {
                        return modelNode.get("maxInputTokens").asLong();
                    }
                }
            }
            String defaultsJson = domain.get("defaults");
            if (defaultsJson != null && !defaultsJson.isBlank()) {
                var defaults = objectMapper.readTree(defaultsJson);
                if (defaults.hasNonNull("maxInputTokens")) {
                    return defaults.get("maxInputTokens").asLong();
                }
            }
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=context_policy_max_input_tokens_unresolved model={} error={}",
                    model, e.getMessage());
        }
        return null;
    }

    private void sendRunErrorAndDone(String sessionId, String requestId, String runId,
                                     String errorCode, String detail, String outcome,
                                     AtomicBoolean terminalSent) {
        if (!terminalSent.compareAndSet(false, true)) {
            logger.warn("[LIFECYCLE] service=cp event=chat_run_terminal_ignored requestId={} sessionId={} runId={} errorCode={} reason=terminal_already_sent",
                    requestId, sessionId, runId, errorCode);
            return;
        }
        String terminalStatus = "ambiguous".equals(outcome) ? "ambiguous" : "failed";
        boolean transitioned = transitionRun(runId,
                List.of("accepted", "queued", "running", "streaming", "awaiting_approval", "dispatching"),
                terminalStatus, outcome, errorCode, detail, 0, 0);
        if (!transitioned) {
            logger.warn("[LIFECYCLE] service=cp event=chat_run_terminal_emit_suppressed runId={} errorCode={} reason=terminal_not_committed",
                    runId, errorCode);
            return;
        }
        sseManager.send(sessionId, "error", Map.of(
                "code", errorCode,
                "requestId", requestId,
                "runId", runId,
                "detail", detail,
                "retryable", isRetryableError(errorCode),
                "outcome", outcome,
                "type", "error"));
        sseManager.send(sessionId, "done", Map.of(
                "type", "done",
                "requestId", requestId,
                "runId", runId,
                "errorCode", errorCode,
                "outcome", outcome,
                "synthetic", true));
    }

    /**
     * Current durable status of the run, or {@code null} when unknown. Used by
     * the terminal-SSE gate to decide whether the durable terminal write is
     * owned by this relay or by another path (cancellation settle / recovery).
     */
    private String runStatus(String runId) {
        return chatRunReadService.statusOrNull(runId);
    }

    /**
     * @return true when this call performed the transition; false when it was
     *         ignored (already terminal / expected-status mismatch)
     */
    private boolean transitionRun(String runId, List<String> expectedStatuses, String status,
                                  String outcome, String errorCode, String errorDetail,
                                  int tokenCount, int assistantChars) {
        return transitionRun(runId, expectedStatuses, status, outcome, errorCode, errorDetail,
                tokenCount, assistantChars, null);
    }

    /**
     * PLAN-0464 T1.4: {@code usagePayload} is the relay's in-memory (cost-mapped)
     * usage envelope and is only carried by the terminal transition that this
     * relay owns; every other caller passes {@code null}.
     */
    private boolean transitionRun(String runId, List<String> expectedStatuses, String status,
                                  String outcome, String errorCode, String errorDetail,
                                  int tokenCount, int assistantChars, Object usagePayload) {
        if (runId == null || runId.isBlank()) {
            return false;
        }
        if (TERMINAL_RUN_STATUSES.contains(status)) {
            ChatRunTerminalService.TerminalResult result = chatRunTerminalService.terminalize(
                    new ChatRunTerminalService.TerminalRequest(runId, expectedStatuses, status,
                            outcome, errorCode, errorDetail, tokenCount, assistantChars,
                            ChatRunTerminalService.TerminalSource.STREAM, usagePayload));
            if (!result.committed()) {
                logger.debug("[LIFECYCLE] service=cp event=chat_run_transition_ignored runId={} targetStatus={} outcome={}",
                        runId, status, result.outcome());
            }
            return result.committed();
        }
        int updated = chatRunRepository.transition(
                UUID.fromString(runId), expectedStatuses, status, outcome, errorCode, errorDetail,
                tokenCount, assistantChars);
        if (updated == 0) {
            logger.debug("[LIFECYCLE] service=cp event=chat_run_transition_ignored runId={} targetStatus={}",
                    runId, status);
            return false;
        }
        return true;
    }

    private String safeErrorCode(String code) {
        if (code == null) {
            return "AGENT_UNAVAILABLE";
        }
        return switch (code) {
            case "LLM_NOT_CONFIGURED", "LLM_CREDENTIALS_INVALID", "LLM_PROVIDER_UNREACHABLE",
                    "LLM_MODEL_UNAVAILABLE", "LLM_REQUEST_REJECTED", "AGENT_UNAVAILABLE", "AGENT_TIMEOUT",
                    "AGENT_CIRCUIT_OPEN", "AGENT_STREAM_FAILED", "SSE_SUBSCRIPTION_REQUIRED", "CHAT_IN_PROGRESS",
                    "IDEMPOTENCY_KEY_CONFLICT", "APPROVAL_REJECTED", "APPROVAL_EXPIRED",
                    "APPROVAL_EXECUTOR_UNSUPPORTED", "APPROVAL_DECISION_CONFLICT", "AGENT_EVENT_ID_MISMATCH",
                    "CONTEXT_OVERFLOW" -> code;
            default -> "AGENT_UNAVAILABLE";
        };
    }

    private String safeErrorDetail(String code) {
        return switch (code) {
            case "LLM_NOT_CONFIGURED" -> "Provider credentials are not configured";
            case "LLM_CREDENTIALS_INVALID" -> "Provider credentials were rejected";
            case "LLM_PROVIDER_UNREACHABLE" -> "Provider is unreachable";
            case "LLM_MODEL_UNAVAILABLE" -> "Selected model is unavailable";
            case "LLM_REQUEST_REJECTED" -> "The provider rejected the request (message shape or parameters)";
            case "AGENT_TIMEOUT" -> "Agent request timed out";
            case "AGENT_CIRCUIT_OPEN" -> "Agent service is temporarily unavailable";
            case "SSE_SUBSCRIPTION_REQUIRED" -> "An active SSE subscription is required";
            case "CHAT_IN_PROGRESS" -> "A chat run is already active for this session";
            case "IDEMPOTENCY_KEY_CONFLICT" -> "Idempotency-Key was already used for a different request";
            case "APPROVAL_REJECTED" -> "The approval request was rejected";
            case "APPROVAL_EXPIRED" -> "The approval request expired";
            case "APPROVAL_EXECUTOR_UNSUPPORTED" -> "The selected agent executor does not support approval";
            case "APPROVAL_DECISION_CONFLICT" -> "Approval request already has a different decision";
            case "AGENT_EVENT_ID_MISMATCH" -> "Agent event does not match the active chat run";
            // PLAN-0341 Q2 freeze (2026-09-17): second-overflow terminal copy.
            case "CONTEXT_OVERFLOW" -> "上下文超限，已压缩并重试一次，仍超出限制";
            default -> "Agent service unavailable";
        };
    }

    private boolean isRetryableError(String code) {
        return switch (code) {
            case "SSE_SUBSCRIPTION_REQUIRED", "CHAT_IN_PROGRESS", "IDEMPOTENCY_KEY_CONFLICT",
                    "APPROVAL_REJECTED", "APPROVAL_EXPIRED", "APPROVAL_EXECUTOR_UNSUPPORTED",
                    "APPROVAL_DECISION_CONFLICT", "AGENT_EVENT_ID_MISMATCH" -> false;
            default -> true;
        };
    }

    private ResponseEntity<Map<String, Object>> llmNotReadyResponse(
            String requestId, String runId, String readiness) {
        String code = switch (readiness) {
            case "missing_credentials" -> "LLM_NOT_CONFIGURED";
            case "invalid_credentials" -> "LLM_CREDENTIALS_INVALID";
            case "unreachable" -> "LLM_PROVIDER_UNREACHABLE";
            case "model_unavailable" -> "LLM_MODEL_UNAVAILABLE";
            default -> "AGENT_UNAVAILABLE";
        };
        String detail = "unknown".equals(readiness)
                ? "Agent LLM readiness is unknown"
                : "Agent LLM is not ready: " + readiness;
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .header("Retry-After", "5")
                .contentType(MediaType.parseMediaType("application/problem+json"))
                .header("X-Request-Id", requestId)
                .body(Map.of(
                        "type", "https://xihe.dev/problems/llm-not-ready",
                        "title", "LLM is not ready",
                        "status", 503,
                        "code", code,
                        "detail", detail,
                        "retryable", true,
                        "requestId", requestId,
                        "runId", runId));
    }

    private boolean acquireRun(String sessionId, String runId) {
        String current = activeRunRegistry.get(sessionId);
        if (current != null && !current.equals(runId)) {
            return false;
        }
        activeRunRegistry.put(sessionId, runId);
        return true;
    }

    private boolean acquireLeaseForExistingRun(String runId) {
        return chatRunRepository.tryAcquireLease(
                UUID.fromString(runId),
                instanceId(),
                Instant.now().plus(LEASE_TTL),
                Instant.now(),
                ChatRunRepository.ACTIVE_LEASE_STATUSES) > 0;
    }

    private void releaseRun(String sessionId, String runId, String reason) {
        boolean dbReleased = chatRunRepository.releaseLease(UUID.fromString(runId), instanceId()) > 0;
        boolean memoryReleased = activeRunRegistry.remove(sessionId, runId);
        eventPublisher.publishEvent(new FollowUpQueueWakeupEvent(sessionId));
        // PLAN-0352 T1.2：唤醒会话删除路径的 release 等待位（终态投递在此之后已完成）。
        chatRunCancellationService.onRunReleased(runId);
        if (dbReleased || memoryReleased) {
            logger.info("[LIFECYCLE] service=cp event=chat_run_lease_released sessionId={} runId={} reason={} dbReleased={} memoryReleased={}",
                    sessionId, runId, reason, dbReleased, memoryReleased);
        } else {
            logger.debug("[LIFECYCLE] service=cp event=chat_run_lease_release_ignored sessionId={} runId={} reason={}",
                    sessionId, runId, reason);
        }
    }

    private String instanceId() {
        return currentInstanceId();
    }

    static String currentInstanceId() {
        return INSTANCE_ID;
    }

    private void markQueuedRequestFailed(RequestQueue.QueuedRequest request, String requestId,
                                         String errorCode, String detail) {
        String runId = request.runId();
        if (runId == null || runId.isBlank()) {
            return;
        }
        releaseRun(request.sessionId(), runId, "queue_drop");
        sendRunErrorAndDone(
                request.sessionId(), requestId, runId, errorCode, detail, "error", new AtomicBoolean(false));
    }

    private String currentRequestId() {
        return nonBlankOrGenerated(MDC.get("requestId"));
    }

    private String nonBlankOrGenerated(String value) {
        return value == null || value.isBlank() ? UUID.randomUUID().toString() : value;
    }

    /** T2.7: tolerate non-UUID tenant ids by degrading to an empty override set. */
    private static UUID uuidOrNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            logger.warn("[LIFECYCLE] service=cp event=config_override_context_invalid value={}", value);
            return null;
        }
    }

    private List<String> extractAttachmentIds(Map<String, Object> request) {
        Object raw = request.get("attachments");
        if (raw == null) {
            return List.of();
        }
        if (raw instanceof List<?> list) {
            return list.stream()
                    .map(Object::toString)
                    .filter(s -> s != null && !s.isBlank())
                    .toList();
        }
        return List.of();
    }

    private String requestHash(String content, String provider, String model,
                               String toolMode, List<String> attachmentIds,
                               Map<String, Integer> toolTimeouts, String agentPrincipalId, String branchId) {
        return ChatRequestHash.calculate(objectMapper, content, provider, model,
                toolMode, attachmentIds, toolTimeouts, agentPrincipalId, branchId);
    }

    private Map<String, Object> runResponse(ChatRun run) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("status", run.getStatus());
        response.put("origin", run.getOrigin());
        response.put("sessionId", run.getSessionId());
        response.put("runId", run.getId());
        response.put("providerConnectionId", run.getProviderConnectionId());
        response.put("connectionRevision", run.getConnectionRevision());
        if (run.getUserMessageId() != null) {
            response.put("messageId", run.getUserMessageId());
        }
        if (run.getTerminalOutcome() != null) {
            response.put("outcome", run.getTerminalOutcome());
        }
        if (run.getErrorCode() != null) {
            response.put("errorCode", run.getErrorCode());
        }
        return response;
    }

    private StreamRelayResult relayAgentStream(String sessionId, InputStream agentStream,
                                               String requestId, String runId,
                                               String userId, String workspaceId,
                                               AtomicBoolean approvalInFlight,
                                               boolean suppressOverflowError) throws Exception {
        StringBuilder assistantContent = new StringBuilder();
        List<RelayedTerminalEvent> terminalEvents = new ArrayList<>();
        Map<String, Integer> eventCounts = new LinkedHashMap<>();
        // PLAN-294 decision #13: real/estimated token totals from the agent's
        // usage event; replaces the SSE chunk counter in chat_runs.token_count.
        Map<?, ?> usageData = null;
        // PLAN-0464 T1.4: cost-mapped usage envelope handed to the terminal write.
        Map<?, ?> usageEnvelope = null;
        boolean doneSeen = false;
        boolean streamingMarked = false;
        boolean awaitingApprovalSeen = false;
        String outcome = "success";
        String errorCode = null;
        int eventIndex = 0;
        var runState = com.cc01cc.p.xihe.cp.mcp.McpRelayToolRecorder.RunState.create();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(agentStream, StandardCharsets.UTF_8))) {
            String eventName = "message";
            StringBuilder data = new StringBuilder();
            String line;

            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    eventIndex++;
                    recordStreamEvent(eventCounts, eventName, data.length(), requestId, sessionId, runId, eventIndex);
                    boolean isDone = "done".equals(eventName);
                    doneSeen = doneSeen || isDone;
                    if ("approval_request".equals(eventName)) {
                        // PLAN-292 C1: once the Agent is blocked on a user
                        // decision, a broken relay stream (page refresh kills
                        // the browser SSE and eventually the relay read) must
                        // NOT fail the run — the durable approval + run status
                        // endpoint keep the decision recoverable.
                        awaitingApprovalSeen = true;
                        approvalInFlight.set(true);
                    }
                    if (!streamingMarked && ("token".equals(eventName) || "message".equals(eventName))) {
                        transitionRun(runId, List.of("running", "awaiting_approval"), "streaming", null, null, null, 0, 0);
                        streamingMarked = true;
                    }
                    collectEventContent(assistantContent, eventName, data.toString());
                    if ("usage".equals(eventName)) {
                        // PLAN-0464 T1.4: cost mapping still happens here so the
                        // session-header usage line is relayed before `done`
                        // (PLAN-0343 decision #9), but nothing is persisted —
                        // the terminal transition owns the llm.usage write.
                        Object usagePayload = parsePayload(eventName, data.toString());
                        Object enriched = mapUsageCost(runId, usagePayload);
                        usageEnvelope = enriched instanceof Map<?, ?> map ? map : null;
                        if (usageEnvelope != null) {
                            sseManager.send(sessionId, "usage", usageEnvelope);
                        }
                        Map<?, ?> usage = asMap(usagePayload).get("usage") instanceof Map<?, ?> u ? u : null;
                        if (usage != null) {
                            usageData = usage;
                        }
                        eventName = "message";
                        data.setLength(0);
                        continue;
                    }
                    if ("error".equals(eventName)) {
                        Map<?, ?> errorPayload = asMap(parsePayload(eventName, data.toString()));
                        errorCode = stringValue(errorPayload, "code");
                        String eventOutcome = stringValue(errorPayload, "outcome");
                        outcome = "ambiguous".equals(eventOutcome)
                                ? "ambiguous" : assistantContent.isEmpty() ? "error" : "partial";
                        // PLAN-0341: first overflow is consumed by the retry loop;
                        // do not forward it as a user-facing terminal error.
                        if (suppressOverflowError && "CONTEXT_OVERFLOW".equals(errorCode)) {
                            eventName = "message";
                            data.setLength(0);
                            continue;
                        }
                    } else if (isDone) {
                        Map<?, ?> donePayload = asMap(parsePayload(eventName, data.toString()));
                        String doneOutcome = stringValue(donePayload, "outcome");
                        String doneErrorCode = stringValue(donePayload, "errorCode");
                        if (doneErrorCode != null) {
                            errorCode = doneErrorCode;
                            String doneOutcomeValue = stringValue(donePayload, "outcome");
                            outcome = "ambiguous".equals(doneOutcomeValue)
                                    ? "ambiguous" : assistantContent.isEmpty() ? "error" : "partial";
                        } else if (doneOutcome != null) {
                            outcome = doneOutcome;
                        }
                    }
                    boolean suppressThisEvent = suppressOverflowError
                            && "CONTEXT_OVERFLOW".equals(errorCode)
                            && ("error".equals(eventName) || isDone);
                    if (!suppressThisEvent) {
                        if (isDone || "error".equals(eventName)) {
                            terminalEvents.add(new RelayedTerminalEvent(eventName, data.toString()));
                        } else {
                            dispatchRelayedEvent(sessionId, eventName, data.toString(), runId, requestId,
                                    userId, workspaceId, runState);
                        }
                    }
                    eventName = "message";
                    data.setLength(0);
                    continue;
                }

                if (line.startsWith("event:")) {
                    eventName = line.substring("event:".length()).trim();
                    continue;
                }

                if (line.startsWith("data:")) {
                    if (data.length() > 0) {
                        data.append('\n');
                    }
                    data.append(line.substring("data:".length()).trim());
                }
            }

            if (data.length() > 0) {
                eventIndex++;
            }
            recordStreamEvent(eventCounts, eventName, data.length(), requestId, sessionId, runId, eventIndex);
            boolean isDone = "done".equals(eventName);
            doneSeen = doneSeen || isDone;
            if (!streamingMarked && ("token".equals(eventName) || "message".equals(eventName))) {
                transitionRun(runId, List.of("running", "awaiting_approval"), "streaming", null, null, null, 0, 0);
                streamingMarked = true;
            }
            collectEventContent(assistantContent, eventName, data.toString());
            if ("error".equals(eventName)) {
                Map<?, ?> errorPayload = asMap(parsePayload(eventName, data.toString()));
                errorCode = stringValue(errorPayload, "code");
                String eventOutcome = stringValue(errorPayload, "outcome");
                outcome = "ambiguous".equals(eventOutcome)
                        ? "ambiguous" : assistantContent.isEmpty() ? "error" : "partial";
            } else if (isDone) {
                Map<?, ?> donePayload = asMap(parsePayload(eventName, data.toString()));
                String doneOutcome = stringValue(donePayload, "outcome");
                String doneErrorCode = stringValue(donePayload, "errorCode");
                if (doneErrorCode != null) {
                    errorCode = doneErrorCode;
                    String doneOutcomeValue = stringValue(donePayload, "outcome");
                    outcome = "ambiguous".equals(doneOutcomeValue)
                            ? "ambiguous" : assistantContent.isEmpty() ? "error" : "partial";
                } else if (doneOutcome != null) {
                    outcome = doneOutcome;
                }
            }
            boolean suppressTail = suppressOverflowError && "CONTEXT_OVERFLOW".equals(errorCode);
            if (!suppressTail) {
                if (isDone || "error".equals(eventName)) {
                    terminalEvents.add(new RelayedTerminalEvent(eventName, data.toString()));
                } else {
                    dispatchRelayedEvent(sessionId, eventName, data.toString(), runId, requestId,
                            userId, workspaceId, runState);
                }
            }
        }
        if (!doneSeen) {
            logger.warn("[LIFECYCLE] service=cp event=chat_run_missing_done requestId={} sessionId={} runId={} errorCode=AGENT_DONE_MISSING",
                    requestId, sessionId, runId);
            boolean suppressSyntheticDone = suppressOverflowError && "CONTEXT_OVERFLOW".equals(errorCode);
            if (!suppressSyntheticDone) {
                terminalEvents.add(new RelayedTerminalEvent("done",
                        "{\"type\":\"done\",\"outcome\":\"ambiguous\",\"synthetic\":true}"));
            }
            if (!suppressSyntheticDone) {
                outcome = "ambiguous";
            }
            eventCounts.put("done", 1);
        }
        logger.info("[LIFECYCLE] service=cp event=chat_stream_relay_finished requestId={} sessionId={} runId={} tokenCount={} assistantChars={}",
                requestId, sessionId, runId, eventCounts.getOrDefault("token", 0), assistantContent.length());
        // PLAN-294 decision #13: token_count column now carries the
        // model-reported (or estimated) total token count, not the SSE chunk
        // count it used to log.
        int usageTotal = usageData != null
                ? intValue(usageData.get("totalTokens"), eventCounts.getOrDefault("token", 0))
                : eventCounts.getOrDefault("token", 0);
        return new StreamRelayResult(
                assistantContent.toString(), outcome, errorCode,
                usageTotal, List.copyOf(terminalEvents), runState, usageEnvelope);
    }

    private static int intValue(Object value, int fallback) {
        return value instanceof Number n ? n.intValue() : fallback;
    }

    // PLAN-0464 T1.4: the `llm_usage` extension path is gone. Cost mapping stays
    // here (single computation point, PLAN-0343 decision #7) so the UI relay
    // carries the same cost fields the terminal write will persist; the durable
    // `llm.usage` ContextEvent is written by ChatRunTerminalService from the
    // envelope this relay hands over.

    /**
     * PLAN-0343 decision #7: single cost computation point (now shared with
     * compaction summaries via {@link com.cc01cc.p.xihe.cp.usage.UsageCostMapper},
     * PLAN-0354 Q5-A). Legacy payloads without a model key and empty usage stay
     * verbatim; everything else gets cost/costCurrency/costSource/costNote.
     */
    private Object mapUsageCost(String runId, Object parsedPayload) {
        try {
            Map<?, ?> envelope = asMap(parsedPayload);
            Map<?, ?> usage = asMap(envelope.get("usage"));
            if (usage.isEmpty()) {
                return parsedPayload;
            }
            String model = stringValue(usage, "model");
            if (model == null) {
                // Pre-0343 payloads without a model key stay verbatim (spec
                // §2.2 legacy rows: aggregation handles them, no alert).
                return parsedPayload;
            }
            Map<String, Object> usageCopy = new java.util.HashMap<>();
            for (Map.Entry<?, ?> entry : usage.entrySet()) {
                usageCopy.put(String.valueOf(entry.getKey()), entry.getValue());
            }
            Map<String, Object> mapped = usageCostMapper.withCost(model, usageCopy, runId);
            Map<String, Object> envelopeOut = new java.util.HashMap<>();
            for (Map.Entry<?, ?> entry : envelope.entrySet()) {
                envelopeOut.put(String.valueOf(entry.getKey()), entry.getValue());
            }
            envelopeOut.put("usage", mapped);
            return envelopeOut;
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=usage_cost_mapping_failed runId={} error={}", runId, e.getMessage());
            return parsedPayload;
        }
    }

    private Map<?, ?> asMap(Object value) {
        return value instanceof Map<?, ?> map ? map : Map.of();
    }

    private String stringValue(Map<?, ?> payload, String key) {
        Object value = payload.get(key);
        return value instanceof String string && !string.isBlank() ? string : null;
    }

    private record StreamRelayResult(
            String assistantContent,
            String outcome,
            String errorCode,
            int tokenCount,
            List<RelayedTerminalEvent> terminalEvents,
            com.cc01cc.p.xihe.cp.mcp.McpRelayToolRecorder.RunState runState,
            Map<?, ?> usageEnvelope
    ) {}

    private record RelayedTerminalEvent(String name, String data) {}

    private void recordStreamEvent(Map<String, Integer> eventCounts, String eventName, int payloadLength,
                                   String requestId, String sessionId, String runId, int eventIndex) {
        if (payloadLength <= 0) {
            return;
        }
        eventCounts.merge(eventName, 1, Integer::sum);
        logger.debug("[LIFECYCLE] service=cp event=chat_stream_event_received requestId={} sessionId={} runId={} eventIndex={} eventName={} payloadLength={}",
                requestId, sessionId, runId, eventIndex, eventName, payloadLength);
    }

    private void collectEventContent(StringBuilder builder, String eventName, String payload) {
        if (payload == null || payload.isBlank()) {
            return;
        }
        // Agent emits token/tool_call/tool_result/done; UI expects token for text.
        // Accumulate assistant text from token and legacy message events; ignore tool/status/done.
        if (!"token".equals(eventName) && !"message".equals(eventName)) {
            return;
        }
        Object parsed = parsePayload(eventName, payload);
        if (parsed instanceof Map<?, ?> map) {
            // Reasoning tokens are separate parts (hint=reasoning), not final assistant text.
            Object hint = map.get("hint");
            if ("reasoning".equals(hint)) {
                return;
            }
            Object content = map.get("content");
            if (content instanceof String s && !s.isBlank()) {
                builder.append(s);
            } else if (content instanceof java.util.List<?> list) {
                for (Object item : list) {
                    if (item instanceof String str) {
                        builder.append(str);
                    } else if (item instanceof Map<?, ?> block) {
                        Object text = block.get("text");
                        if (text instanceof String t && !t.isBlank()) {
                            builder.append(t);
                        }
                    }
                }
            }
        } else if (parsed instanceof String s) {
            builder.append(s);
        }
    }

    private void dispatchEvent(String sessionId, String eventName, String payload) {
        if (payload == null || payload.isBlank()) {
            return;
        }

        Object parsedPayload = parsePayload(eventName, payload);
        sseManager.send(sessionId, eventName, parsedPayload);
    }

    private void dispatchRelayedEvent(String sessionId, String eventName, String payload,
                                      String runId, String requestId, String userId, String workspaceId,
                                      com.cc01cc.p.xihe.cp.mcp.McpRelayToolRecorder.RunState runState) {
        Object parsedPayload = parsePayload(eventName, payload);
        // PLAN-0464 T2.2：Agent 侧工具事实记账只剩执行域（invocation + agent_tool
        // attempt）；LedgerToolRecorder 及其 operation_* 写入已随本计划删除。
        mcpRelayToolRecorder.record(eventName, asMap(parsedPayload), runId, requestId, runState);
        if ("approval_request".equals(eventName)) {
            ChatApproval storedApproval = approvalService.recordPending(
                    asMap(parsedPayload), sessionId, runId, userId, workspaceId);
            // T1.9: an answerer-rejected row is terminal from creation — never park the run or
            // push an approval card for it. The blocked Agent waiter is notified inside the
            // service (best-effort respond), so the run just continues on the failed tool call.
            if (!approvalService.isAwaitingAnswer(storedApproval)) {
                logger.info("[LIFECYCLE] service=cp event=chat_approval_relay_answerer_rejected requestId={}"
                                + " sessionId={} runId={} state={}",
                        storedApproval.getRequestId(), sessionId, runId, storedApproval.getState());
                return;
            }
            transitionRun(runId, List.of("running", "streaming"), "awaiting_approval", null, null, null, 0, 0);

            // Relay the durable canonical Approval row, not the stale Agent payload.
            sseManager.send(sessionId, eventName, approvalService.payloadFor(storedApproval, false));
            return;
        }
        sseManager.send(sessionId, eventName, parsedPayload);
    }

    private Object parsePayload(String eventName, String payload) {
        try {
            return objectMapper.readValue(payload, Object.class);
        } catch (Exception e) {
            logger.debug("Failed to parse SSE payload as JSON, falling back to raw text: {}", e.getMessage());
            return Map.of("content", payload, "type", eventName);
        }
    }
}
