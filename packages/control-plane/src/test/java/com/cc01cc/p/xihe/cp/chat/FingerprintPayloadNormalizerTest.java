package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * BL-285 follow-up (2026-11-05): the audit table's executable half. A layer payload may only contain
 * context <b>state</b>; anything that changes merely because a later dispatch happened must be
 * normalized away, and the {@code memory} layer must not absorb component sources that already have
 * their own layer (skills).
 */
class FingerprintPayloadNormalizerTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void stripsTimestampsAndPerDispatchFieldsRecursively() {
        ObjectNode payload = mapper.createObjectNode();
        payload.put("status", "ready");
        payload.put("capturedAt", "2026-11-05T01:00:00Z");
        payload.put("runId", "run-1");
        ObjectNode nested = payload.putObject("nested");
        nested.put("updatedAt", "2026-11-05T02:00:00Z");
        nested.put("content", "remembered fact");
        ArrayNode items = payload.putArray("items");
        items.addObject().put("name", "alpha").put("createdAt", "2026-11-05T03:00:00Z");

        Object normalized = FingerprintPayloadNormalizer.normalize(payload);
        String serialized = normalized.toString();

        assertFalse(serialized.contains("capturedAt"));
        assertFalse(serialized.contains("updatedAt"));
        assertFalse(serialized.contains("createdAt"));
        assertFalse(serialized.contains("runId"));
        // Diagnostics/state survive untouched.
        assertTrue(serialized.contains("status"));
        assertTrue(serialized.contains("remembered fact"));
        assertTrue(serialized.contains("alpha"));
    }

    @Test
    void normalizationIsStableForEqualStateWithDifferentTimestamps() {
        String first = FingerprintPayloadNormalizer.normalize(
                mapper.createObjectNode().put("capturedAt", "2026-11-05T01:00:00Z").put("status", "ready"))
                .toString();
        String second = FingerprintPayloadNormalizer.normalize(
                mapper.createObjectNode().put("capturedAt", "2026-11-05T09:00:00Z").put("status", "ready"))
                .toString();
        assertEquals(first, second);
    }

    @Test
    void memoryLayerKeepsMemoryAndTreeSources_onlyNotSkills() {
        Map<String, Object> componentSources = new LinkedHashMap<>();
        componentSources.put("memory-1", Map.of("status", "ready", "entries", List.of("fact")));
        componentSources.put("skills-1", Map.of("status", "ready", "items", List.of("alpha")));
        componentSources.put("tree-1", Map.of("status", "ready", "entries", List.of("a.txt")));
        ObjectNode template = mapper.createObjectNode();
        ArrayNode components = template.putObject("template").putArray("components");
        components.addObject().put("instanceId", "prompt-1").put("type", "system_prompt");
        components.addObject().put("instanceId", "memory-1").put("type", "agent_memory");
        components.addObject().put("instanceId", "skills-1").put("type", "skill_catalog");
        components.addObject().put("instanceId", "tree-1").put("type", "workspace_tree");

        Map<String, Object> memory = FingerprintPayloadNormalizer.memorySources(componentSources, template);

        assertEquals(List.of("memory-1", "tree-1"), List.copyOf(memory.keySet()),
                "skills have their own layer and must not be counted as memory");
    }

    @Test
    void memoryLayerFallsBackToWholeMapWhenNoManifestIsAvailable() {
        Map<String, Object> componentSources = new LinkedHashMap<>();
        componentSources.put("anything", Map.of("status", "ready"));
        Map<String, Object> memory = FingerprintPayloadNormalizer.memorySources(componentSources, null);
        assertEquals(componentSources.keySet(), memory.keySet(),
                "a missing manifest must never silently blank the layer");
    }
}
