package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;

import org.springframework.security.access.prepost.PreAuthorize;

@RestController
public class ChatController {

    private static final Logger logger = LoggerFactory.getLogger(ChatController.class);

    private final HttpClient agentHttpClient;
    private final ObjectMapper objectMapper;
    private final SseEmitterManager sseManager;
    private final SessionRepository sessionRepository;
    private final MessageRepository messageRepository;

    @Value("${cp.agent-url:http://localhost:12632/chat}")
    private String agentUrl;

    @Value("${cp.agent-api-token:dev-token-not-secure}")
    private String agentApiToken;

    public ChatController(
            ObjectMapper objectMapper,
            SseEmitterManager sseManager,
            SessionRepository sessionRepository,
            MessageRepository messageRepository) {
        this.agentHttpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        this.objectMapper = objectMapper;
        this.sseManager = sseManager;
        this.sessionRepository = sessionRepository;
        this.messageRepository = messageRepository;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping(path = "/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@RequestParam(name = "session_id", defaultValue = "default") String sessionId) {
        SseEmitter emitter = sseManager.createEmitter(sessionId);
        sseManager.send(sessionId, "connected", Map.of("session_id", sessionId, "type", "connected"));
        logger.info("SSE stream connected session={}", sessionId);
        return emitter;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/exec")
    public ResponseEntity<Map<String, Object>> exec(@RequestBody Map<String, Object> request) {
        String sessionId = (String) request.getOrDefault("session_id", "default");
        String content = (String) request.getOrDefault("content", "");
        String model = (String) request.get("model");

        if (!sseManager.hasEmitter(sessionId)) {
            logger.warn("Rejected chat request without SSE subscription session={}", sessionId);
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of(
                "status", "error",
                "message", "No active SSE subscription for session"
            ));
        }

        logger.info("Received chat request session={} contentLength={}", sessionId, content.length());

        execAsync(sessionId, content, model);
        return ResponseEntity.accepted().body(Map.of(
            "status", "accepted",
            "session_id", sessionId
        ));
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @PostMapping("/chat")
    public ResponseEntity<Map<String, Object>> chat(@RequestBody Map<String, Object> request) {
        String sessionId = (String) request.getOrDefault("session_id", "default");
        String content = (String) request.getOrDefault("content", "");
        String model = (String) request.get("model");
        String userId = (String) request.getOrDefault("user_id", "anonymous");
        String workspaceId = (String) request.getOrDefault("workspace_id", "default");

        if (!sseManager.hasEmitter(sessionId)) {
            logger.warn("Rejected chat request without SSE subscription session={}", sessionId);
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of(
                "status", "error",
                "message", "No active SSE subscription for session"
            ));
        }

        Session session = sessionRepository.findById(sessionId)
                .orElseGet(() -> {
                    Session newSession = new Session(workspaceId, userId, content.length() > 50
                            ? content.substring(0, 50) + "..."
                            : content);
                    newSession.setId(sessionId);
                    return sessionRepository.save(newSession);
                });

        Message userMessage = new Message(sessionId, MessageRole.USER, content);
        messageRepository.save(userMessage);

        logger.info("Persisted message session={} messageId={}", sessionId, userMessage.getId());

        execAsync(sessionId, content, model);
        return ResponseEntity.accepted().body(Map.of(
            "status", "accepted",
            "session_id", sessionId,
            "message_id", userMessage.getId()
        ));
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        return Map.of(
            "status", "UP",
            "service", "xihe-control-plane",
            "timestamp", System.currentTimeMillis()
        );
    }

    private void execAsync(String sessionId, String content) {
        execAsync(sessionId, content, null);
    }

    private void execAsync(String sessionId, String content, String model) {
        new Thread(() -> {
            try {
                Map<String, Object> agentRequest = new java.util.HashMap<>();
                agentRequest.put("session_id", sessionId);
                agentRequest.put("content", content);
                agentRequest.put("stream", true);
                if (model != null && !model.isEmpty()) {
                    agentRequest.put("model", model);
                }

                HttpRequest agentRequestMessage = HttpRequest.newBuilder(URI.create(agentUrl))
                    .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
                    .header(HttpHeaders.ACCEPT, MediaType.TEXT_EVENT_STREAM_VALUE)
                    .header("X-Api-Token", agentApiToken)
                    .timeout(Duration.ofMinutes(5))
                    .POST(HttpRequest.BodyPublishers.ofString(
                        objectMapper.writeValueAsString(agentRequest), StandardCharsets.UTF_8))
                    .build();

                HttpResponse<InputStream> response = agentHttpClient.send(
                    agentRequestMessage,
                    HttpResponse.BodyHandlers.ofInputStream()
                );

                if (response.statusCode() >= 400) {
                    String errorBody;
                    try (InputStream errorStream = response.body()) {
                        errorBody = new String(errorStream.readAllBytes(), StandardCharsets.UTF_8);
                    }

                    logger.error("Agent request failed session={} status={} body={}",
                            sessionId, response.statusCode(), errorBody);
                    sseManager.send(sessionId, "error", Map.of(
                        "error", "Agent request failed: HTTP " + response.statusCode(),
                        "details", errorBody,
                        "type", "error"
                    ));
                    return;
                }

                logger.info("Streaming agent response session={} status={}", sessionId, response.statusCode());
                try (InputStream agentStream = response.body()) {
                    relayAgentStream(sessionId, agentStream);
                }
                logger.info("Agent stream completed session={}", sessionId);

            } catch (Exception e) {
                String errorMsg = e.getMessage() != null ? e.getMessage() : "Unknown error";
                logger.error("Chat request failed session={} error={}", sessionId, errorMsg, e);
                sseManager.send(sessionId, "error", Map.of("error", errorMsg, "type", "error"));
            }
        }).start();
    }

    private void relayAgentStream(String sessionId, InputStream agentStream) throws Exception {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(agentStream, StandardCharsets.UTF_8))) {
            String eventName = "message";
            StringBuilder data = new StringBuilder();
            String line;

            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
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

            dispatchEvent(sessionId, eventName, data.toString());
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
