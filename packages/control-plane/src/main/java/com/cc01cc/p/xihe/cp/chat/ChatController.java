package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.service.RunCheckpointService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.status.HealthMonitor;
import com.cc01cc.p.xihe.cp.status.RequestQueue;
import com.cc01cc.p.xihe.cp.status.CircuitBreaker;
import com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.entity.OperationAttempt;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.logging.LogRedactor;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
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
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

@RestController
public class ChatController {

    private static final Logger logger = LoggerFactory.getLogger(ChatController.class);

    private final HttpClient agentHttpClient;
    private final ObjectMapper objectMapper;
    private final SseEmitterManager sseManager;
    private final ApprovalService approvalService;
    private final OperationService operationService;
    private final com.cc01cc.p.xihe.cp.context.service.EventStoreService eventStoreService;
    private final com.cc01cc.p.xihe.cp.context.service.ContextService contextService;
    private final ChatSubmissionService chatSubmissionService;
    private final SessionService sessionService;
    private final MessageRepository messageRepository;
    private final FileRepository fileRepository;
    private final ChatRunRepository chatRunRepository;
    private final HealthMonitor healthMonitor;
    private final RequestQueue requestQueue;
    private final ProviderCredentialLeaseService credentialLeases;
    private final ConfigService configService;
    private final com.cc01cc.p.xihe.cp.operation.LedgerToolRecorder ledgerToolRecorder;
    private final com.cc01cc.p.xihe.cp.mcp.McpProxyController mcpProxyController;
    private final com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy toolTimeoutPolicy;
    private final RunCheckpointService runCheckpointService;
    private final ChatRunCancellationService chatRunCancellationService;
    private final com.cc01cc.p.xihe.cp.context.service.ContextSourceRefreshService contextSourceRefreshService;
    private final com.cc01cc.p.xihe.cp.usage.UsageCostMapper usageCostMapper;
    private final Map<String, String> activeRuns = new ConcurrentHashMap<>();

    private static final java.time.Duration LEASE_TTL = java.time.Duration.ofMinutes(10);
    private static final String INSTANCE_ID = UUID.randomUUID().toString();

    /**
     * PLAN-0328 M2 W3: statuses whose transition ends the Run and therefore must
     * request a checkpoint seal (cancelled does not pass through {@code transitionRun}
     * and is sealed by {@code settleRunCancellation}).
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
            OperationService operationService,
            com.cc01cc.p.xihe.cp.context.service.EventStoreService eventStoreService,
            com.cc01cc.p.xihe.cp.context.service.ContextService contextService,
            ChatSubmissionService chatSubmissionService,
            SessionService sessionService,
            MessageRepository messageRepository,
            FileRepository fileRepository,
            ChatRunRepository chatRunRepository,
            HealthMonitor healthMonitor,
            RequestQueue requestQueue,
            ProviderCredentialLeaseService credentialLeases,
            ConfigService configService,
            com.cc01cc.p.xihe.cp.operation.LedgerToolRecorder ledgerToolRecorder,
            com.cc01cc.p.xihe.cp.mcp.McpProxyController mcpProxyController,
            com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy toolTimeoutPolicy,
            RunCheckpointService runCheckpointService,
            ChatRunCancellationService chatRunCancellationService,
            com.cc01cc.p.xihe.cp.context.service.ContextSourceRefreshService contextSourceRefreshService,
            com.cc01cc.p.xihe.cp.usage.UsageCostMapper usageCostMapper) {
        this.agentHttpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        this.objectMapper = objectMapper;
        this.sseManager = sseManager;
        this.approvalService = approvalService;
        this.operationService = operationService;
        this.eventStoreService = eventStoreService;
        this.contextService = contextService;
        this.chatSubmissionService = chatSubmissionService;
        this.sessionService = sessionService;
        this.messageRepository = messageRepository;
        this.fileRepository = fileRepository;
        this.chatRunRepository = chatRunRepository;
        this.healthMonitor = healthMonitor;
        this.requestQueue = requestQueue;
        this.credentialLeases = credentialLeases;
        this.configService = configService;
        this.ledgerToolRecorder = ledgerToolRecorder;
        this.mcpProxyController = mcpProxyController;
        this.toolTimeoutPolicy = toolTimeoutPolicy;
        this.runCheckpointService = runCheckpointService;
        this.chatRunCancellationService = chatRunCancellationService;
        this.contextSourceRefreshService = contextSourceRefreshService;
        this.usageCostMapper = usageCostMapper;

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
        if (session.getProviderConnectionId() != null) {
            // A bound Session is authoritative. Do not allow the browser's display
            // hints to switch the credential or model used by this run.
            provider = session.getModelProvider();
            model = session.getModelName();
        }

        List<String> attachmentIds = extractAttachmentIds(request);
        List<com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo> attachmentInfos = new ArrayList<>();
        if (!attachmentIds.isEmpty()) {
            for (String fileId : attachmentIds) {
                File file = fileRepository.findById(UUID.fromString(fileId)).orElse(null);
                if (file == null) {
                    return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "ATTACHMENT_NOT_FOUND", "Attachment not found");
                }
                if (!sessionId.equals(file.getSessionId())
                        || !workspaceId.equals(file.getWorkspaceId())
                        || !userId.equals(file.getUserId())
                        || !userId.equals(session.getUserId())) {
                    return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", "Attachment does not belong to session");
                }
                attachmentInfos.add(new com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo(
                    file.getId().toString(), file.getFilename(), file.getMimeType(), file.getSizeBytes(), "/api/v1/files/" + file.getId()
                ));
            }
        }

        String attachmentsJson = null;
        if (!attachmentInfos.isEmpty()) {
            try {
                List<Map<String, Object>> refs = new ArrayList<>();
                for (com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo info : attachmentInfos) {
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
                perCallTimeouts.values(), agentPrincipalId);
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
                    runId, sessionId, userId, workspaceId, agentPrincipalId, idempotencyKey, requestHash,
                    provider, model, toolMode, session.getProviderConnectionId(), session.getConnectionRevision(),
                    instanceId(), requestId, content, attachmentsJson, attachmentIds);
            ChatRun chatRun = submission.run();
            Message userMessage = submission.userMessage();
            OperationService.OperationStartResult operation = submission.operation();

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
                        "operationId", operation.operationId(),
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
                "runId", runId,
                "operationId", operation.operationId()
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
        ChatRun run = chatRunRepository.findById(runUuid).orElse(null);
        if (run == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found");
        }
        if (!userId.equals(run.getUserId()) || !workspaceId.equals(run.getWorkspaceId())) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", "Chat run does not belong to current user/workspace");
        }
        boolean leaseExpired = run.getLeaseExpiresAt() != null
                && run.getLeaseExpiresAt().isBefore(java.time.Instant.now());
        List<Map<String, Object>> pendingApprovals = approvalService.findActiveForRun(runId, userId, workspaceId);
        String status = run.getStatus();
        String effectiveStatus = !pendingApprovals.isEmpty() && ("running".equals(status) || "cancelling".equals(status))
                ? "awaiting_approval"
                : status;
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("runId", runId);
        body.put("sessionId", run.getSessionId());
        body.put("origin", run.getOrigin());
        body.put("status", effectiveStatus);
        body.put("terminalOutcome", run.getTerminalOutcome());
        body.put("leaseExpired", leaseExpired);
        body.put("pendingApprovals", pendingApprovals);
        return ResponseEntity.ok(body);
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

        ChatRun run = chatRunRepository.findById(UUID.fromString(runId)).orElse(null);
        if (run == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.NOT_FOUND, "RUN_NOT_FOUND", "Chat run not found");
        }
        if (!userId.equals(run.getUserId()) || !workspaceId.equals(run.getWorkspaceId())) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", "Chat run does not belong to current user/workspace");
        }

        String reason = request != null ? (String) request.getOrDefault("reason", "user_requested") : "user_requested";
        // PLAN-0407 T2.5：序列化认领（条件更新，与 spawn 的 parent Run 行锁同一行）
        // → 认领获胜者收口根 run → 沿 kind=spawn 停止传播 + 有界等待。
        ChatRunCancellationService.CancelClaim claim =
                chatRunCancellationService.cancelSerialized(runId, workspaceId, reason);
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
                // inside the session serialization scope (activeRuns), the
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
                // PLAN-0340 T1.1: per-run source refresh while activeRuns still
                // serializes the session. Failures are fail-open inside refresh.
                try {
                    String sourceStatus = contextSourceRefreshService.refreshForRun(sessionId, workspaceId, userId);
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
                }
                transitionRun(runId, List.of("accepted", "queued"), "running", null, null, null, 0, 0);
                ChatRun persistedRun = chatRunRepository.findById(UUID.fromString(runId))
                        .orElseThrow(() -> new IllegalStateException("Chat run not found"));
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
                UUID operationId = operationService.findOperationIdByRunId(runId);
                if (operationId != null) {
                    agentRequest.put("operationId", operationId.toString());
                }
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
                agentRequest.putAll(mcpProxyController.toolTimeoutPayload(workspaceId, userId, toolTimeouts));
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
                String agentOperationIdHeader = operationId != null ? operationId.toString() : null;

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
                    if (agentOperationIdHeader != null) {
                        dispatchBuilder.header("X-Operation-Id", agentOperationIdHeader);
                    }
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
                                sessionId, agentStream, requestId, runId, userId, workspaceId, terminalSent,
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
                transitionRun(
                        runId,
                        List.of("running", "streaming", "awaiting_approval"),
                        status,
                        outcome,
                        relayResult.errorCode(),
                        null,
                        relayResult.tokenCount(),
                        assistantContent == null ? 0 : assistantContent.length());

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
            // The run was already terminal through another path: the capture request
            // must still happen (transitionRun could not issue it).
            runCheckpointService.requestCapture(runId);
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
     * @return true when this call performed the transition; false when it was
     *         ignored (already terminal / expected-status mismatch)
     */
    private boolean transitionRun(String runId, List<String> expectedStatuses, String status,
                                  String outcome, String errorCode, String errorDetail,
                                  int tokenCount, int assistantChars) {
        if (runId == null || runId.isBlank()) {
            return false;
        }
        int updated = chatRunRepository.transition(
                UUID.fromString(runId), expectedStatuses, status, outcome, errorCode, errorDetail,
                tokenCount, assistantChars);
        if (updated == 0) {
            logger.debug("[LIFECYCLE] service=cp event=chat_run_transition_ignored runId={} targetStatus={}",
                    runId, status);
            return false;
        }
        String operationStatus = switch (status) {
            case "running" -> "running";
            case "awaiting_approval" -> "waiting_for_approval";
            case "succeeded" -> "completed";
            case "failed", "partial" -> "failed";
            case "cancelled" -> "cancelled";
            case "ambiguous" -> "ambiguous";
            default -> null;
        };
        if (operationStatus != null) {
            operationService.transitionOperationForRun(runId, operationStatus,
                    errorCode == null && "partial".equals(status) ? "PARTIAL_RESULT" : errorCode,
                    errorDetail);
        }
        // PLAN-0338: terminal transition → capture the run slice. The request is
        // asynchronous and never fails the transition; a failed capture records a
        // degraded row for the startup reconcile.
        if (TERMINAL_RUN_STATUSES.contains(status)) {
            runCheckpointService.requestCapture(runId);
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
        String current = activeRuns.get(sessionId);
        if (current != null && !current.equals(runId)) {
            return false;
        }
        activeRuns.put(sessionId, runId);
        return true;
    }

    void restoreActiveRun(String sessionId, String runId) {
        activeRuns.put(sessionId, runId);
    }

    String activeRunId(String sessionId) {
        return activeRuns.get(sessionId);
    }

    /** PLAN-0317 T2.7：该 run 是否正由本进程处理（周期对账的防误伤保护）。 */
    boolean isRunActiveLocally(String runId) {
        return runId != null && activeRuns.containsValue(runId);
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
        boolean memoryReleased = activeRuns.remove(sessionId, runId);
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
                               Map<String, Integer> toolTimeouts, String agentPrincipalId) {
        return ChatRequestHash.calculate(objectMapper, content, provider, model,
                toolMode, attachmentIds, toolTimeouts, agentPrincipalId);
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
        UUID operationId = operationService.findOperationIdByRunId(run.getId().toString());
        if (operationId != null) {
            response.put("operationId", operationId);
        }
        return response;
    }

    private StreamRelayResult relayAgentStream(String sessionId, InputStream agentStream,
                                               String requestId, String runId,
                                               String userId, String workspaceId,
                                               AtomicBoolean terminalSent,
                                               AtomicBoolean approvalInFlight,
                                               boolean suppressOverflowError) throws Exception {
        StringBuilder assistantContent = new StringBuilder();
        Map<String, Integer> eventCounts = new LinkedHashMap<>();
        // PLAN-294 decision #13: real/estimated token totals from the agent's
        // usage event; replaces the SSE chunk counter in chat_runs.token_count.
        Map<?, ?> usageData = null;
        boolean doneSeen = false;
        boolean streamingMarked = false;
        boolean awaitingApprovalSeen = false;
        String outcome = "success";
        String errorCode = null;
        int eventIndex = 0;
        Map<String, UUID> operationItems = new LinkedHashMap<>();
        Map<UUID, UUID> operationAttempts = new LinkedHashMap<>();
        var runLedger = new com.cc01cc.p.xihe.cp.operation.LedgerToolRecorder.RunLedger(operationItems, operationAttempts);
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
                        // PLAN-294 decisions #13/#14: persist the agent's usage
                        // payload (estimated + real token counts with source
                        // tagging) as an operation extension. PLAN-0343
                        // decision #9: after cost mapping the event IS relayed
                        // to the UI (single event, before done) for the
                        // session-header usage line.
                        Object usagePayload = parsePayload(eventName, data.toString());
                        Map<?, ?> enriched = persistUsageExtension(sessionId, runId, usagePayload);
                        if (enriched != null) {
                            sseManager.send(sessionId, "usage", enriched);
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
                    if (!suppressThisEvent && (!isDone || terminalSent.compareAndSet(false, true))) {
                        dispatchRelayedEvent(sessionId, eventName, data.toString(), runId, requestId,
                                userId, workspaceId, runLedger);
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
            if (!suppressTail && (!isDone || terminalSent.compareAndSet(false, true))) {
                dispatchRelayedEvent(sessionId, eventName, data.toString(), runId, requestId,
                        userId, workspaceId, runLedger);
            }
        }
        if (!doneSeen) {
            logger.warn("[LIFECYCLE] service=cp event=chat_run_missing_done requestId={} sessionId={} runId={} errorCode=AGENT_DONE_MISSING",
                    requestId, sessionId, runId);
            boolean suppressSyntheticDone = suppressOverflowError && "CONTEXT_OVERFLOW".equals(errorCode);
            if (!suppressSyntheticDone && terminalSent.compareAndSet(false, true)) {
                dispatchEvent(sessionId, "done", "{\"type\":\"done\",\"outcome\":\"ambiguous\",\"synthetic\":true}");
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
                usageTotal);
    }

    private static int intValue(Object value, int fallback) {
        return value instanceof Number n ? n.intValue() : fallback;
    }

    // PLAN-294 M1 (decision #13): the usage event carries estimated + real
    // token counts and the source tag; store it on the run's operation as an
    // llm_usage extension (audit + calibration baseline). PLAN-0343 decision
    // #7: the cost mapping happens ONLY here (run-terminal snapshot, one per
    // run) so the ledger item, the extension, the context-event mirror and
    // the UI relay all carry the same cost fields (spec §4 单一计算点).
    // Returns the enriched payload for UI relay (decision #9), or null when
    // nothing was persisted (no operation).
    private Map<?, ?> persistUsageExtension(String sessionId, String runId, Object parsedPayload) {
        UUID operationId = operationService.findOperationIdByRunId(runId);
        if (operationId == null) {
            logger.debug("[LIFECYCLE] service=cp event=usage_extension_skipped runId={} reason=no_operation", runId);
            return null;
        }
        try {
            Object enriched = mapUsageCost(runId, parsedPayload);
            OperationItem item = operationService.appendItem(
                    operationId, null, null, "llm_usage", "chat", "agent", null, null, null);
            operationService.appendExtension(item.getId(), null, "llm_usage", 1,
                    objectMapper.writeValueAsString(enriched));
            // 2026-09-13 E2E（V11）：usage 条目写完即终态，避免账本残留 pending 中间态。
            operationService.transitionItem(item.getId(), "completed", null, null, null, null);
            // PLAN-294 M3 (decision #5 signal bridge): mirror the usage into
            // the context event store so the compaction gate reads a single
            // source. workspace_id/user_id are NOT NULL in context_events —
            // fill them from the run's ownership.
            ChatRun usageRun = chatRunRepository.findById(UUID.fromString(runId)).orElse(null);
            if (usageRun != null) {
                Map<String, Object> usageEnvelope = new java.util.HashMap<>();
                usageEnvelope.put("usage", asMap(enriched).get("usage"));
                // PLAN-0410 T2.3 (matrix §4): llm.usage is run-scoped — carry
                // correlation_id=runId so CP derives the durable branch.
                eventStoreService.append(sessionId, usageRun.getWorkspaceId().toString(),
                        usageRun.getUserId().toString(), "llm.usage", usageEnvelope,
                        usageRun.getId().toString());
            }
            // PLAN-294 ①2: success visibility — the estimated/real token
            // counts reaching the ledger is the calibration baseline; without
            // this line a silent CHECK-constraint rejection is undetectable.
            Map<?, ?> usage = asMap(asMap(enriched).get("usage"));
            logger.info("[LIFECYCLE] service=cp event=usage_extension_persisted runId={} source={} inputTokens={} totalTokens={} cost={} costSource={}",
                    runId, usage.get("source"), usage.get("inputTokens"), usage.get("totalTokens"),
                    usage.get("cost"), usage.get("costSource"));
            return asMap(enriched);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=usage_extension_failed runId={} error={}", runId, e.getMessage());
            return null;
        }
    }

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
            int tokenCount
    ) {}

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
                                      com.cc01cc.p.xihe.cp.operation.LedgerToolRecorder.RunLedger runLedger) {
        Object parsedPayload = parsePayload(eventName, payload);
        // PLAN-0326 决策 #8/#9：Agent 侧工具事实记账统一走 LedgerToolRecorder
        // （按事件阶段映射，幂等限定同源）；本类只做事件分发，不再散写账本。
        ledgerToolRecorder.record(eventName, asMap(parsedPayload), runId, requestId, runLedger);
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

            // Keep ledger/audit input unchanged; relay only the durable canonical row.
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
