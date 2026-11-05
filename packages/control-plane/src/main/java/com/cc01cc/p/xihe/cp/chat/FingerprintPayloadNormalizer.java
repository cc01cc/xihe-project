package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * PLAN-0666 / BL-285 follow-up (2026-11-05): the fingerprint may only hash <b>context state</b>, never
 * values that merely prove "this dispatch happened later". Two real-stack defects motivated this
 * class:
 *
 * <ol>
 *   <li><b>Volatile fields</b> — {@code skills_snapshot.capturedAt} (and any future timestamp) changes
 *       on every run, so the {@code skills} layer read as "changed" forever. A fingerprint that always
 *       changes is not a fingerprint.</li>
 *   <li><b>Layer aggregation</b> — the {@code memory} layer used to hash <i>all</i>
 *       {@code componentSources}, so a skills change polluted the memory layer and "only layer X
 *       changed" could never hold. The memory layer keeps the memory + tree components
 *       ({@code agent_memory}, {@code workspace_tree}, {@code agents_md_tree}); skill sources belong to
 *       the dedicated {@code skills} layer.</li>
 * </ol>
 *
 * <p>Only the payload that enters the fingerprint is normalized — the stored snapshots
 * ({@code context_template_snapshot}, {@code skills_snapshot}) keep their original bytes; diagnostics
 * ({@code status/version/truncated/diagnostics/snapshotSource}) are preserved.</p>
 */
final class FingerprintPayloadNormalizer {

    /**
     * Keys that are stripped wherever they appear in a hashed payload. Audit table (PLAN-0671
     * evidence) is the source of truth for why each one is here — the shared property is "changes
     * without the context changing".
     */
    static final List<String> VOLATILE_KEYS = List.of(
            "capturedAt",
            "createdAt",
            "updatedAt",
            "generatedAt",
            "timestamp",
            "startedAt",
            "finishedAt",
            "expiresAt",
            "lastUsedAt",
            "signedUrl",
            "runId",
            "requestId",
            "credentialLease");

    /** Component types whose source documents stay in the {@code memory} layer. */
    static final List<String> MEMORY_LAYER_COMPONENT_TYPES = List.of(
            "agent_memory", "workspace_tree", "agents_md_tree");

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private FingerprintPayloadNormalizer() {}

    /** Recursively strips {@link #VOLATILE_KEYS}; everything else keeps its value and order. */
    static Object normalize(Object payload) {
        if (payload == null) {
            return null;
        }
        if (payload instanceof JsonNode node) {
            return normalizeNode(node);
        }
        if (payload instanceof Map<?, ?> map) {
            Map<String, Object> normalized = new LinkedHashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                String key = String.valueOf(entry.getKey());
                if (VOLATILE_KEYS.contains(key)) {
                    continue;
                }
                normalized.put(key, normalize(entry.getValue()));
            }
            return normalized;
        }
        if (payload instanceof List<?> list) {
            List<Object> normalized = new ArrayList<>(list.size());
            for (Object item : list) {
                normalized.add(normalize(item));
            }
            return normalized;
        }
        return payload;
    }

    private static JsonNode normalizeNode(JsonNode node) {
        if (node == null || node.isNull()) {
            return node;
        }
        if (node.isObject()) {
            ObjectNode copy = MAPPER.createObjectNode();
            node.fields().forEachRemaining(entry -> {
                if (!VOLATILE_KEYS.contains(entry.getKey())) {
                    copy.set(entry.getKey(), (JsonNode) normalizeNode(entry.getValue()));
                }
            });
            return copy;
        }
        if (node.isArray()) {
            ArrayNode copy = MAPPER.createArrayNode();
            node.forEach(item -> copy.add((JsonNode) normalizeNode(item)));
            return copy;
        }
        return node;
    }

    /**
     * The {@code memory} layer payload: only the component sources whose declared type belongs to
     * {@link #MEMORY_LAYER_COMPONENT_TYPES}, in the template's component order (stable across runs).
     * Skill sources are intentionally excluded — the {@code skills} layer already hashes them.
     */
    static Map<String, Object> memorySources(Map<String, Object> componentSources,
                                             JsonNode templateSnapshot) {
        if (componentSources == null || componentSources.isEmpty()) {
            return Map.of();
        }
        JsonNode components = templateSnapshot == null ? null
                : templateSnapshot.path("template").path("components");
        Map<String, Object> selected = new LinkedHashMap<>();
        if (components == null || !components.isArray()) {
            // No manifest to classify by: fall back to the whole map (never silently drop a layer).
            componentSources.forEach((key, value) -> selected.put(key, normalize(value)));
            return selected;
        }
        for (JsonNode component : components) {
            String type = component.path("type").asText("");
            if (!MEMORY_LAYER_COMPONENT_TYPES.contains(type)) {
                continue;
            }
            String instanceId = component.path("instanceId").asText("");
            if (instanceId.isBlank() || !componentSources.containsKey(instanceId)) {
                continue;
            }
            selected.put(instanceId, normalize(componentSources.get(instanceId)));
        }
        return selected;
    }
}
