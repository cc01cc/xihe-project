package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
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
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
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
    private final ChatSubmissionService chatSubmissionService;
    private final SessionService sessionService;
    private final MessageRepository messageRepository;
    private final FileRepository fileRepository;
    private final ChatRunRepository chatRunRepository;
    private final HealthMonitor healthMonitor;
    private final RequestQueue requestQueue;
    private final ProviderCredentialLeaseService credentialLeases;
    private final Map<String, String> activeRuns = new ConcurrentHashMap<>();

    private static final java.time.Duration LEASE_TTL = java.time.Duration.ofMinutes(10);
    private static final String INSTANCE_ID = UUID.randomUUID().toString();

    @Value("${cp.agent-url:http://localhost:12632/chat}")
    private String agentUrl;

    @Value("${cp.agent-api-token:dev-token-not-secure}")
    private String agentApiToken;

    public ChatController(
            ObjectMapper objectMapper,
            SseEmitterManager sseManager,
            ApprovalService approvalService,
            OperationService operationService,
            ChatSubmissionService chatSubmissionService,
            SessionService sessionService,
            MessageRepository messageRepository,
            FileRepository fileRepository,
            ChatRunRepository chatRunRepository,
            HealthMonitor healthMonitor,
            RequestQueue requestQueue,
            ProviderCredentialLeaseService credentialLeases) {
        this.agentHttpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        this.objectMapper = objectMapper;
        this.sseManager = sseManager;
        this.approvalService = approvalService;
        this.operationService = operationService;
        this.chatSubmissionService = chatSubmissionService;
        this.sessionService = sessionService;
        this.messageRepository = messageRepository;
        this.fileRepository = fileRepository;
        this.chatRunRepository = chatRunRepository;
        this.healthMonitor = healthMonitor;
        this.requestQueue = requestQueue;
        this.credentialLeases = credentialLeases;

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
                    execAsync(req.sessionId(), req.content(), req.provider(), req.model(), req.toolMode(), req.attachments(),
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
        String provider = (String) request.get("provider");
        String model = (String) request.get("model");
        String toolMode = (String) request.getOrDefault("toolMode", "none");
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
            // Session missing for this user/workspace: create a fresh one tied to this conversation.
            String title = content.length() > 50 ? content.substring(0, 50) + "..." : content;
            session = sessionService.createWithId(sessionId, userId, workspaceId, title, null, null);
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

        String requestHash = requestHash(content, provider, model, toolMode, attachmentIds);
        ChatRun existingRun = chatRunRepository
                .findByUserIdAndSessionIdAndIdempotencyKey(userId, sessionId, idempotencyKey)
                .orElse(null);
        if (existingRun != null) {
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
                    runId, sessionId, userId, workspaceId, idempotencyKey, requestHash,
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
                        userId, workspaceId, requestId, runId);
                if (queued) {
                    logger.info("[LIFECYCLE] service=cp event=chat_run_queued requestId={} sessionId={} runId={} reason=agent_down",
                            requestId, sessionId, runId);
                    handedOff = true;
                    return ResponseEntity.accepted().body(Map.of(
                        "status", "queued",
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

            execAsync(sessionId, content, provider, model, toolMode, attachmentInfos, userId, workspaceId, requestId, runId);
            handedOff = true;
            return ResponseEntity.accepted().body(Map.of(
                "status", "accepted",
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

        String status = run.getStatus();
        if ("succeeded".equals(status) || "failed".equals(status)
                || "cancelled".equals(status) || "ambiguous".equals(status)) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT, "RUN_NOT_CANCELLABLE",
                    "Run is in terminal state: " + status);
        }
        if ("cancelling".equals(status)) {
            return ResponseEntity.ok(Map.of("status", "cancel_accepted", "runId", runId));
        }

        // Transition to cancelling
        run.setStatus("cancelling");
        chatRunRepository.save(run);

        // Forward cancel to Agent
        String reason = request != null ? (String) request.getOrDefault("reason", "user_requested") : "user_requested";
        try {
            String cancelUrl = agentUrl.replace("/chat", "") + "/internal/v1/agent/runs/" + runId + "/cancel";
            var agentRequest = HttpRequest.newBuilder()
                    .uri(URI.create(cancelUrl))
                    .header("Authorization", "Bearer " + agentApiToken)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(
                            objectMapper.writeValueAsString(Map.of("reason", reason, "workspaceId", workspaceId))))
                    .timeout(Duration.ofSeconds(5))
                    .build();
            agentHttpClient.send(agentRequest, HttpResponse.BodyHandlers.ofString());
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=cancel_forward_failed runId={} error={}", runId, e.getMessage());
        }

        logger.info("[LIFECYCLE] service=cp event=run_cancel_requested runId={} reason={}", runId, reason);
        return ResponseEntity.ok(Map.of("status", "cancel_accepted", "runId", runId));
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

                HttpRequest.Builder agentRequestBuilder = HttpRequest.newBuilder(URI.create(agentUrl))
                    .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                    .header(HttpHeaders.ACCEPT, MediaType.TEXT_EVENT_STREAM_VALUE)
                    .header("Authorization", "Bearer " + agentApiToken)
                    .header("X-Request-Id", requestId)
                    .header("X-Chat-Run-Id", runId)
                    .header("X-User-Id", userId)
                    .header("X-Workspace-Id", workspaceId)
                    .header("X-Session-Id", sessionId);
                if (operationId != null) {
                    agentRequestBuilder.header("X-Operation-Id", operationId.toString());
                }
                HttpRequest agentRequestMessage = agentRequestBuilder
                    .timeout(Duration.ofSeconds(30))
                    .POST(HttpRequest.BodyPublishers.ofString(
                        objectMapper.writeValueAsString(agentRequest), StandardCharsets.UTF_8))
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
                StreamRelayResult relayResult;
                try (InputStream agentStream = response.body()) {
                    relayResult = relayAgentStream(
                            sessionId, agentStream, requestId, runId, userId, workspaceId, terminalSent, approvalInFlight);
                }
                String assistantContent = relayResult.assistantContent();
                logger.info("[LIFECYCLE] service=cp event=chat_run_finished requestId={} sessionId={} runId={} assistantChars={}",
                        requestId, sessionId, runId, assistantContent == null ? 0 : assistantContent.length());

                if (assistantContent != null && !assistantContent.isBlank()) {
                    Message assistantMessage = new Message(sessionId, MessageRole.ASSISTANT, assistantContent);
                    assistantMessage.setRunId(runId);
                    messageRepository.save(assistantMessage);
                    chatRunRepository.findById(UUID.fromString(runId)).ifPresent(run -> {
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
                        List.of("running", "streaming"),
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

    private void sendRunErrorAndDone(String sessionId, String requestId, String runId,
                                     String errorCode, String detail, String outcome,
                                     AtomicBoolean terminalSent) {
        if (!terminalSent.compareAndSet(false, true)) {
            logger.warn("[LIFECYCLE] service=cp event=chat_run_terminal_ignored requestId={} sessionId={} runId={} errorCode={} reason=terminal_already_sent",
                    requestId, sessionId, runId, errorCode);
            return;
        }
        String terminalStatus = "ambiguous".equals(outcome) ? "ambiguous" : "failed";
        transitionRun(runId, List.of("accepted", "queued", "running", "streaming", "awaiting_approval", "dispatching"),
                terminalStatus, outcome, errorCode, detail, 0, 0);
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

    private void transitionRun(String runId, List<String> expectedStatuses, String status,
                               String outcome, String errorCode, String errorDetail,
                               int tokenCount, int assistantChars) {
        if (runId == null || runId.isBlank()) {
            return;
        }
        int updated = chatRunRepository.transition(
                UUID.fromString(runId), expectedStatuses, status, outcome, errorCode, errorDetail,
                tokenCount, assistantChars);
        if (updated == 0) {
            logger.debug("[LIFECYCLE] service=cp event=chat_run_transition_ignored runId={} targetStatus={}",
                    runId, status);
            return;
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
    }

    private String safeErrorCode(String code) {
        if (code == null) {
            return "AGENT_UNAVAILABLE";
        }
        return switch (code) {
            case "LLM_NOT_CONFIGURED", "LLM_CREDENTIALS_INVALID", "LLM_PROVIDER_UNREACHABLE",
                    "LLM_MODEL_UNAVAILABLE", "AGENT_UNAVAILABLE", "AGENT_TIMEOUT",
                    "AGENT_CIRCUIT_OPEN", "AGENT_STREAM_FAILED", "SSE_SUBSCRIPTION_REQUIRED", "CHAT_IN_PROGRESS",
                    "IDEMPOTENCY_KEY_CONFLICT", "APPROVAL_REJECTED", "APPROVAL_EXPIRED",
                    "APPROVAL_EXECUTOR_UNSUPPORTED", "APPROVAL_DECISION_CONFLICT", "AGENT_EVENT_ID_MISMATCH" -> code;
            default -> "AGENT_UNAVAILABLE";
        };
    }

    private String safeErrorDetail(String code) {
        return switch (code) {
            case "LLM_NOT_CONFIGURED" -> "Provider credentials are not configured";
            case "LLM_CREDENTIALS_INVALID" -> "Provider credentials were rejected";
            case "LLM_PROVIDER_UNREACHABLE" -> "Provider is unreachable";
            case "LLM_MODEL_UNAVAILABLE" -> "Selected model is unavailable";
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
                               String toolMode, List<String> attachmentIds) {
        try {
            Map<String, Object> canonical = new LinkedHashMap<>();
            canonical.put("content", content == null ? "" : content);
            canonical.put("provider", provider == null ? "" : provider);
            canonical.put("model", model == null ? "" : model);
            canonical.put("toolMode", toolMode == null || toolMode.isBlank() ? "none" : toolMode);
            canonical.put("attachments", attachmentIds == null ? List.of() : attachmentIds);
            byte[] bytes = objectMapper.writeValueAsBytes(canonical);
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception e) {
            throw new IllegalArgumentException("Unable to calculate request hash", e);
        }
    }

    private Map<String, Object> runResponse(ChatRun run) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("status", run.getStatus());
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
                                               AtomicBoolean approvalInFlight) throws Exception {
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
                        // tagging) as an operation extension and stop relaying
                        // it to the UI (no UI consumer; audit-only channel).
                        Object usagePayload = parsePayload(eventName, data.toString());
                        persistUsageExtension(runId, usagePayload);
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
                    if (!isDone || terminalSent.compareAndSet(false, true)) {
                        dispatchRelayedEvent(sessionId, eventName, data.toString(), runId, requestId,
                                userId, workspaceId, operationItems, operationAttempts);
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
            if (!isDone || terminalSent.compareAndSet(false, true)) {
                dispatchRelayedEvent(sessionId, eventName, data.toString(), runId, requestId,
                        userId, workspaceId, operationItems, operationAttempts);
            }
        }
        if (!doneSeen) {
            logger.warn("[LIFECYCLE] service=cp event=chat_run_missing_done requestId={} sessionId={} runId={} errorCode=AGENT_DONE_MISSING",
                    requestId, sessionId, runId);
            if (terminalSent.compareAndSet(false, true)) {
                dispatchEvent(sessionId, "done", "{\"type\":\"done\",\"outcome\":\"ambiguous\",\"synthetic\":true}");
            }
            outcome = "ambiguous";
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
    // token counts and the source tag; store it verbatim on the run's
    // operation as an llm_usage extension (audit + calibration baseline).
    private void persistUsageExtension(String runId, Object parsedPayload) {
        UUID operationId = operationService.findOperationIdByRunId(runId);
        if (operationId == null) {
            logger.debug("[LIFECYCLE] service=cp event=usage_extension_skipped runId={} reason=no_operation", runId);
            return;
        }
        try {
            OperationItem item = operationService.appendItem(
                    operationId, null, null, "llm_usage", "chat", "agent", null, null, null);
            operationService.appendExtension(item.getId(), null, "llm_usage", 1,
                    objectMapper.writeValueAsString(parsedPayload));
            // PLAN-294 ①2: success visibility — the estimated/real token
            // counts reaching the ledger is the calibration baseline; without
            // this line a silent CHECK-constraint rejection is undetectable.
            Map<?, ?> usage = asMap(asMap(parsedPayload).get("usage"));
            logger.info("[LIFECYCLE] service=cp event=usage_extension_persisted runId={} source={} inputTokens={} totalTokens={}",
                    runId, usage.get("source"), usage.get("inputTokens"), usage.get("totalTokens"));
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=usage_extension_failed runId={} error={}", runId, e.getMessage());
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
                                      Map<String, UUID> operationItems,
                                      Map<UUID, UUID> operationAttempts) {
        Object parsedPayload = parsePayload(eventName, payload);
        recordLedgerToolEvent(eventName, asMap(parsedPayload), runId, requestId,
                operationItems, operationAttempts);
        if ("approval_request".equals(eventName)) {
            approvalService.recordPending(asMap(parsedPayload), sessionId, runId, userId, workspaceId);
            transitionRun(runId, List.of("running", "streaming"), "awaiting_approval", null, null, null, 0, 0);
        }
        sseManager.send(sessionId, eventName, parsedPayload);
    }

    private void recordLedgerToolEvent(String eventName, Map<?, ?> payload, String runId,
                                       String requestId, Map<String, UUID> operationItems,
                                       Map<UUID, UUID> operationAttempts) {
        if (!"tool_call".equals(eventName) && !"tool_result".equals(eventName)) {
            return;
        }
        UUID operationId = operationService.findOperationIdByRunId(runId);
        if (operationId == null) {
            return;
        }
        String toolName = stringValue(payload, "tool");
        if (toolName == null) {
            toolName = "unknown";
        }
        String rawToolCallId = stringValue(payload, "run_id");
        if (rawToolCallId == null) {
            rawToolCallId = stringValue(payload, "toolCallId");
        }
        String toolCallId = canonicalToolCallId(rawToolCallId, runId, toolName, payload);
        try {
            if ("tool_call".equals(eventName)) {
                OperationItem item = operationService.findLatestOpenItem(operationId, toolName);
                if (item == null) {
                    item = operationService.appendItem(
                            operationId, toolCallId, null, "tool_call", toolName, "agent",
                            safeJsonPreview(payload.get("arguments")), null, null);
                }
                operationItems.put(toolCallId, item.getId());
                if ("pending".equals(item.getStatus())) {
                    operationService.transitionItem(item.getId(), "running", null, null, null, null);
                }
                if (!operationAttempts.containsKey(item.getId())) {
                    OperationAttempt attempt = operationService.startAttempt(
                            item.getId(), "agent_tool", null, "agent", requestId);
                    operationAttempts.put(item.getId(), attempt.getId());
                }
                return;
            }

            UUID itemId = operationItems.get(toolCallId);
            if (itemId == null) {
                OperationItem item = operationService.findLatestOpenItem(operationId, toolName);
                if (item != null) {
                    itemId = item.getId();
                    operationItems.put(toolCallId, itemId);
                }
            }
            if (itemId == null) {
                logger.warn("[LIFECYCLE] service=cp event=operation_tool_result_unmatched runId={} toolCallId={} toolName={}",
                        runId, toolCallId, toolName);
                return;
            }
            UUID attemptId = operationAttempts.get(itemId);
            Object rawResult = payload.get("result");
            boolean failed = rawResult != null && String.valueOf(rawResult).startsWith("Tool error:");
            if (attemptId != null) {
                operationService.finishAttempt(attemptId, failed ? "failed" : "succeeded",
                        failed ? 500 : 200, failed ? "TOOL_FAILED" : null, null, null);
            }
            operationService.transitionItem(itemId, failed ? "failed" : "completed",
                    failed ? null : "allow", null, null, failed ? "TOOL_FAILED" : null);
            operationAttempts.remove(itemId);
            operationItems.remove(toolCallId);
        } catch (RuntimeException e) {
            logger.error("[LIFECYCLE] service=cp event=operation_tool_record_failed runId={} toolCallId={} toolName={}",
                    runId, toolCallId, toolName, e);
            if (e instanceof com.cc01cc.p.xihe.cp.config.CpApiException apiException
                    && "OPERATION_STATE_CONFLICT".equals(apiException.getCode())) {
                return;
            }
            throw e;
        }
    }

    private String safeJsonPreview(Object value) {
        try {
            String json = objectMapper.writeValueAsString(value == null ? Map.of() : value);
            String redacted = LogRedactor.redact(json);
            return redacted.length() <= 4096 ? redacted : redacted.substring(0, 4096);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=operation_arguments_redaction_failed");
            return "{\"redacted\":true}";
        }
    }

    private String canonicalToolCallId(String rawToolCallId, String runId, String toolName,
                                       Map<?, ?> payload) {
        if (rawToolCallId != null) {
            try {
                return UUID.fromString(rawToolCallId).toString();
            } catch (IllegalArgumentException ignored) {
                // LangGraph may use a non-UUID run identifier; normalize it for the UUID schema.
            }
        }
        return UUID.nameUUIDFromBytes((runId + ":" + toolName + ":" + safeJsonPreview(payload)).getBytes(StandardCharsets.UTF_8)).toString();
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
