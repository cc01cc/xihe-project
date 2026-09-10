package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;

@Service
public class ContextService {

    private static final Logger logger = LoggerFactory.getLogger(ContextService.class);

    private final EventStoreService eventStoreService;
    private final ContextProjectionService projectionService;
    private final ObjectMapper objectMapper;

    public ContextService(EventStoreService eventStoreService,
                          ContextProjectionService projectionService,
                          ObjectMapper objectMapper) {
        this.eventStoreService = eventStoreService;
        this.objectMapper = objectMapper;
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

    // PLAN-294 decision #7 (M2): messages inside the recent window are kept
    // verbatim in the projection and excluded from summarization.
    static final int KEEP_RECENT_MESSAGES = 10;

    @Transactional
    public ContextEvent compact(String sessionId, String workspaceId, String userId, Long upToSequence) {
        long latestSequence = eventStoreService.getLatestSequence(sessionId);
        long effectiveUpTo = upToSequence != null ? Math.min(upToSequence, latestSequence) : latestSequence;

        // PLAN-294 decision #16 (appendix D.3): resume from the previous
        // compaction cursor instead of re-summarizing from sequence 0 — the
        // prior summary is merged with the increment, never recomputed.
        com.fasterxml.jackson.databind.JsonNode previous = latestCompaction(sessionId);
        long previousCursor = previous != null && previous.has("up_to_sequence")
                ? previous.get("up_to_sequence").asLong() : 0L;
        String previousSummary = previous != null && previous.has("summary")
                ? previous.get("summary").asText() : null;

        ObjectNode context = projectionService.projectUpTo(sessionId, effectiveUpTo);
        String summary = summarizeMessages(context, previousSummary, previousCursor);

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

        int keptRecent = countRecentWindow(context);
        return eventStoreService.append(sessionId, workspaceId, userId, "compaction.applied", Map.of(
                "up_to_sequence", effectiveUpTo,
                "summary", summary,
                "summaryHash", summaryHash,
                "contextEpoch", newEpochId,
                "keptItemIds", keptItemIds,
                "compacted_message_count", context.get("messages").size(),
                "kept_recent_count", keptRecent
        ));
    }

    /** Latest compaction.applied event payload for the session, or null. */
    private com.fasterxml.jackson.databind.JsonNode latestCompaction(String sessionId) {
        List<com.cc01cc.p.xihe.cp.context.entity.ContextEvent> events = eventStoreService.read(sessionId, 0L);
        for (int i = events.size() - 1; i >= 0; i--) {
            com.cc01cc.p.xihe.cp.context.entity.ContextEvent e = events.get(i);
            if ("compaction.applied".equals(e.getEventType())) {
                try {
                    return objectMapper.readTree(e.getPayload());
                } catch (Exception ex) {
                    logger.warn("[LIFECYCLE] service=cp event=compaction_payload_parse_failed sessionId={}", sessionId);
                    return null;
                }
            }
        }
        return null;
    }

    /** Messages inside the keep-recent window (mirrors the projection tail). */
    private int countRecentWindow(ObjectNode context) {
        com.fasterxml.jackson.databind.JsonNode messages = context.get("messages");
        if (messages == null || !messages.isArray()) return 0;
        return Math.min(KEEP_RECENT_MESSAGES, messages.size());
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

    // PLAN-294 decision #3 / appendix E.3: structured sectioned summary with
    // verbatim identifier preservation — free-form concatenation lost too much
    // (industry evidence: constraint retention 17%, artifact tracking 2.45/5).
    private static final int GOAL_MAX_CHARS = 500;
    private static final int ERRORS_KEPT = 3;

    private String summarizeMessages(ObjectNode context, String previousSummary, long previousCursor) {
        ArrayNode messages = (ArrayNode) context.get("messages");
        if (messages == null || messages.isEmpty()) {
            return previousSummary != null ? previousSummary : "No messages to compact.";
        }

        StringBuilder goal = new StringBuilder();
        java.util.Set<String> files = new java.util.LinkedHashSet<>();
        List<String> errors = new java.util.ArrayList<>();
        List<String> recent = new java.util.ArrayList<>();
        List<String> decisions = new java.util.ArrayList<>();

        int size = messages.size();
        int recentStart = Math.max(0, size - KEEP_RECENT_MESSAGES);
        for (int i = 0; i < size; i++) {
            com.fasterxml.jackson.databind.JsonNode msg = messages.get(i);
            String role = msg.path("role").asText("");
            String content = msg.path("content").asText("");
            if (content.isBlank()) continue;

            if ("human".equals(role) && goal.length() == 0) {
                goal.append(content, 0, Math.min(content.length(), GOAL_MAX_CHARS));
            }
            // File-path extraction (verbatim): workspace-relative POSIX paths.
            java.util.regex.Matcher m = FILE_PATH_PATTERN.matcher(content);
            while (m.find()) {
                files.add(m.group());
            }
            if (content.contains("error") || content.contains("Error") || content.contains("ERROR")) {
                errors.add(content.length() > 300 ? content.substring(0, 300) : content);
            }
            if (i >= recentStart) {
                recent.add("[" + role + "] " + (content.length() > 200 ? content.substring(0, 200) : content));
            }
        }

        StringBuilder sb = new StringBuilder();
        if (previousSummary != null && !previousSummary.isBlank()) {
            // Incremental merge (decision #16): prior sections carry forward.
            sb.append(previousSummary).append('\n');
        } else {
            sb.append("[Goal] ").append(goal.length() > 0 ? goal : "(not stated)").append('\n');
        }
        sb.append("[Decisions] approval decisions and user constraints are preserved verbatim in the event store and remain binding\n");
        if (!files.isEmpty()) {
            sb.append("[Files&Artifacts] ").append(String.join(", ", files)).append('\n');
        }
        if (!errors.isEmpty()) {
            sb.append("[Errors] ");
            int from = Math.max(0, errors.size() - ERRORS_KEPT);
            for (int i = from; i < errors.size(); i++) {
                sb.append(errors.get(i)).append(i < errors.size() - 1 ? " | " : "");
            }
            sb.append('\n');
        }
        sb.append("[Recent] ");
        for (int i = 0; i < recent.size(); i++) {
            sb.append(recent.get(i)).append(i < recent.size() - 1 ? " ; " : "");
        }
        return sb.toString();
    }

    private static final java.util.regex.Pattern FILE_PATH_PATTERN = java.util.regex.Pattern.compile(
            "[A-Za-z0-9_\\-./]+\\.[A-Za-z0-9]{1,8}");
}
