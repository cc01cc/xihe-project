package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.cc01cc.p.xihe.cp.context.entity.ContextProjection;
import com.cc01cc.p.xihe.cp.context.repository.ContextProjectionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
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
            // PLAN-0381 T1.3 (contract §6): assistant tool-call declarations
            // join history so tool results pair by call id, never by adjacency.
            case "tool.called" -> addToolCalled(context, payload);
            // PLAN-0381 T1.3 (contract §3): shape-based result read — B1 fix,
            // object/array results must never collapse to an empty string.
            case "tool.result" -> addToolResult(context, payload);
            // PLAN-0340: source updates replace the epoch L1 slot; they must not
            // append into messages (old path was truncated by HISTORY_LIMIT).
            case "context.source_changed" -> applySourceChanged(context, payload);
            case "context.env_updated" -> applyEnvUpdated(context, payload);
            case "epoch.started", "epoch.replaced" -> setEpoch(context, payload);
            case "runtime.state_cleared" -> clearRuntimeState(context);
            case "session.forked" -> recordFork(context, payload);
            case "compaction.applied", "compaction.manual_applied" -> applyCompaction(context, payload);
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

    // ------------------------------------------------------------------
    // PLAN-0381 M1 — cross-language contract (Agent evidence/m1-contract.md).
    // Python mirrors: interfaces/context.py (bound_tool_arguments,
    // parse_tool_result, apply_event) and langgraph_runner mapping rules.
    // ------------------------------------------------------------------

    /** ARG/preview bounds (contract §4): Python slices by code point; Java
     * slices UTF-16 units with a surrogate-pair guard so a surrogate pair is
     * never split. */
    private static final int ARG_LIMIT = 4096;
    private static final int ARG_PREFIX_CHARS = 4000;
    private static final int JSON_PREVIEW_LIMIT = 4096;
    private static final String JSON_TRUNCATED_SUFFIX = "...[truncated]";

    /** Contract §3 dual-read: v2 camelCase payload keys fall back to legacy. */
    private static String pairingField(ObjectNode payload, String v2Key, String legacyKey) {
        JsonNode value = payload.get(v2Key);
        if (value == null || value.isNull() || value.asText("").isBlank()) {
            value = payload.get(legacyKey);
        }
        return value == null || value.isNull() ? "" : value.asText("");
    }

    private static String utf16SafeCut(String value, int limit) {
        if (value.length() <= limit) {
            return value;
        }
        int cut = limit;
        if (cut > 0 && Character.isHighSurrogate(value.charAt(cut - 1))) {
            cut--;
        }
        return value.substring(0, cut);
    }

    /** Marker objects must themselves serialize ≤ ARG_LIMIT: the prefix is a
     * JSON string value, so escaping inflates it (\\ ×2, controls up to ×6)
     * past the frozen limit (review P1-1 — Python {@code _fit_marker_payload}
     * mirrors this). Shrink iteratively by the observed ratio. */
    private static ObjectNode shrinkMarker(ObjectNode marker, String textKey) {
        for (int i = 0; i < 8 && marker.toString().length() > ARG_LIMIT; i++) {
            String text = marker.get(textKey).asText("");
            if (text.isEmpty()) {
                break;
            }
            int dumped = marker.toString().length();
            int keep = Math.max(16, (int) ((long) text.length() * ARG_LIMIT / dumped));
            if (keep >= text.length()) {
                keep = text.length() - 1;
            }
            // 收缩切点同样不得劈开代理对（contract §4，与 utf16SafeCut 同规则）。
            if (keep > 0 && Character.isHighSurrogate(text.charAt(keep - 1))) {
                keep--;
            }
            if (keep < 1) {
                break;
            }
            marker.put(textKey, text.substring(0, keep));
        }
        return marker;
    }

    /** Contract §4: complete raw arguments bounded by the frozen 4096 limit —
     * truncation replaces the object with an explicit marker, never an
     * in-place value rewrite. */
    private JsonNode boundArguments(JsonNode raw) {
        if (raw == null || raw.isNull()) {
            return objectMapper.createObjectNode();
        }
        JsonNode object = raw;
        if (!raw.isObject()) {
            ObjectNode wrapped = objectMapper.createObjectNode();
            wrapped.put("_raw", raw.isTextual() ? raw.asText() : raw.toString());
            object = wrapped;
        }
        String serialized = object.toString();
        if (serialized.length() <= ARG_LIMIT) {
            return object;
        }
        if (!raw.isObject()) {
            ObjectNode out = objectMapper.createObjectNode();
            out.put("_raw", utf16SafeCut(raw.isTextual() ? raw.asText() : raw.toString(), ARG_PREFIX_CHARS));
            out.put("__xihe_truncated__", true);
            return shrinkMarker(out, "_raw");
        }
        ObjectNode marker = objectMapper.createObjectNode();
        marker.put("__xihe_truncated__", true);
        marker.put("__chars__", serialized.length());
        marker.put("__prefix__", utf16SafeCut(serialized, ARG_PREFIX_CHARS));
        return shrinkMarker(marker, "__prefix__");
    }

    private ObjectNode toolCallEntry(String callId, String toolName, JsonNode arguments) {
        ObjectNode entry = objectMapper.createObjectNode();
        entry.put("call_id", callId);
        entry.put("tool_name", toolName);
        entry.set("arguments", arguments);
        return entry;
    }

    private static boolean isToolResult(JsonNode message) {
        return message != null && message.isObject()
                && "tool".equals(message.path("role").asText(""));
    }

    /**
     * PLAN-0381 T3.5 / m3-contract §3 idempotency: the projection is rebuilt
     * from the event log on every read (no cross-request state), so the
     * duplicate checks are linear scans over the current messages — the
     * accepted O(events×messages) cost of the contract.
     */
    private static boolean hasDeclarationFor(ArrayNode messages, String callId) {
        for (JsonNode message : messages) {
            if (!"ai".equals(message.path("role").asText(""))) {
                continue;
            }
            JsonNode toolCalls = message.get("tool_calls");
            if (toolCalls == null || !toolCalls.isArray()) {
                continue;
            }
            for (JsonNode toolCall : toolCalls) {
                if (callId.equals(toolCall.path("call_id").asText(""))) {
                    return true;
                }
            }
        }
        return false;
    }

    /** m3-contract §3: first-wins — a replayed {@code tool.result} repeats one fact. */
    private static boolean hasResultFor(ArrayNode messages, String callId) {
        for (JsonNode message : messages) {
            if (isToolResult(message) && callId.equals(message.path("tool_call_id").asText(""))) {
                return true;
            }
        }
        return false;
    }

    /**
     * PLAN-0381 T1.3 / contract §6: assistant tool-call declarations join the
     * projected history; consecutive declarations merge into ONE ai message.
     * A payload without a resolvable call id must not fabricate a pair — it
     * degrades to an explicit ai text fact (the snapshot never emits
     * {@code system}: buildForkSeed only accepts human/ai/tool roles).
     */
    private void addToolCalled(ObjectNode context, ObjectNode payload) {
        String callId = pairingField(payload, "toolCallId", "call_id");
        String toolName = pairingField(payload, "toolName", "tool_name");
        JsonNode rawArguments = payload.hasNonNull("arguments") ? payload.get("arguments") : payload.get("tool_input");
        JsonNode arguments = boundArguments(rawArguments);
        ArrayNode messages = (ArrayNode) context.get("messages");
        if (callId.isBlank()) {
            String name = toolName.isBlank() ? "unknown" : toolName;
            ObjectNode fact = objectMapper.createObjectNode();
            fact.put("role", "ai");
            fact.put("content", "[unpaired tool call: " + name + "] " + arguments.toString());
            fact.put("degraded", true);
            messages.add(fact);
            return;
        }
        // m3-contract §3: a declaration already present for this call id wins —
        // no second ref, no second message (degraded payloads carry no id and
        // are never deduplicated).
        if (hasDeclarationFor(messages, callId)) {
            logger.info("[LIFECYCLE] service=cp event=duplicate_declaration_ignored toolCallId={}", callId);
            return;
        }
        if (!messages.isEmpty()) {
            JsonNode last = messages.get(messages.size() - 1);
            if (last.isObject() && "ai".equals(last.path("role").asText())) {
                JsonNode existing = last.get("tool_calls");
                if (existing != null && existing.isArray() && !existing.isEmpty()) {
                    ((ArrayNode) existing).add(toolCallEntry(callId, toolName, arguments));
                    return;
                }
            }
        }
        ObjectNode message = objectMapper.createObjectNode();
        message.put("role", "ai");
        message.put("content", "");
        ArrayNode calls = objectMapper.createArrayNode();
        calls.add(toolCallEntry(callId, toolName, arguments));
        message.set("tool_calls", calls);
        messages.add(message);
    }

    /** Whitelist passthrough for object results (contract §3): only bounded
     * preview metadata fields move onto the projected message. */
    private void putResultWhitelist(ObjectNode message, ObjectNode result) {
        if (result.path("truncated").asBoolean(false)) {
            message.put("truncated", true);
        }
        JsonNode artifactRef = result.hasNonNull("artifactRef") ? result.get("artifactRef") : result.get("artifact_ref");
        if (artifactRef != null && !artifactRef.asText("").isBlank()) {
            message.put("artifact_ref", artifactRef.asText(""));
        }
        JsonNode sizeBytes = result.get("sizeBytes");
        if (sizeBytes != null && sizeBytes.isIntegralNumber()) {
            message.put("size_bytes", sizeBytes.asLong());
        }
        JsonNode errorCode = result.hasNonNull("errorCode") ? result.get("errorCode") : result.get("error_code");
        if (errorCode != null && !errorCode.asText("").isBlank()) {
            message.put("error_code", errorCode.asText(""));
        }
    }

    /** Contract §3 rule 5: content-less objects/arrays normalize to a bounded
     * JSON preview; the cut is explicit (truncated + legacy_normalized). */
    private void putBoundedJsonPreview(ObjectNode message, JsonNode value) {
        String serialized = value.toString();
        if (serialized.length() <= JSON_PREVIEW_LIMIT) {
            message.put("content", serialized);
            return;
        }
        message.put("content", utf16SafeCut(serialized, JSON_PREVIEW_LIMIT - JSON_TRUNCATED_SUFFIX.length()) + JSON_TRUNCATED_SUFFIX);
        message.put("truncated", true);
    }

    /**
     * PLAN-0381 T1.3 / contract §3 result-shape table (B1 fix): string,
     * object-with-content, object-with-preview (M2 reader-first), else bounded
     * JSON + legacy marker. An empty string is a legitimate result and is
     * still projected (V12) — it is never dropped.
     */
    private void putResultContent(ObjectNode message, JsonNode result) {
        String content = "";
        boolean legacyNormalized = false;
        if (result != null && !result.isNull()) {
            if (result.isTextual()) {
                content = result.asText();
            } else if (result.isObject()) {
                ObjectNode object = (ObjectNode) result;
                JsonNode inner = object.get("content");
                if (inner != null && inner.isTextual()) {
                    content = inner.asText();
                    putResultWhitelist(message, object);
                } else {
                    JsonNode preview = object.get("preview");
                    if (preview != null && preview.isTextual()) {
                        content = preview.asText();
                        putResultWhitelist(message, object);
                    } else {
                        putBoundedJsonPreview(message, object);
                        legacyNormalized = true;
                    }
                }
            } else {
                putBoundedJsonPreview(message, result);
                legacyNormalized = true;
            }
        }
        if (legacyNormalized) {
            message.put("legacy_normalized", true);
        } else {
            // putBoundedJsonPreview already wrote content on the legacy path.
            message.put("content", content);
        }
    }

    private void addToolResult(ObjectNode context, ObjectNode payload) {
        String callId = pairingField(payload, "toolCallId", "call_id");
        String toolName = pairingField(payload, "toolName", "tool_name");
        ArrayNode messages = (ArrayNode) context.get("messages");
        // m3-contract §3: first-wins on the call id — a replayed event is the
        // same fact, so the first result stays authoritative. A blank/absent
        // id keeps the legacy degraded path (no dedup key to compare).
        if (!callId.isBlank() && hasResultFor(messages, callId)) {
            logger.info("[LIFECYCLE] service=cp event=duplicate_result_ignored toolCallId={}", callId);
            return;
        }
        ObjectNode message = objectMapper.createObjectNode();
        message.put("role", "tool");
        putResultContent(message, payload.get("result"));
        if (callId.isBlank()) {
            message.put("degraded", true);
        } else {
            message.put("tool_call_id", callId);
        }
        if (!toolName.isBlank()) {
            message.put("tool_name", toolName);
        }
        String status = payload.path("status").asText("");
        message.put("status", status.isBlank() ? "completed" : status);
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
        // PLAN-0382: restore state/fact keys when an epoch payload carries them
        // (additive; absent keys keep the spec §5 legacy inference).
        for (String field : java.util.List.of(
                "l1_status", "env_status", "env_cwd", "env_platform", "env_shell", "env_observed_at")) {
            if (payload.has(field)) {
                epoch.set(field, payload.get(field));
            }
        }
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
        // PLAN-0382 (spec §3/§5): canonical l1_status — prefer the new key, else
        // derive from the legacy emission vocabulary so replaying old events
        // yields the frozen enum without rewriting history.
        String l1Status = resolveL1Status(payload, status);
        boolean clearSlot = L1_CLEAR_STATUSES.contains(l1Status);
        if (clearSlot) {
            epoch.put("source_hash", "");
            epoch.put("l1_rendered", "");
            ((ArrayNode) epoch.get("l1_sources")).removeAll();
            // PLAN-0382/BL-48: a cleared slot must also drop the legacy
            // `sources` array — otherwise replay can fall back to it unmarked.
            ((ArrayNode) epoch.get("sources")).removeAll();
        } else {
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
        }
        if (l1Status != null) {
            epoch.put("l1_status", l1Status);
        }
        // Dual-write metadata for U1 without inventing a new projection root key.
        ObjectNode meta = (ObjectNode) context.get("metadata");
        ObjectNode sourcesMeta = objectMapper.createObjectNode();
        sourcesMeta.put("status", status);
        sourcesMeta.put("source_hash", hash);
        sourcesMeta.put("updated_at", Instant.now().toString());
        meta.set("context_sources", sourcesMeta);
    }

    /** PLAN-0382 spec §3/§5: new key wins; legacy events map created/updated→ok, failed→failed. */
    private static String resolveL1Status(ObjectNode payload, String legacyStatus) {
        if (payload.hasNonNull("l1_status")) {
            String value = payload.get("l1_status").asText();
            if (!value.isBlank()) {
                return value;
            }
        }
        return switch (legacyStatus) {
            case "created", "updated" -> "ok";
            case "failed", "missing", "unavailable", "unknown" -> legacyStatus;
            default -> null; // unchanged/absent: leave the key unwritten (legacy inference).
        };
    }

    /** Statuses that clear the L1 slot (fail-closed family, spec §3). */
    private static final java.util.Set<String> L1_CLEAR_STATUSES =
            java.util.Set.of("failed", "missing", "unavailable");

    private void applyEnvUpdated(ObjectNode context, ObjectNode payload) {
        ObjectNode epoch = (ObjectNode) context.get("epoch");
        if (epoch == null) {
            emptyContextSlots(context);
            epoch = (ObjectNode) context.get("epoch");
        }
        epoch.put("env_branch", payload.path("branch").asText(""));
        epoch.put("env_head", payload.path("head").asText(""));
        epoch.put("env_is_repository", payload.path("is_repository").asBoolean(false));
        // PLAN-0382 (additive): status/observation + Runtime-reported env facts.
        // Old events lack these keys → keys stay unwritten → readers apply the
        // spec §5 legacy table (no env_status → unknown).
        copyEnvFact(payload, epoch, "env_status");
        copyEnvFact(payload, epoch, "env_cwd");
        copyEnvFact(payload, epoch, "env_platform");
        copyEnvFact(payload, epoch, "env_shell");
        copyEnvFact(payload, epoch, "env_observed_at");
    }

    private static void copyEnvFact(ObjectNode payload, ObjectNode epoch, String field) {
        if (payload.has(field)) {
            epoch.set(field, payload.get(field));
        }
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
        if (payload.has("anchor_message_id")) {
            forkInfo.put("anchor_message_id", payload.path("anchor_message_id").asText());
        }
        metadata.set("forked_from", forkInfo);

        JsonNode seed = payload.get("summary_seed");
        if (seed == null) {
            return;
        }
        if (!seed.isObject()
                || !seed.path("messages").isArray()
                || seed.path("contextEpoch").asText().isBlank()
                || payload.path("source_session_id").asText().isBlank()
                || payload.path("anchor_message_id").asText().isBlank()) {
            throw invalidForkSeed(context, "missing required child seed fields");
        }

        ArrayNode messages = objectMapper.createArrayNode();
        for (JsonNode sourceMessage : seed.path("messages")) {
            String role = sourceMessage.path("role").asText();
            if (!sourceMessage.isObject()
                    || !List.of("human", "ai", "tool").contains(role)
                    || !sourceMessage.path("content").isTextual()) {
                throw invalidForkSeed(context, "invalid projected message");
            }
            // PLAN-0381 T3.1 / m3-contract §2.2: whole-object copy — the
            // projection's pairing fields (tool_calls / tool_call_id /
            // tool_name / status / truncated / artifact_ref / size_bytes /
            // error_code / degraded / legacy_normalized / pruned) must reach
            // the child unchanged. No field whitelist; the role/content checks
            // above stay fail-closed.
            ObjectNode message = objectMapper.createObjectNode();
            var fieldNames = sourceMessage.fieldNames();
            while (fieldNames.hasNext()) {
                String field = fieldNames.next();
                message.set(field, sourceMessage.get(field));
            }
            messages.add(message);
        }
        context.set("messages", messages);
        clearRuntimeState(context);

        ObjectNode epoch = (ObjectNode) context.get("epoch");
        if (epoch == null) {
            emptyContextSlots(context);
            epoch = (ObjectNode) context.get("epoch");
        }
        epoch.put("epoch_id", seed.path("contextEpoch").asText());
        String summary = seed.path("summary").asText("");
        String summaryHash = seed.path("summaryHash").asText("");
        if (summary.isBlank() != summaryHash.isBlank()) {
            throw invalidForkSeed(context, "summary and summaryHash must be present together");
        }
        if (!summary.isBlank()) {
            epoch.put("summary_hash", summaryHash);
            ArrayNode systemMessages = objectMapper.createArrayNode();
            systemMessages.add("Conversation summary of compacted history:");
            systemMessages.add(summary);
            epoch.set("system_messages", systemMessages);
        } else {
            epoch.put("summary_hash", "");
        }
    }

    private IllegalArgumentException invalidForkSeed(ObjectNode context, String detail) {
        logger.error("Invalid session.forked summary seed: sessionId={} reason={}",
                context.path("aggregate_id").asText(), detail);
        return new IllegalArgumentException("Invalid session.forked summary seed: " + detail);
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
                // PLAN-0381 T3.1 / m3-contract §2.1 pair-preserving fuse (same
                // rule as Agent _align_truncation_start): the keep-recent window
                // must never begin on a tool result whose declaration was cut —
                // walk the cut point back over leading tool results so the
                // declaration and its results stay in the window together.
                // Walk-back may push kept past KEEP_RECENT_MESSAGES by the
                // walked-back declaration side (registered in contract §6).
                while (keepFrom > 0 && isToolResult(messages.get(keepFrom))) {
                    keepFrom--;
                }
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
