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
        return eventStoreService.append(sessionId, workspaceId, userId, "compaction.applied", Map.of(
                "up_to_sequence", effectiveUpTo,
                "summary", summary,
                "compacted_message_count", context.get("messages").size()
        ));
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
