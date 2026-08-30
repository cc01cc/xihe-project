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
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.status.HealthMonitor;
import com.cc01cc.p.xihe.cp.status.RequestQueue;
import com.cc01cc.p.xihe.cp.status.CircuitBreaker;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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

@RestController
public class ChatController {

    private static final Logger logger = LoggerFactory.getLogger(ChatController.class);

    private final HttpClient agentHttpClient;
    private final ObjectMapper objectMapper;
    private final SseEmitterManager sseManager;
    private final SessionRepository sessionRepository;
    private final MessageRepository messageRepository;
    private final FileRepository fileRepository;
    private final WorkspaceUserRepository workspaceUserRepository;
    private final HealthMonitor healthMonitor;
    private final RequestQueue requestQueue;

    @Value("${cp.agent-url:http://localhost:12632/chat}")
    private String agentUrl;

    @Value("${cp.agent-api-token:dev-token-not-secure}")
    private String agentApiToken;

    public ChatController(
            ObjectMapper objectMapper,
            SseEmitterManager sseManager,
            SessionRepository sessionRepository,
            MessageRepository messageRepository,
            FileRepository fileRepository,
            WorkspaceUserRepository workspaceUserRepository,
            HealthMonitor healthMonitor,
            RequestQueue requestQueue) {
        this.agentHttpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        this.objectMapper = objectMapper;
        this.sseManager = sseManager;
        this.sessionRepository = sessionRepository;
        this.messageRepository = messageRepository;
        this.fileRepository = fileRepository;
        this.workspaceUserRepository = workspaceUserRepository;
        this.healthMonitor = healthMonitor;
        this.requestQueue = requestQueue;

        // Wire drain callback: when agent recovers, drain queued requests
        healthMonitor.setOnServiceRecovered(serviceName -> {
            if ("agent".equals(serviceName)) {
                requestQueue.drain(req -> {
                    logger.info("[LIFECYCLE] service=cp event=requestRedelivered sessionId={}", req.sessionId());
                    execAsync(req.sessionId(), req.content(), req.model(), List.of(), req.workspaceId());
                });
            }
        });
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping(path = "/api/v1/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@RequestParam(name = "sessionId", defaultValue = "default") String sessionId) {
        SseEmitter emitter = sseManager.createEmitter(sessionId);
        sseManager.send(sessionId, "connected", Map.of("sessionId", sessionId, "type", "connected"));
        logger.info("SSE stream connected session={}", sessionId);
        return emitter;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/exec")
    public ResponseEntity<Map<String, Object>> exec(@RequestBody Map<String, Object> request) {
        String sessionId = (String) request.getOrDefault("sessionId", "default");
        String content = (String) request.getOrDefault("content", "");
        String model = (String) request.get("model");

        if (!sseManager.hasEmitter(sessionId)) {
            logger.warn("Rejected chat request without SSE subscription session={}", sessionId);
            return ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT, "SSE_SUBSCRIPTION_REQUIRED", "An active SSE subscription is required");
        }

        logger.info("Received chat request session={} contentLength={}", sessionId, content.length());

        execAsync(sessionId, content, model);
        return ResponseEntity.accepted().body(Map.of(
            "status", "accepted",
            "sessionId", sessionId
        ));
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/api/v1/chat")
    public ResponseEntity<Map<String, Object>> chat(@RequestBody Map<String, Object> request) {
        String sessionId = (String) request.getOrDefault("sessionId", "default");
        String content = (String) request.getOrDefault("content", "");
        String model = (String) request.get("model");
        String userId = (String) request.getOrDefault("userId", "anonymous");
        String workspaceId = (String) request.getOrDefault("workspaceId", "default");

        String tokenUserId = TenantContext.getUserId();
        String tokenWorkspaceId = TenantContext.getWorkspaceId();
        if (tokenUserId != null) {
            userId = tokenUserId;
        }
        if (tokenWorkspaceId != null) {
            workspaceId = tokenWorkspaceId;
        }
        final String effectiveUserId = userId;
        final String effectiveWorkspaceId = workspaceId;

        if (!sseManager.hasEmitter(sessionId)) {
            logger.warn("Rejected chat request without SSE subscription session={}", sessionId);
            return ProblemDetailsHandler.problemResponse(HttpStatus.CONFLICT, "SSE_SUBSCRIPTION_REQUIRED", "An active SSE subscription is required");
        }

        // Circuit breaker check
        CircuitBreaker agentBreaker = healthMonitor.getAgentBreaker();
        if (!agentBreaker.allowRequest()) {
            logger.warn("[LIFECYCLE] service=cp event=chatRejectedCircuitOpen session={}", sessionId);
            String requestId = java.util.UUID.randomUUID().toString();
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
            boolean queued = requestQueue.enqueue(sessionId, content, model, effectiveUserId, effectiveWorkspaceId);
            if (queued) {
                return ResponseEntity.accepted().body(Map.of(
                    "status", "queued",
                    "sessionId", sessionId,
                    "reason", "agent_down"
                ));
            }
            // Queue full → fall through to attempt direct call
        }

        Session session = sessionRepository.findById(sessionId)
                .orElseGet(() -> {
                    Session newSession = new Session(effectiveWorkspaceId, effectiveUserId, content.length() > 50
                            ? content.substring(0, 50) + "..."
                            : content);
                    newSession.setId(sessionId);
                    return sessionRepository.save(newSession);
                });

        if (!session.getWorkspaceId().equals(effectiveWorkspaceId)) {
            logger.warn("Rejected chat request for session outside workspace session={} workspace={}", sessionId, effectiveWorkspaceId);
            return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", "Session does not belong to workspace");
        }

        if (!workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(effectiveWorkspaceId, effectiveUserId).isPresent()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", "User is not a member of the workspace");
        }

        List<String> attachmentIds = extractAttachmentIds(request);
        List<com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo> attachmentInfos = new ArrayList<>();
        if (!attachmentIds.isEmpty()) {
            for (String fileId : attachmentIds) {
                File file = fileRepository.findById(fileId).orElse(null);
                if (file == null) {
                    return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "ATTACHMENT_NOT_FOUND", "Attachment not found");
                }
                if (!sessionId.equals(file.getSessionId())) {
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

        logger.info("Persisted message session={} messageId={} attachments={}", sessionId, userMessage.getId(), attachmentIds.size());

        execAsync(sessionId, content, model, attachmentInfos, effectiveWorkspaceId);
        return ResponseEntity.accepted().body(Map.of(
            "status", "accepted",
            "sessionId", sessionId,
            "messageId", userMessage.getId()
        ));
    }

    @GetMapping("/api/v1/health")
    public Map<String, Object> health() {
        return Map.of(
            "status", "UP",
            "service", "xihe-control-plane",
            "timestamp", System.currentTimeMillis()
        );
    }

    private void execAsync(String sessionId, String content) {
        execAsync(sessionId, content, null, List.of(), "default");
    }

    private void execAsync(String sessionId, String content, String model) {
        execAsync(sessionId, content, model, List.of(), "default");
    }

    private void execAsync(String sessionId, String content, String model,
                           List<com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo> attachments) {
        execAsync(sessionId, content, model, attachments, "default");
    }

    private void execAsync(String sessionId, String content, String model,
                           List<com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo> attachments,
                           String workspaceId) {
        new Thread(() -> {
            try {
                Map<String, Object> agentRequest = new java.util.LinkedHashMap<>();
                agentRequest.put("sessionId", sessionId);
                agentRequest.put("content", content);
                agentRequest.put("workspaceId", workspaceId);
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
                    String errorBody;
                    try (InputStream errorStream = response.body()) {
                        errorBody = new String(errorStream.readAllBytes(), StandardCharsets.UTF_8);
                    }

                    logger.error("[LIFECYCLE] service=cp event=chatForwardFailed session={} status={} elapsedMs={} body={}",
                            sessionId, response.statusCode(), elapsedMs, errorBody);
                    healthMonitor.getAgentBreaker().recordFailure();
                    sseManager.send(sessionId, "error", Map.of(
                        "code", "AGENT_UNAVAILABLE",
                        "requestId", java.util.UUID.randomUUID().toString(),
                        "detail", "Agent service unavailable",
                        "type", "error"
                    ));
                    return;
                }

                healthMonitor.getAgentBreaker().recordSuccess();
                logger.info("[LIFECYCLE] service=cp event=chatForwarded session={} status={} elapsedMs={}", sessionId, response.statusCode(), elapsedMs);
                String assistantContent;
                try (InputStream agentStream = response.body()) {
                    assistantContent = relayAgentStream(sessionId, agentStream);
                }
                logger.info("Agent stream completed session={}", sessionId);

                if (assistantContent != null && !assistantContent.isBlank()) {
                    Message assistantMessage = new Message(sessionId, MessageRole.ASSISTANT, assistantContent);
                    messageRepository.save(assistantMessage);
                    logger.info("Persisted assistant reply session={} messageId={}", sessionId, assistantMessage.getId());
                }

            } catch (java.net.http.HttpTimeoutException e) {
                logger.warn("[LIFECYCLE] service=cp event=chatTimeout session={} timeoutMs=30000", sessionId);
                healthMonitor.getAgentBreaker().recordFailure();
                sseManager.send(sessionId, "error", Map.of(
                    "code", "AGENT_TIMEOUT",
                    "requestId", java.util.UUID.randomUUID().toString(),
                    "detail", "Agent request timed out after 30 seconds",
                    "type", "error"
                ));
            } catch (Exception e) {
                logger.error("[LIFECYCLE] service=cp event=chatForwardFailed session={} error={}", sessionId, e.getMessage(), e);
                healthMonitor.getAgentBreaker().recordFailure();
                sseManager.send(sessionId, "error", Map.of(
                    "code", "CHAT_EXECUTION_FAILED",
                    "requestId", java.util.UUID.randomUUID().toString(),
                    "detail", "Chat execution failed",
                    "type", "error"));
            } finally {
                // The Agent may close without emitting the terminal event.
                // Always release the UI stream after relay success or failure.
                sseManager.complete(sessionId);
            }
        }).start();
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

    private String relayAgentStream(String sessionId, InputStream agentStream) throws Exception {
        StringBuilder assistantContent = new StringBuilder();
        Map<String, Integer> eventCounts = new LinkedHashMap<>();
        boolean doneSeen = false;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(agentStream, StandardCharsets.UTF_8))) {
            String eventName = "message";
            StringBuilder data = new StringBuilder();
            String line;

            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    recordStreamEvent(eventCounts, eventName, data.length());
                    doneSeen = doneSeen || "done".equals(eventName);
                    collectEventContent(assistantContent, eventName, data.toString());
                    dispatchEvent(sessionId, eventName, data.toString());
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

            recordStreamEvent(eventCounts, eventName, data.length());
            doneSeen = doneSeen || "done".equals(eventName);
            collectEventContent(assistantContent, eventName, data.toString());
            dispatchEvent(sessionId, eventName, data.toString());
        }
        if (!doneSeen) {
            logger.warn("Agent SSE stream missing done event session={}; emitting relay fallback", sessionId);
            dispatchEvent(sessionId, "done", "{\"type\":\"done\",\"synthetic\":true}");
            eventCounts.put("done", 1);
        }
        logger.info("Agent SSE relay completed session={} events={} assistantChars={}",
                sessionId, eventCounts, assistantContent.length());
        return assistantContent.toString();
    }

    private void recordStreamEvent(Map<String, Integer> eventCounts, String eventName, int payloadLength) {
        if (payloadLength <= 0) {
            return;
        }
        eventCounts.merge(eventName, 1, Integer::sum);
        logger.debug("Agent SSE event received event={} payloadLength={}", eventName, payloadLength);
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
