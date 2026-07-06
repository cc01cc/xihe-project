package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.cc01cc.p.xihe.cp.context.entity.ContextProjection;
import com.cc01cc.p.xihe.cp.context.repository.ContextProjectionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.Optional;

@Service
public class ContextProjectionService {

    private static final Logger logger = LoggerFactory.getLogger(ContextProjectionService.class);

    private final EventStoreService eventStoreService;
    private final ContextProjectionRepository projectionRepository;
    private final ObjectMapper objectMapper;

    public ContextProjectionService(EventStoreService eventStoreService,
                                    ContextProjectionRepository projectionRepository,
                                    ObjectMapper objectMapper) {
        this.eventStoreService = eventStoreService;
        this.projectionRepository = projectionRepository;
        this.objectMapper = objectMapper;
    }

    @Transactional(readOnly = true)
    public ObjectNode project(String sessionId, Long afterSequence) {
        ObjectNode context = emptyContext(sessionId);
        List<ContextEvent> events = eventStoreService.read(sessionId, afterSequence);
        for (ContextEvent event : events) {
            context = apply(context, event);
        }
        return context;
    }

    @Transactional
    public ObjectNode projectAndSave(String sessionId, String workspaceId, String userId) {
        ObjectNode context = project(sessionId, 0L);
        long latestSequence = context.get("latest_sequence").asLong();

        Optional<ContextProjection> existing = projectionRepository.findBySessionId(sessionId);
        ContextProjection projection = existing.orElseGet(() -> new ContextProjection(sessionId, workspaceId, userId, context.toString()));
        projection.setWorkspaceId(workspaceId);
        projection.setUserId(userId);
        projection.setLatestSequence(latestSequence);
        projection.setPayload(context.toString());
        projectionRepository.save(projection);
        return context;
    }

    private ObjectNode apply(ObjectNode context, ContextEvent event) {
        String type = event.getEventType();
        ObjectNode payload = parsePayload(event.getPayload());
        long sequence = event.getSequence();

        switch (type) {
            case "session.created" -> {
                setWorkspaceAndUser(context, payload);
                setEpoch(context, payload);
            }
            case "prompt.admitted" -> addMessage(context, payload, "human");
            case "llm.token" -> addMessage(context, payload, "ai");
            case "tool.result" -> addMessage(context, payload, "tool");
            case "context.source_changed" -> addMessage(context, payload, "system");
            case "epoch.started", "epoch.replaced" -> setEpoch(context, payload);
            case "runtime.state_cleared" -> clearRuntimeState(context);
            case "compaction.applied" -> applyCompaction(context, payload);
            default -> logger.debug("Unhandled event type in projection: {}", type);
        }
        context.put("latest_sequence", sequence);
        return context;
    }

    private ObjectNode emptyContext(String sessionId) {
        ObjectNode context = objectMapper.createObjectNode();
        context.put("aggregate_id", sessionId);
        context.put("latest_sequence", 0L);
        context.set("messages", objectMapper.createArrayNode());
        context.set("epoch", objectMapper.createObjectNode());
        context.set("runtime_state", objectMapper.createObjectNode());
        context.set("metadata", objectMapper.createObjectNode());
        return context;
    }

    private void addMessage(ObjectNode context, ObjectNode payload, String role) {
        String content = "";
        if (payload.has("message") && payload.get("message").isObject()) {
            ObjectNode msg = (ObjectNode) payload.get("message");
            content = msg.path("content").asText("");
        } else if (payload.has("content")) {
            content = payload.path("content").asText("");
        } else if (payload.has("result")) {
            content = payload.path("result").asText("");
        } else if (payload.has("rendered_text")) {
            content = payload.path("rendered_text").asText("");
        } else if (payload.has("token")) {
            content = payload.path("token").asText("");
        }
        ObjectNode message = objectMapper.createObjectNode();
        message.put("role", role);
        message.put("content", content);
        ArrayNode messages = (ArrayNode) context.get("messages");
        messages.add(message);
    }

    private void setEpoch(ObjectNode context, ObjectNode payload) {
        ObjectNode epoch = objectMapper.createObjectNode();
        if (payload.has("epoch_id")) {
            epoch.put("epoch_id", payload.path("epoch_id").asText());
        }
        if (payload.has("baseline_hash")) {
            epoch.put("baseline_hash", payload.path("baseline_hash").asText());
        }
        ArrayNode systemMessages = objectMapper.createArrayNode();
        if (payload.has("system_messages") && payload.get("system_messages").isArray()) {
            payload.get("system_messages").forEach(node -> systemMessages.add(node.asText()));
        }
        epoch.set("system_messages", systemMessages);
        ArrayNode sources = objectMapper.createArrayNode();
        if (payload.has("snapshot") && payload.get("snapshot").has("sources")) {
            payload.get("snapshot").get("sources").forEach(sources::add);
        }
        epoch.set("sources", sources);
        context.set("epoch", epoch);
    }

    private void setWorkspaceAndUser(ObjectNode context, ObjectNode payload) {
        if (payload.has("workspace_id")) {
            context.put("workspace_id", payload.path("workspace_id").asText());
        }
        if (payload.has("user_id")) {
            context.put("user_id", payload.path("user_id").asText());
        }
    }

    private void clearRuntimeState(ObjectNode context) {
        context.set("runtime_state", objectMapper.createObjectNode());
    }

    private void applyCompaction(ObjectNode context, ObjectNode payload) {
        if (payload.has("summary")) {
            ArrayNode messages = (ArrayNode) context.get("messages");
            messages.removeAll();
            ObjectNode summaryMessage = objectMapper.createObjectNode();
            summaryMessage.put("role", "system");
            summaryMessage.put("content", payload.path("summary").asText());
            messages.add(summaryMessage);
        }
    }

    private ObjectNode parsePayload(String payload) {
        try {
            if (payload == null || payload.isBlank()) {
                return objectMapper.createObjectNode();
            }
            return (ObjectNode) objectMapper.readTree(payload);
        } catch (Exception e) {
            logger.error("Failed to parse event payload as JSON", e);
            return objectMapper.createObjectNode();
        }
    }
}
