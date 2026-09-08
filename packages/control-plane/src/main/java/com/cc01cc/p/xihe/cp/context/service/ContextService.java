package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;

@Service
public class ContextService {

    private final EventStoreService eventStoreService;
    private final ContextProjectionService projectionService;

    public ContextService(EventStoreService eventStoreService,
                          ContextProjectionService projectionService) {
        this.eventStoreService = eventStoreService;
        this.projectionService = projectionService;
    }

    @Transactional
    public ContextEvent appendEvent(String sessionId, String workspaceId, String userId,
                                    String eventType, Object payload) {
        return eventStoreService.append(sessionId, workspaceId, userId, eventType, payload);
    }

    @Transactional
    public List<ContextEvent> appendBatch(String sessionId, String workspaceId, String userId,
                                          List<EventStoreService.EventPayload> payloads) {
        return eventStoreService.appendBatch(sessionId, workspaceId, userId, payloads);
    }

    @Transactional(readOnly = true)
    public ObjectNode getSnapshot(String sessionId, String workspaceId, String userId, Long afterSequence) {
        long effectiveAfter = afterSequence != null ? afterSequence : 0L;
        return projectionService.projectAndSave(sessionId, workspaceId, userId, effectiveAfter);
    }

    @Transactional(readOnly = true)
    public List<ContextEvent> readEvents(String sessionId, Long afterSequence) {
        return eventStoreService.read(sessionId, afterSequence);
    }

    @Transactional(readOnly = true)
    public Map<String, Object> replay(String sessionId, String workspaceId, String userId, Long afterSequence) {
        long effectiveAfter = afterSequence != null ? afterSequence : 0L;
        ObjectNode snapshot = projectionService.projectAndSave(sessionId, workspaceId, userId, effectiveAfter);
        List<ContextEvent> events = eventStoreService.read(sessionId, effectiveAfter);
        return Map.of("snapshot", snapshot, "events", events);
    }

    @Transactional(readOnly = true)
    public Long getLatestSequence(String sessionId) {
        return eventStoreService.getLatestSequence(sessionId);
    }

    @Transactional
    public Long fork(String sourceSessionId, Long atSequence, String newSessionId,
                     String workspaceId, String userId) {
        Long latestSequence = eventStoreService.fork(
                sourceSessionId, atSequence, newSessionId, workspaceId, userId);
        eventStoreService.append(newSessionId, workspaceId, userId, "session.forked", Map.of(
                "source_session_id", sourceSessionId,
                "at_sequence", atSequence
        ));
        return eventStoreService.getLatestSequence(newSessionId);
    }

    @Transactional
    public ContextEvent compact(String sessionId, String workspaceId, String userId, Long upToSequence) {
        long effectiveUpTo = upToSequence != null ? upToSequence : eventStoreService.getLatestSequence(sessionId);
        ObjectNode context = projectionService.projectUpTo(sessionId, effectiveUpTo);
        String summary = summarizeMessages(context);

        // Compute summary hash for integrity verification
        String summaryHash = computeSha256(summary);

        // Determine context epoch (new epoch after compaction)
        String newEpochId = java.util.UUID.randomUUID().toString();

        // Keep task plan items that are not completed (resume-friendly)
        java.util.List<String> keptItemIds = new java.util.ArrayList<>();
        com.fasterxml.jackson.databind.JsonNode taskPlan = context.get("metadata").get("task_plan");
        if (taskPlan != null && taskPlan.has("items")) {
            for (com.fasterxml.jackson.databind.JsonNode item : taskPlan.get("items")) {
                String status = item.has("status") ? item.get("status").asText() : "pending";
                if (!"completed".equals(status) && item.has("id")) {
                    keptItemIds.add(item.get("id").asText());
                }
            }
        }

        return eventStoreService.append(sessionId, workspaceId, userId, "compaction.applied", Map.of(
                "up_to_sequence", effectiveUpTo,
                "summary", summary,
                "summaryHash", summaryHash,
                "contextEpoch", newEpochId,
                "keptItemIds", keptItemIds,
                "compacted_message_count", context.get("messages").size()
        ));
    }

    public boolean shouldAutoCompact(String sessionId) {
        long latestSeq = eventStoreService.getLatestSequence(sessionId);
        ObjectNode context = projectionService.project(sessionId, latestSeq);
        if (context == null) return false;

        // Threshold 1: message count > 50
        com.fasterxml.jackson.databind.JsonNode messages = context.get("messages");
        if (messages != null && messages.size() > 50) return true;

        // Threshold 2: metadata token_count > 100000 (estimated)
        com.fasterxml.jackson.databind.JsonNode meta = context.get("metadata");
        if (meta != null && meta.has("token_count") && meta.get("token_count").asInt(0) > 100000) return true;

        // Threshold 3: tool_calls count > 20
        if (meta != null && meta.has("tool_calls")) {
            com.fasterxml.jackson.databind.JsonNode toolCalls = meta.get("tool_calls");
            if (toolCalls.isArray() && toolCalls.size() > 20) return true;
        }

        return false;
    }

    private String computeSha256(String data) {
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(data.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : hash) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            return "hash_error";
        }
    }

    private String summarizeMessages(ObjectNode context) {
        ArrayNode messages = (ArrayNode) context.get("messages");
        if (messages == null || messages.isEmpty()) {
            return "No messages to compact.";
        }
        StringBuilder sb = new StringBuilder("Compacted conversation summary: ");
        messages.forEach(msg -> sb.append("[").append(msg.get("role").asText()).append("]: ")
                .append(msg.get("content").asText()).append("; "));
        return sb.toString();
    }
}
