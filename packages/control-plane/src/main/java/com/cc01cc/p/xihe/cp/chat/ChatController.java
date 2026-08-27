package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;

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
            WorkspaceUserRepository workspaceUserRepository) {
        this.agentHttpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
        this.objectMapper = objectMapper;
        this.sseManager = sseManager;
        this.sessionRepository = sessionRepository;
        this.messageRepository = messageRepository;
        this.fileRepository = fileRepository;
        this.workspaceUserRepository = workspaceUserRepository;
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
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of(
                "status", "error",
                "message", "No active SSE subscription for session"
            ));
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
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of(
                "status", "error",
                "message", "Session does not belong to workspace"
            ));
        }

        if (!workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(effectiveWorkspaceId, effectiveUserId).isPresent()) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of(
                "status", "error",
                "message", "User is not a member of the workspace"
            ));
        }

        List<String> attachmentIds = extractAttachmentIds(request);
        List<com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo> attachmentInfos = new ArrayList<>();
        if (!attachmentIds.isEmpty()) {
            for (String fileId : attachmentIds) {
                File file = fileRepository.findById(fileId).orElse(null);
                if (file == null) {
                    return ResponseEntity.badRequest().body(Map.of(
                        "status", "error",
                        "message", "Attachment not found: " + fileId
                    ));
                }
                if (!sessionId.equals(file.getSessionId())) {
                    return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of(
                        "status", "error",
                        "message", "Attachment does not belong to session: " + fileId
                    ));
                }
                attachmentInfos.add(new com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo(
                    file.getId(), file.getFilename(), file.getMimeType(), file.getSizeBytes(), "/files/" + file.getId()
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
                return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of(
                    "status", "error",
                    "message", "Failed to serialize attachments"
                ));
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

        execAsync(sessionId, content, model, attachmentInfos);
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
        execAsync(sessionId, content, null, List.of());
    }

    private void execAsync(String sessionId, String content, String model) {
        execAsync(sessionId, content, model, List.of());
    }

    private void execAsync(String sessionId, String content, String model,
                           List<com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo> attachments) {
        new Thread(() -> {
            try {
                Map<String, Object> agentRequest = new java.util.HashMap<>();
                agentRequest.put("session_id", sessionId);
                agentRequest.put("content", content);
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

            } catch (Exception e) {
                String errorMsg = e.getMessage() != null ? e.getMessage() : "Unknown error";
                logger.error("Chat request failed session={} error={}", sessionId, errorMsg, e);
                sseManager.send(sessionId, "error", Map.of("error", errorMsg, "type", "error"));
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
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(agentStream, StandardCharsets.UTF_8))) {
            String eventName = "message";
            StringBuilder data = new StringBuilder();
            String line;

            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
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

            collectEventContent(assistantContent, eventName, data.toString());
            dispatchEvent(sessionId, eventName, data.toString());
        }
        return assistantContent.toString();
    }

    private void collectEventContent(StringBuilder builder, String eventName, String payload) {
        if (!"message".equals(eventName) || payload == null || payload.isBlank()) {
            return;
        }
        Object parsed = parsePayload(eventName, payload);
        if (parsed instanceof Map<?, ?> map) {
            Object content = map.get("content");
            if (content instanceof String s && !s.isBlank()) {
                builder.append(s);
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
