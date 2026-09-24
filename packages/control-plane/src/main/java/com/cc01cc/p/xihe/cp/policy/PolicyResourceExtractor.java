package com.cc01cc.p.xihe.cp.policy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashSet;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Extracts candidate resources from an MCP tool-call body ({@code params.arguments}) so that
 * resource-scoped rules and the hard guard can see what a call actually touches (PLAN-0328
 * spec §8.1 binding scope).
 *
 * <p>Best effort and conservative: keys outside the known set (and nested objects) are ignored, and
 * when nothing is recognized the wildcard {@code "*"} is returned so evaluation keeps its previous
 * behavior. Argument contents are never logged.</p>
 */
public final class PolicyResourceExtractor {

    private static final Logger log = LoggerFactory.getLogger(PolicyResourceExtractor.class);

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final List<String> SCALAR_KEYS = List.of(
            "path", "file_path", "filePath", "filepath", "source", "destination", "target",
            "cwd", "command", "cmd", "script", "url", "uri");
    private static final List<String> ARRAY_KEYS = List.of("paths", "files", "targets", "urls");

    private static final int MAX_ITEMS = 20;
    private static final int MAX_LENGTH = 2048;
    private static final String INVALID_RESOURCE = "!invalid-resource-scope!";

    private static final List<String> FALLBACK = List.of("*");

    private PolicyResourceExtractor() {
    }

    public static List<String> extract(String mcpBody) {
        JsonNode arguments = argumentsOf(mcpBody);
        if (arguments == null || !arguments.isObject()) {
            return FALLBACK;
        }
        LinkedHashSet<String> resources = new LinkedHashSet<>();
        for (String key : SCALAR_KEYS) {
            add(resources, arguments.get(key));
        }
        for (String key : ARRAY_KEYS) {
            JsonNode node = arguments.get(key);
            if (node != null && node.isArray()) {
                node.forEach(item -> add(resources, item));
            }
        }
        JsonNode patches = arguments.get("patches");
        if (patches != null && patches.isArray()) {
            patches.forEach(patch -> add(resources, patch.get("path")));
        }
        return resources.isEmpty() ? FALLBACK : List.copyOf(resources);
    }

    public static boolean hasInvalidResource(List<String> resources) {
        return resources != null && resources.contains(INVALID_RESOURCE);
    }

    private static JsonNode argumentsOf(String mcpBody) {
        if (mcpBody == null || mcpBody.isBlank()) {
            return null;
        }
        try {
            return MAPPER.readTree(mcpBody).path("params").path("arguments");
        } catch (Exception e) {
            // Parse failures fall back to the conservative default; the exception may embed
            // argument content, so the body is never logged
            log.debug("[POLICY] resource extraction skipped: MCP body is not valid JSON");
            return null;
        }
    }

    private static void add(LinkedHashSet<String> resources, JsonNode node) {
        if (node == null || !node.isTextual() || resources.contains(INVALID_RESOURCE)) {
            return;
        }
        String value = node.asText().trim();
        if (value.isEmpty()) {
            return;
        }
        if (resources.size() >= MAX_ITEMS || value.length() > MAX_LENGTH) {
            resources.add(INVALID_RESOURCE);
            return;
        }
        resources.add(value);
    }
}
