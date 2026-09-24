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

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Service
public class ContextProjectionService {

    private static final Logger logger = LoggerFactory.getLogger(ContextProjectionService.class);

    /** Durable projection type of {@link ContextProjection}'s default. */
    private static final String AGENT_CONTEXT_TYPE = "agent_context";

    private final EventStoreService eventStoreService;
    private final ContextProjectionRepository projectionRepository;
    private final com.cc01cc.p.xihe.cp.service.BranchPathService branchPathService;
    private final ObjectMapper objectMapper;

    public ContextProjectionService(EventStoreService eventStoreService,
                                    ContextProjectionRepository projectionRepository,
                                    com.cc01cc.p.xihe.cp.service.BranchPathService branchPathService,
                                    ObjectMapper objectMapper) {
        this.eventStoreService = eventStoreService;
        this.projectionRepository = projectionRepository;
        this.branchPathService = branchPathService;
        this.objectMapper = objectMapper;
    }

    /**
     * PLAN-0410 T2.1: Session-root scoped read (the pre-branch default; a
     * Session without a root row can only hold Session/global events).
     */
    @Transactional(readOnly = true)
    public ObjectNode projectUpTo(String sessionId, long upToSequence) {
        return projectUpTo(sessionId, upToSequence, branchPathService.rootVisibility(sessionId));
    }

    /**
     * PLAN-0410 T2.1: branch-path filtered projection up to
     * {@code upToSequence} (global + ancestor prefix + current branch events).
     */
    @Transactional(readOnly = true)
    public ObjectNode projectUpTo(String sessionId, long upToSequence,
                                  com.cc01cc.p.xihe.cp.service.BranchPathService.BranchVisibility visibility) {
        ObjectNode context = emptyContext(sessionId);
        List<ContextEvent> events = eventStoreService.read(sessionId, 0L, visibility);
        for (ContextEvent event : events) {
            if (event.getSequence() > upToSequence) {
                break;
            }
            context = apply(context, event);
        }
        return context;
    }

    @Transactional(readOnly = true)
    public ObjectNode project(String sessionId, Long afterSequence) {
        return project(sessionId, afterSequence, branchPathService.rootVisibility(sessionId));
    }

    /** PLAN-0410 T2.1: branch-path filtered projection of the visible events. */
    @Transactional(readOnly = true)
    public ObjectNode project(String sessionId, Long afterSequence,
                              com.cc01cc.p.xihe.cp.service.BranchPathService.BranchVisibility visibility) {
        ObjectNode context = emptyContext(sessionId);
        List<ContextEvent> events = eventStoreService.read(sessionId, afterSequence, visibility);
        for (ContextEvent event : events) {
            context = apply(context, event);
        }
        return context;
    }

    @Transactional
    public ObjectNode projectAndSave(String sessionId, String workspaceId, String userId, long afterSequence) {
        return projectAndSave(sessionId, workspaceId, userId, afterSequence, null);
    }

    /**
     * PLAN-0410 T2.1/T2.3: projection upsert keyed by
     * (session_id, projection_type, branch_id) — the cache key carries the
     * branchId. A null branchId bootstraps the Session root (legacy callers);
     * a supplied branchId must resolve inside this Session (fail-closed).
     * The projected payload carries {@code branch_id} so Agent-side consumers
     * know which branch CP resolved for them.
     */
    @Transactional
    public ObjectNode projectAndSave(String sessionId, String workspaceId, String userId, long afterSequence,
                                     String branchId) {
        String effectiveBranch = (branchId == null || branchId.isBlank())
                ? branchPathService.ensureRootBranchId(sessionId)
                : branchId;
        // PLAN-0410 T3.1: serialize the three-key upsert on the Session row
        // BEFORE reading the event set — concurrent first writes otherwise
        // both INSERT and the loser dies on uq_context_projections_*
        // (HTTP 500); serializing also keeps the stored payload monotonic.
        branchPathService.lockSessionRow(sessionId);
        com.cc01cc.p.xihe.cp.service.BranchPathService.BranchVisibility visibility =
                branchPathService.resolveVisibility(sessionId, effectiveBranch);
        ObjectNode context = project(sessionId, afterSequence, visibility);
        long latestSequence = context.get("latest_sequence").asLong();
        context.put("branch_id", effectiveBranch);

        // PLAN-0410 field-matrix §2 #6: explicit three-key lookup + insert.
        Optional<ContextProjection> existing =
                projectionRepository.findBySessionIdAndProjectionTypeAndBranchId(
                        sessionId, AGENT_CONTEXT_TYPE, effectiveBranch);
        ContextProjection projection = existing.orElseGet(() -> {
            ContextProjection created =
                    new ContextProjection(sessionId, workspaceId, userId, context.toString());
            created.setBranchId(effectiveBranch);
            return created;
        });
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
            // PLAN-294 M1: durable assistant reply (decision #2/#6) — same
            // projection shape as llm.token so snapshots carry the AI side of
            // the conversation for history assembly and compaction.
            case "assistant.responded" -> addMessage(context, payload, "ai");
            case "tool.result" -> addMessage(context, payload, "tool");
            // PLAN-0340: source updates replace the epoch L1 slot; they must not
            // append into messages (old path was truncated by HISTORY_LIMIT).
            case "context.source_changed" -> applySourceChanged(context, payload);
            case "context.env_updated" -> applyEnvUpdated(context, payload);
            case "epoch.started", "epoch.replaced" -> setEpoch(context, payload);
            case "runtime.state_cleared" -> clearRuntimeState(context);
            case "session.forked" -> recordFork(context, payload);
            case "compaction.applied" -> applyCompaction(context, payload);
            // PLAN-0341 T1.2: prune tombstones are durable anti-resurrection facts.
            case "context.prune" -> applyPrune(context, payload);
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
        emptyContextSlots(context);
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

    private void emptyContextSlots(ObjectNode context) {
        ObjectNode epoch = objectMapper.createObjectNode();
        epoch.put("epoch_id", "");
        epoch.put("source_hash", "");
        epoch.put("summary_hash", "");
        epoch.set("system_messages", objectMapper.createArrayNode());
        epoch.set("l1_sources", objectMapper.createArrayNode());
        epoch.put("l1_rendered", "");
        epoch.set("sources", objectMapper.createArrayNode());
        context.set("epoch", epoch);
    }

    private void setEpoch(ObjectNode context, ObjectNode payload) {
        ObjectNode epoch = objectMapper.createObjectNode();
        if (payload.has("epoch_id")) {
            epoch.put("epoch_id", payload.path("epoch_id").asText());
        }
        if (payload.has("baseline_hash")) {
            // Legacy field maps to source_hash for old epoch.started events.
            epoch.put("source_hash", payload.path("baseline_hash").asText());
            epoch.put("summary_hash", payload.path("baseline_hash").asText());
        }
        if (payload.has("source_hash")) {
            epoch.put("source_hash", payload.path("source_hash").asText());
        }
        if (payload.has("summary_hash")) {
            epoch.put("summary_hash", payload.path("summary_hash").asText());
        }
        ArrayNode systemMessages = objectMapper.createArrayNode();
        if (payload.has("system_messages") && payload.get("system_messages").isArray()) {
            payload.get("system_messages").forEach(node -> systemMessages.add(node.asText()));
        }
        epoch.set("system_messages", systemMessages);
        ArrayNode l1Sources = objectMapper.createArrayNode();
        if (payload.has("l1_sources") && payload.get("l1_sources").isArray()) {
            payload.get("l1_sources").forEach(l1Sources::add);
        }
        epoch.set("l1_sources", l1Sources);
        epoch.put("l1_rendered", payload.path("l1_rendered").asText(""));
        ArrayNode sources = objectMapper.createArrayNode();
        if (payload.has("snapshot") && payload.get("snapshot").has("sources")) {
            payload.get("snapshot").get("sources").forEach(sources::add);
        }
        epoch.set("sources", sources);
        context.set("epoch", epoch);
    }

    /** PLAN-0340 T1.5/T1.4: replace L1 slot only; preserve SUM (system_messages / summary_hash). */
    private void applySourceChanged(ObjectNode context, ObjectNode payload) {
        ObjectNode epoch = (ObjectNode) context.get("epoch");
        if (epoch == null) {
            epoch = objectMapper.createObjectNode();
            epoch.put("epoch_id", "");
            epoch.put("source_hash", "");
            epoch.put("summary_hash", "");
            epoch.set("system_messages", objectMapper.createArrayNode());
            epoch.set("l1_sources", objectMapper.createArrayNode());
            epoch.put("l1_rendered", "");
            epoch.set("sources", objectMapper.createArrayNode());
            context.set("epoch", epoch);
        }
        String status = payload.path("status").asText("updated");
        String hash = payload.path("source_hash").asText("");
        if ("failed".equals(status)) {
            epoch.put("source_hash", "");
            epoch.put("l1_rendered", "");
            ((ArrayNode) epoch.get("l1_sources")).removeAll();
            return;
        }
        epoch.put("source_hash", hash);
        epoch.put("l1_rendered", payload.path("rendered_text").asText(""));
        ArrayNode l1 = (ArrayNode) epoch.get("l1_sources");
        if (l1 == null) {
            l1 = objectMapper.createArrayNode();
            epoch.set("l1_sources", l1);
        }
        l1.removeAll();
        if (payload.has("l1_sources") && payload.get("l1_sources").isArray()) {
            payload.get("l1_sources").forEach(l1::add);
        } else if (payload.has("sources") && payload.get("sources").isArray()) {
            payload.get("sources").forEach(l1::add);
        }
        // Dual-write metadata for U1 without inventing a new projection root key.
        ObjectNode meta = (ObjectNode) context.get("metadata");
        ObjectNode sourcesMeta = objectMapper.createObjectNode();
        sourcesMeta.put("status", status);
        sourcesMeta.put("source_hash", hash);
        sourcesMeta.put("updated_at", Instant.now().toString());
        meta.set("context_sources", sourcesMeta);
    }

    private void applyEnvUpdated(ObjectNode context, ObjectNode payload) {
        ObjectNode epoch = (ObjectNode) context.get("epoch");
        if (epoch == null) {
            emptyContextSlots(context);
            epoch = (ObjectNode) context.get("epoch");
        }
        epoch.put("env_branch", payload.path("branch").asText(""));
        epoch.put("env_head", payload.path("head").asText(""));
        epoch.put("env_is_repository", payload.path("is_repository").asBoolean(false));
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

    private void recordFork(ObjectNode context, ObjectNode payload) {
        ObjectNode metadata = (ObjectNode) context.get("metadata");
        ObjectNode forkInfo = objectMapper.createObjectNode();
        if (payload.has("source_session_id")) {
            forkInfo.put("source_session_id", payload.path("source_session_id").asText());
        }
        if (payload.has("at_sequence")) {
            forkInfo.put("at_sequence", payload.path("at_sequence").asLong());
        }
        metadata.set("forked_from", forkInfo);
    }

    /**
     * PLAN-0341 T1.2 (I5 anti-resurrection): apply prune tombstones in-place.
     * Matching tool messages are replaced with the placeholder so replay or a
     * changed window constant cannot resurrect the original content.
     * Match key: sha256(content) — projected messages carry no tool_call_id.
     */
    private void applyPrune(ObjectNode context, ObjectNode payload) {
        if (!payload.has("tombstones") || !payload.get("tombstones").isArray()) {
            return;
        }
        ArrayNode messages = (ArrayNode) context.get("messages");
        if (messages == null || messages.isEmpty()) {
            return;
        }
        java.util.Set<String> prunedHashes = new java.util.HashSet<>();
        for (var tombstone : payload.get("tombstones")) {
            String hash = tombstone.path("content_hash").asText("");
            if (!hash.isBlank()) {
                prunedHashes.add(hash);
            }
        }
        if (prunedHashes.isEmpty()) {
            return;
        }
        int replaced = 0;
        for (int i = 0; i < messages.size(); i++) {
            var node = messages.get(i);
            if (!node.isObject()) {
                continue;
            }
            if (!"tool".equals(node.path("role").asText(""))) {
                continue;
            }
            String content = node.path("content").asText("");
            // Already a placeholder — leave it.
            if (content.isBlank() || content.startsWith("[old tool result")) {
                continue;
            }
            String hash = sha256Hex(content);
            if (prunedHashes.contains(hash)) {
                ((ObjectNode) node).put("content", "[old tool result cleared]");
                ((ObjectNode) node).put("pruned", true);
                replaced++;
            }
        }
        if (replaced > 0) {
            logger.info("Applied prune tombstones: replaced={} candidates={}", replaced, prunedHashes.size());
        }
    }

    private static String sha256Hex(String data) {
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(data.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * PLAN-0341 T1.4 (V4): compaction writes SUM only. The summary lives in
     * {@code epoch.system_messages} + {@code summary_hash}; {@code messages}
     * is truncated to the keep-recent tail and never receives the summary
     * (the old double-write put it at risk of the 20-item fuse, duplicate
     * injection, and order drift). L1 / sources are preserved (PLAN-0340).
     */
    private void applyCompaction(ObjectNode context, ObjectNode payload) {
        if (payload.has("summary")) {
            ArrayNode messages = (ArrayNode) context.get("messages");
            if (messages != null) {
                int size = messages.size();
                int keepFrom = Math.max(0, size - ContextService.KEEP_RECENT_MESSAGES);
                ArrayNode kept = objectMapper.createArrayNode();
                for (int i = keepFrom; i < size; i++) {
                    kept.add(messages.get(i));
                }
                context.set("messages", kept);
            }
        }
        // PLAN-0340: compaction writes SUM only; must not wipe L1 (source_hash / l1_*).
        ObjectNode epoch = (ObjectNode) context.get("epoch");
        if (epoch == null) {
            epoch = objectMapper.createObjectNode();
            epoch.put("epoch_id", "");
            epoch.put("source_hash", "");
            epoch.put("summary_hash", "");
            epoch.set("system_messages", objectMapper.createArrayNode());
            epoch.set("l1_sources", objectMapper.createArrayNode());
            epoch.put("l1_rendered", "");
            epoch.set("sources", objectMapper.createArrayNode());
            context.set("epoch", epoch);
        }
        String epochId = payload.path("contextEpoch").asText("");
        if (!epochId.isBlank()) {
            epoch.put("epoch_id", epochId);
        }
        epoch.put("summary_hash", payload.path("summaryHash").asText(""));
        ArrayNode systemMessages = (ArrayNode) epoch.get("system_messages");
        if (systemMessages == null) {
            systemMessages = objectMapper.createArrayNode();
            epoch.set("system_messages", systemMessages);
        }
        systemMessages.removeAll();
        systemMessages.add("Conversation summary of compacted history:");
        systemMessages.add(payload.path("summary").asText(""));
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
