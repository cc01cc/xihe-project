package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.runtime.RuntimeContextSourceClient;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Resolves bounded, path-only tree components from the admission-frozen template snapshot. */
@Service
public class ContextTemplateSourceService {
    private static final int HARD_REQUEST_LIMIT = 512;
    private static final int DEFAULT_MAX_DEPTH = 8;
    private static final int DEFAULT_MAX_ENTRIES = 2000;
    private static final List<String> DEFAULT_AGENTS_FILES = List.of("AGENTS.md");

    private final RuntimeContextSourceClient runtimeClient;
    private final PolicyEngine policyEngine;
    private final ObjectMapper objectMapper;

    public ContextTemplateSourceService(RuntimeContextSourceClient runtimeClient,
                                        PolicyEngine policyEngine,
                                        ObjectMapper objectMapper) {
        this.runtimeClient = runtimeClient;
        this.policyEngine = policyEngine;
        this.objectMapper = objectMapper;
    }

    public Map<String, Object> resolve(ChatRun run, Session session) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (run == null) {
            return Map.of();
        }
        boolean validBinding = session != null && session.getId() != null
                && run.getSessionId().equals(session.getId().toString())
                && run.getWorkspaceId().equals(session.getWorkspaceId())
                && run.getUserId().equals(session.getUserId());
        JsonNode components = run.getContextTemplateSnapshot() == null ? null
                : run.getContextTemplateSnapshot().path("template").path("components");
        if (components == null || !components.isArray()) {
            return result;
        }
        int[] remainingRequests = {HARD_REQUEST_LIMIT};
        for (JsonNode component : components) {
            String type = component.path("type").asText();
            if (!component.path("enabled").asBoolean(false)
                    || !("workspace_tree".equals(type) || "agents_md_tree".equals(type))) {
                continue;
            }
            String instanceId = component.path("instanceId").asText();
            if (instanceId.isBlank()) {
                continue;
            }
            result.put(instanceId, resolveTree(
                    component.path("config"), type, run, session, validBinding, remainingRequests));
        }
        return result;
    }

    private Map<String, Object> resolveTree(JsonNode config, String type, ChatRun run, Session session,
                                            boolean validBinding, int[] remainingRequests) {
        List<String> items = new ArrayList<>();
        List<String> diagnostics = new ArrayList<>();
        boolean truncated = false;
        String status = "ready";
        if (!validBinding) {
            return treeView("failed", items, false, List.of("invalid_session_workspace_binding"));
        }
        if (!"session_workspace".equals(config.path("root").asText())) {
            return treeView("failed", items, false, List.of("unsupported_tree_root"));
        }
        int maxDepth = bounded(config.path("maxDepth").asInt(DEFAULT_MAX_DEPTH), 32, DEFAULT_MAX_DEPTH);
        int maxEntries = bounded(config.path("maxEntries").asInt(DEFAULT_MAX_ENTRIES), 100_000, DEFAULT_MAX_ENTRIES);
        boolean agentsOnly = "agents_md_tree".equals(type);
        boolean includeFiles = agentsOnly || config.path("includeFiles").asBoolean(true);
        Set<String> fileNames = new LinkedHashSet<>();
        JsonNode names = config.path("fileNames");
        if (agentsOnly && names.isArray()) {
            names.forEach(n -> { if (n.isTextual() && !n.asText().isBlank()) fileNames.add(fold(n.asText())); });
        }
        if (agentsOnly && fileNames.isEmpty()) fileNames.addAll(DEFAULT_AGENTS_FILES.stream().map(ContextTemplateSourceService::fold).toList());
        List<Pattern> excludes = new ArrayList<>();
        JsonNode patterns = config.path("excludePatterns");
        if (patterns.isArray()) {
            patterns.forEach(n -> { if (n.isTextual()) excludes.add(glob(n.asText())); });
        }
        ArrayDeque<Directory> queue = new ArrayDeque<>();
        queue.add(new Directory(".", 0));
        int scannedEntries = 0;
        PolicyContext policy = policyEngine.loadContext(run.getUserId(), run.getWorkspaceId(), run.getSessionId());
        while (!queue.isEmpty()) {
            if (remainingRequests[0] <= 0) {
                truncated = true;
                diagnostics.add("template_tree_request_limit_reached");
                break;
            }
            Directory directory = queue.removeFirst();
            String policyBody;
            try {
                policyBody = objectMapper.writeValueAsString(Map.of("params", Map.of("arguments",
                        Map.of("path", ".".equals(directory.path()) ? "" : directory.path()))));
            } catch (Exception serializationError) {
                status = "failed";
                diagnostics.add("policy_request_invalid");
                break;
            }
            if (!policyEngine.allowsByGrant(policy, "list_directory", policyBody, run.getSessionId(),
                    run.getUserId(), run.getWorkspaceId(), false)) {
                status = "failed";
                diagnostics.add("authorization_denied");
                break;
            }
            var verdict = policyEngine.evaluateVerdict(policy, "list_directory", policyBody,
                    run.getSessionId(), null, run.getUserId(), run.getWorkspaceId());
            if (verdict.effect() != PolicyEffect.ALLOW) {
                status = verdict.effect() == PolicyEffect.ASK ? "approval_required" : "failed";
                diagnostics.add(verdict.effect() == PolicyEffect.ASK ? "policy_approval_required" : "policy_denied");
                break;
            }
            remainingRequests[0]--;
            RuntimeContextSourceClient.DirectoryRead read = runtimeClient.listDirectory(
                    session.getWorkspaceId(), directory.path());
            if (!"ready".equals(read.status())) {
                status = read.status();
                diagnostics.add("runtime_directory_list_" + read.status());
                break;
            }
            for (RuntimeContextSourceClient.DirectoryEntry entry : read.entries()) {
                if (scannedEntries >= maxEntries) {
                    truncated = true;
                    diagnostics.add("entry_limit_reached");
                    break;
                }
                scannedEntries++;
                String path = safeRelativePath(entry.path());
                if (entry.symlink()) continue;
                if (path == null) {
                    status = "failed";
                    diagnostics.add("runtime_returned_invalid_path");
                    break;
                }
                String folded = fold(path);
                if (excluded(excludes, folded)) continue;
                if (items.size() >= maxEntries) {
                    truncated = true;
                    diagnostics.add("entry_limit_reached");
                    break;
                }
                if (entry.directory()) {
                    if (directory.depth() < maxDepth) queue.addLast(new Directory(path, directory.depth() + 1));
                    else if (directory.depth() == maxDepth) truncated = true;
                    if (!agentsOnly) items.add(path + "/");
                } else if (includeFiles && (!agentsOnly || fileNames.contains(fold(entry.name())))) {
                    items.add(path);
                }
            }
            if ("failed".equals(status)) break;
            if (items.size() >= maxEntries && !queue.isEmpty()) {
                truncated = true;
                diagnostics.add("entry_limit_reached");
                break;
            }
        }
        if (truncated && "ready".equals(status)) {
            status = "truncated";
        }
        return treeView(status, items, truncated, diagnostics);
    }

    private static Map<String, Object> treeView(String status, List<String> items, boolean truncated,
                                                List<String> diagnostics) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("status", status);
        view.put("source", "runtime_workspace");
        view.put("items", List.copyOf(items));
        view.put("truncated", truncated);
        view.put("diagnostics", List.copyOf(diagnostics));
        return view;
    }

    private static int bounded(int value, int maximum, int fallback) {
        return value < 1 ? fallback : Math.min(value, maximum);
    }

    private static String safeRelativePath(String raw) {
        if (raw == null || raw.isBlank()) return null;
        String path = raw.replace('\\', '/');
        if (path.startsWith("/") || path.matches("^[A-Za-z]:.*")) return null;
        List<String> parts = new ArrayList<>();
        for (String part : path.split("/+")) {
            if (part.isEmpty() || ".".equals(part)) continue;
            if ("..".equals(part)) return null;
            parts.add(part);
        }
        return parts.isEmpty() ? null : String.join("/", parts);
    }

    private static boolean excluded(List<Pattern> patterns, String path) {
        return patterns.stream().anyMatch(pattern -> pattern.matcher(path).matches());
    }

    private static Pattern glob(String raw) {
        String normalized = fold(raw.replace('\\', '/'));
        StringBuilder regex = new StringBuilder("^");
        for (int i = 0; i < normalized.length(); i++) {
            char c = normalized.charAt(i);
            if (c == '*' && i + 1 < normalized.length() && normalized.charAt(i + 1) == '*') {
                regex.append(".*");
                i++;
            } else if (c == '*') regex.append("[^/]*");
            else if (c == '?') regex.append("[^/]");
            else {
                if (".(){}+$^|[]\\".indexOf(c) >= 0) regex.append('\\');
                regex.append(c);
            }
        }
        return Pattern.compile(regex.append('$').toString());
    }

    private static String fold(String value) {
        return value.replace('\\', '/').toLowerCase(Locale.ROOT);
    }

    private record Directory(String path, int depth) { }
}
