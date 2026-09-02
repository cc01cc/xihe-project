package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.status.HealthMonitor;
import com.cc01cc.p.xihe.cp.status.RequestQueue;
import com.cc01cc.p.xihe.cp.status.CircuitBreaker;

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
    private final SessionService sessionService;
    private final MessageRepository messageRepository;
    private final FileRepository fileRepository;
    private final HealthMonitor healthMonitor;
    private final RequestQueue requestQueue;
    private final Map<String, String> activeRuns = new ConcurrentHashMap<>();

    @Value("${cp.agent-url:http://localhost:12632/chat}")
    private String agentUrl;

    @Value("${cp.agent-api-token:dev-token-not-secure}")
    private String agentApiToken;

    public ChatController(
            ObjectMapper objectMapper,
            SseEmitterManager sseManager,
            SessionService sessionService,
            MessageRepository messageRepository,
            FileRepository fileRepository,
            HealthMonitor healthMonitor,
            RequestQueue requestQueue) {
        this.agentHttpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        this.objectMapper = objectMapper;
        this.sseManager = sseManager;
        this.sessionService = sessionService;
        this.messageRepository = messageRepository;
        this.fileRepository = fileRepository;
        this.healthMonitor = healthMonitor;
        this.requestQueue = requestQueue;

        // Wire drain callback: when agent recovers, drain queued requests
        healthMonitor.setOnServiceRecovered(serviceName -> {
            if ("agent".equals(serviceName)) {
                requestQueue.drain(req -> {
                    String requestId = nonBlankOrGenerated(req.requestId());
                    String runId = nonBlankOrGenerated(req.runId());
                    if (!acquireRun(req.sessionId(), runId)) {
                        logger.warn("[LIFECYCLE] service=cp event=chat_sse_rejected requestId={} sessionId={} runId={} errorCode=CHAT_IN_PROGRESS",
                                requestId, req.sessionId(), runId);
                        return;
                    }
                    logger.info("[LIFECYCLE] service=cp event=requestRedelivered requestId={} sessionId={} runId={} outcome=accepted",
                            requestId, req.sessionId(), runId);
                    execAsync(req.sessionId(), req.content(), req.model(), List.of(),
                            req.userId(), req.workspaceId(), requestId, runId);
                });
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
        logger.info("[LIFECYCLE] service=cp event=chat_sse_connected requestId={} sessionId={} workspaceId={} connectionGeneration={} outcome=ok",
                currentRequestId(), sessionId, workspaceId, sseManager.connectionGeneration(sessionId));
        return emitter;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/exec")
    public ResponseEntity<Map<String, Object>> exec(@RequestBody Map<String, Object> request) {
        String sessionId = (String) request.get("sessionId");
        String content = (String) request.getOrDefault("content", "");
        String model = (String) request.get("model");
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        if (sessionId == null || sessionId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "sessionId is required");
        }
        try {
            sessionService.requireCurrent(sessionId, userId, workspaceId);
        } catch (com.cc01cc.p.xihe.cp.config.CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }

        if (!sseManager.hasEmitter(sessionId)) {
            logger.warn("[LIFECYCLE] service=cp event=chat_sse_rejected requestId={} sessionId={} errorCode=SSE_SUBSCRIPTION_REQUIRED",
                    currentRequestId(), sessionId);
            return ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT, "SSE_SUBSCRIPTION_REQUIRED", "An active SSE subscription is required");
        }

        String requestId = currentRequestId();
        String runId = UUID.randomUUID().toString();
        if (!acquireRun(sessionId, runId)) {
            logger.warn("[LIFECYCLE] service=cp event=chat_sse_rejected requestId={} sessionId={} runId={} errorCode=CHAT_IN_PROGRESS",
                    requestId, sessionId, runId);
            return ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT, "CHAT_IN_PROGRESS", "A chat run is already active for this session");
        }

        logger.info("[LIFECYCLE] service=cp event=chat_run_started requestId={} sessionId={} runId={} contentLength={}",
                requestId, sessionId, runId, content.length());
        execAsync(sessionId, content, model, List.of(), userId, workspaceId, requestId, runId);
        return ResponseEntity.accepted().body(Map.of(
            "status", "accepted",
            "sessionId", sessionId,
            "runId", runId
        ));
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/chat")
    public ResponseEntity<Map<String, Object>> chat(@RequestBody Map<String, Object> request) {
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
        String model = (String) request.get("model");

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

        // Agent down → queue request
        HealthMonitor.ServiceHealth agentHealth = healthMonitor.getAgentHealth();
        if ("down".equals(agentHealth.status())) {
            boolean queued = requestQueue.enqueue(sessionId, content, model, userId, workspaceId, requestId, runId);
            if (queued) {
                logger.info("[LIFECYCLE] service=cp event=chat_run_queued requestId={} sessionId={} runId={} reason=agent_down",
                        requestId, sessionId, runId);
                return ResponseEntity.accepted().body(Map.of(
                    "status", "queued",
                    "sessionId", sessionId,
                    "runId", runId,
                    "reason", "agent_down"
                ));
            }
            // Queue full → fall through to attempt direct call
        }

        Session session;
        try {
            session = sessionService.requireCurrent(sessionId, userId, workspaceId);
        } catch (com.cc01cc.p.xihe.cp.config.CpApiException e) {
            // Session missing for this user/workspace: create a fresh one tied to this conversation.
            String title = content.length() > 50 ? content.substring(0, 50) + "..." : content;
            session = sessionService.createWithId(sessionId, userId, workspaceId, title, null, null);
        }

        List<String> attachmentIds = extractAttachmentIds(request);
        List<com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo> attachmentInfos = new ArrayList<>();
        if (!attachmentIds.isEmpty()) {
            for (String fileId : attachmentIds) {
                File file = fileRepository.findById(fileId).orElse(null);
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
                    file.getId(), file.getFilename(), file.getMimeType(), file.getSizeBytes(), "/api/v1/files/" + file.getId()
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

        if (!acquireRun(sessionId, runId)) {
            logger.warn("[LIFECYCLE] service=cp event=chat_sse_rejected requestId={} sessionId={} runId={} errorCode=CHAT_IN_PROGRESS",
                    requestId, sessionId, runId);
            return ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT, "CHAT_IN_PROGRESS", "A chat run is already active for this session");
        }

        boolean handedOff = false;
        try {
            Message userMessage = new Message(sessionId, MessageRole.USER, content);
            userMessage.setAttachments(attachmentsJson);
            messageRepository.save(userMessage);

            if (!attachmentIds.isEmpty()) {
                for (String fileId : attachmentIds) {
                    File file = fileRepository.findById(fileId).orElse(null);
                    if (file != null) {
                        file.setMessageId(userMessage.getId());
                        fileRepository.save(file);
                    }
                }
            }

            logger.info("[LIFECYCLE] service=cp event=chat_message_persisted requestId={} sessionId={} runId={} messageId={} attachments={}",
                    requestId, sessionId, runId, userMessage.getId(), attachmentIds.size());

            execAsync(sessionId, content, model, attachmentInfos, userId, workspaceId, requestId, runId);
            handedOff = true;
            return ResponseEntity.accepted().body(Map.of(
                "status", "accepted",
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

    @GetMapping("/api/v1/health")
    public Map<String, Object> health() {
        return Map.of(
            "status", "UP",
            "service", "xihe-control-plane",
            "timestamp", System.currentTimeMillis()
        );
    }

    private void execAsync(String sessionId, String content, String model,
                           List<com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo> attachments,
                           String userId, String workspaceId, String requestId, String runId) {
        Thread worker = new Thread(() -> {
            MDC.put("requestId", requestId);
            MDC.put("chatRunId", runId);
            AtomicBoolean terminalSent = new AtomicBoolean(false);
            try {
                Map<String, Object> agentRequest = new java.util.LinkedHashMap<>();
                agentRequest.put("sessionId", sessionId);
                agentRequest.put("content", content);
                agentRequest.put("userId", userId);
                agentRequest.put("workspaceId", workspaceId);
                agentRequest.put("requestId", requestId);
                agentRequest.put("runId", runId);
                agentRequest.put("stream", true);
                if (model != null && !model.isEmpty()) {
                    agentRequest.put("model", model);
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

                HttpRequest agentRequestMessage = HttpRequest.newBuilder(URI.create(agentUrl))
                    .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                    .header(HttpHeaders.ACCEPT, MediaType.TEXT_EVENT_STREAM_VALUE)
                    .header("Authorization", "Bearer " + agentApiToken)
                    .header("X-Request-Id", requestId)
                    .header("X-Chat-Run-Id", runId)
                    .header("X-User-Id", userId)
                    .header("X-Workspace-Id", workspaceId)
                    .header("X-Session-Id", sessionId)
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
                    try (InputStream ignored = response.body()) {
                        // Do not log an upstream body: it may contain provider details or credentials.
                    }
                    logger.error("[LIFECYCLE] service=cp event=chat_run_failed requestId={} sessionId={} runId={} errorCode=AGENT_UNAVAILABLE upstreamStatus={} durationMs={}",
                            requestId, sessionId, runId, response.statusCode(), elapsedMs);
                    healthMonitor.getAgentBreaker().recordFailure();
                    sendRunErrorAndDone(sessionId, requestId, runId, "AGENT_UNAVAILABLE", "Agent service unavailable", terminalSent);
                    return;
                }

                healthMonitor.getAgentBreaker().recordSuccess();
                logger.info("[LIFECYCLE] service=cp event=chat_run_forwarded requestId={} sessionId={} runId={} status={} durationMs={}",
                        requestId, sessionId, runId, response.statusCode(), elapsedMs);
                String assistantContent;
                try (InputStream agentStream = response.body()) {
                    assistantContent = relayAgentStream(sessionId, agentStream, requestId, runId, terminalSent);
                }
                logger.info("[LIFECYCLE] service=cp event=chat_run_finished requestId={} sessionId={} runId={} assistantChars={}",
                        requestId, sessionId, runId, assistantContent == null ? 0 : assistantContent.length());

                if (assistantContent != null && !assistantContent.isBlank()) {
                    Message assistantMessage = new Message(sessionId, MessageRole.ASSISTANT, assistantContent);
                    messageRepository.save(assistantMessage);
                    logger.info("[LIFECYCLE] service=cp event=chat_assistant_persisted requestId={} sessionId={} runId={} messageId={} assistantChars={}",
                            requestId, sessionId, runId, assistantMessage.getId(), assistantContent.length());
                }

            } catch (java.net.http.HttpTimeoutException e) {
                logger.warn("[LIFECYCLE] service=cp event=chat_run_failed requestId={} sessionId={} runId={} errorCode=AGENT_TIMEOUT timeoutMs=30000",
                        requestId, sessionId, runId, e);
                healthMonitor.getAgentBreaker().recordFailure();
                sendRunErrorAndDone(sessionId, requestId, runId, "AGENT_TIMEOUT", "Agent request timed out after 30 seconds", terminalSent);
            } catch (Exception e) {
                logger.error("[LIFECYCLE] service=cp event=chat_run_failed requestId={} sessionId={} runId={} errorCode=CHAT_EXECUTION_FAILED",
                        requestId, sessionId, runId, e);
                healthMonitor.getAgentBreaker().recordFailure();
                sendRunErrorAndDone(sessionId, requestId, runId, "CHAT_EXECUTION_FAILED", "Chat execution failed", terminalSent);
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
                                     String errorCode, String detail, AtomicBoolean terminalSent) {
        if (!terminalSent.compareAndSet(false, true)) {
            logger.warn("[LIFECYCLE] service=cp event=chat_run_terminal_ignored requestId={} sessionId={} runId={} errorCode={} reason=terminal_already_sent",
                    requestId, sessionId, runId, errorCode);
            return;
        }
        sseManager.send(sessionId, "error", Map.of(
                "code", errorCode,
                "requestId", requestId,
                "runId", runId,
                "detail", detail,
                "type", "error"));
        sseManager.send(sessionId, "done", Map.of(
                "type", "done",
                "requestId", requestId,
                "runId", runId,
                "errorCode", errorCode,
                "synthetic", true));
    }

    private boolean acquireRun(String sessionId, String runId) {
        return activeRuns.putIfAbsent(sessionId, runId) == null;
    }

    private void releaseRun(String sessionId, String runId, String reason) {
        if (activeRuns.remove(sessionId, runId)) {
            logger.info("[LIFECYCLE] service=cp event=chat_run_lease_released sessionId={} runId={} reason={}",
                    sessionId, runId, reason);
        } else {
            logger.debug("[LIFECYCLE] service=cp event=chat_run_lease_release_ignored sessionId={} runId={} reason={}",
                    sessionId, runId, reason);
        }
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

    private String relayAgentStream(String sessionId, InputStream agentStream,
                                    String requestId, String runId,
                                    AtomicBoolean terminalSent) throws Exception {
        StringBuilder assistantContent = new StringBuilder();
        Map<String, Integer> eventCounts = new LinkedHashMap<>();
        boolean doneSeen = false;
        int eventIndex = 0;
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
                    collectEventContent(assistantContent, eventName, data.toString());
                    if (!isDone || terminalSent.compareAndSet(false, true)) {
                        dispatchEvent(sessionId, eventName, data.toString());
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
            collectEventContent(assistantContent, eventName, data.toString());
            if (!isDone || terminalSent.compareAndSet(false, true)) {
                dispatchEvent(sessionId, eventName, data.toString());
            }
        }
        if (!doneSeen) {
            logger.warn("[LIFECYCLE] service=cp event=chat_run_missing_done requestId={} sessionId={} runId={} errorCode=AGENT_DONE_MISSING",
                    requestId, sessionId, runId);
            if (terminalSent.compareAndSet(false, true)) {
                dispatchEvent(sessionId, "done", "{\"type\":\"done\",\"synthetic\":true}");
            }
            eventCounts.put("done", 1);
        }
        logger.info("[LIFECYCLE] service=cp event=chat_stream_relay_finished requestId={} sessionId={} runId={} tokenCount={} assistantChars={}",
                requestId, sessionId, runId, eventCounts.getOrDefault("token", 0), assistantContent.length());
        return assistantContent.toString();
    }

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

    private Object parsePayload(String eventName, String payload) {
        try {
            return objectMapper.readValue(payload, Object.class);
        } catch (Exception e) {
            logger.debug("Failed to parse SSE payload as JSON, falling back to raw text: {}", e.getMessage());
            return Map.of("content", payload, "type", eventName);
        }
    }
}
