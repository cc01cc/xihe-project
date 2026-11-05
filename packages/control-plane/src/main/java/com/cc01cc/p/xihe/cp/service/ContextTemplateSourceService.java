package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.runtime.RuntimeContextSourceClient;
import com.cc01cc.p.xihe.cp.skill.SkillCatalogSnapshotService;
import com.cc01cc.p.xihe.cp.skill.SkillCatalogSourceService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/** Resolves bounded, path-only tree components from the admission-frozen template snapshot. */
@Service
public class ContextTemplateSourceService {
    private static final Logger logger = LoggerFactory.getLogger(ContextTemplateSourceService.class);
    private static final int HARD_REQUEST_LIMIT = 512;
    private static final int DEFAULT_MAX_DEPTH = 8;
    private static final int DEFAULT_MAX_ENTRIES = 2000;
    private static final List<String> DEFAULT_AGENTS_FILES = List.of("AGENTS.md");
    /** PLAN-0678 T2.3: the run's frozen template carries neither memory nor skill component. */
    public static final String DIAGNOSTIC_NO_COMPONENTS = "no_components";

    private final RuntimeContextSourceClient runtimeClient;
    private final PolicyEngine policyEngine;
    private final ObjectMapper objectMapper;
    private final AgentMemoryInjectionService agentMemoryInjectionService;
    private final SkillCatalogSourceService skillCatalogSourceService;

    public ContextTemplateSourceService(RuntimeContextSourceClient runtimeClient,
                                        PolicyEngine policyEngine,
                                        ObjectMapper objectMapper,
                                        AgentMemoryInjectionService agentMemoryInjectionService,
                                        SkillCatalogSourceService skillCatalogSourceService) {
        this.runtimeClient = runtimeClient;
        this.policyEngine = policyEngine;
        this.objectMapper = objectMapper;
        this.agentMemoryInjectionService = agentMemoryInjectionService;
        this.skillCatalogSourceService = skillCatalogSourceService;
    }

    public Map<String, Object> resolve(RunContext run, Session session) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (run == null) {
            return Map.of();
        }
        boolean validBinding = session != null && session.getId() != null
                && run.sessionId().equals(session.getId().toString())
                && run.workspaceId().equals(session.getWorkspaceId())
                && run.userId().equals(session.getUserId());
        JsonNode components = run.contextTemplateSnapshot() == null ? null
                : run.contextTemplateSnapshot().path("template").path("components");
        if (components == null || !components.isArray()) {
            logger.warn("[INJECTION] service=cp event=injection_components_absent runId={} reason={}",
                    run.runId(), DIAGNOSTIC_NO_COMPONENTS);
            return result;
        }
        int[] remainingRequests = {HARD_REQUEST_LIMIT};
        boolean seenEligible = false;
        for (JsonNode component : components) {
            String type = component.path("type").asText();
            if (!component.path("enabled").asBoolean(false)
                    || !("workspace_tree".equals(type) || "agents_md_tree".equals(type)
                    || "agent_memory".equals(type) || "skill_catalog".equals(type))) {
                continue;
            }
            seenEligible = true;
            String instanceId = component.path("instanceId").asText();
            if (instanceId.isBlank()) {
                continue;
            }
            if ("agent_memory".equals(type)) {
                // PLAN-0629 M1-4: the memory snapshot is read per run and never cached across runs.
                Map<String, Object> memory = resolveMemory(component.path("config"), run, validBinding);
                result.put(instanceId, memory);
                logSkippedSource(run, AgentMemoryInjectionService.SOURCE, memory);
                continue;
            }
            if ("skill_catalog".equals(type)) {
                // PLAN-0628 M1: the listing subset — a count bound here, the token budget in Agent.
                Map<String, Object> skills = resolveSkillCatalog(component.path("config"), run, validBinding);
                result.put(instanceId, skills);
                logSkippedSource(run, SkillCatalogSourceService.SOURCE, skills);
                continue;
            }
            result.put(instanceId, resolveTree(
                    component.path("config"), type, run, session, validBinding, remainingRequests));
        }
        if (!seenEligible) {
            logger.warn("[INJECTION] service=cp event=injection_components_absent runId={} reason={}",
                    run.runId(), DIAGNOSTIC_NO_COMPONENTS);
        }
        return result;
    }

    /**
     * PLAN-0678 T2.3: a skipped injection must never be silent. The component view already carries
     * the machine-readable diagnostics ({@code missing_agent_principal} / {@code no_memories} /
     * {@code budget_trimmed} / {@code skill_snapshot_absent} ...); this mirrors them into the log so
     * an empty slot is distinguishable from a component that never ran.
     */
    private void logSkippedSource(RunContext run, String source, Map<String, Object> view) {
        Object status = view.get("status");
        if (status == null || "ready".equals(status.toString())) {
            return;
        }
        Object diagnostics = view.get("diagnostics");
        logger.warn("[INJECTION] service=cp event=injection_component_skipped runId={} source={}"
                        + " status={} diagnostics={}", run.runId(), source, status,
                diagnostics == null ? List.of() : diagnostics);
    }

    /**
     * PLAN-0629 M1-4 (D29-20): the memory component's per-run source document.
     *
     * <p>Reads exactly one {@code (principal, workspace)} pair — never a union, never a fallback to
     * "any workspace of this principal" — and reports failure explicitly instead of injecting an empty
     * block that would look like "this subject has no memory".</p>
     */
    private Map<String, Object> resolveMemory(JsonNode config, RunContext run, boolean validBinding) {
        int maxEntries = bounded(config.path("maxEntries").asInt(AgentMemoryInjectionService.DEFAULT_MAX_ENTRIES),
                AgentMemoryInjectionService.MAX_ENTRIES_UPPER, AgentMemoryInjectionService.DEFAULT_MAX_ENTRIES);
        int maxTokens = bounded(config.path("maxTokens").asInt(AgentMemoryInjectionService.DEFAULT_MAX_TOKENS),
                AgentMemoryInjectionService.MAX_TOKENS_UPPER, AgentMemoryInjectionService.DEFAULT_MAX_TOKENS);
        if (!validBinding) {
            return AgentMemoryInjectionService.unavailable(maxEntries, maxTokens,
                    "invalid_session_workspace_binding");
        }
        String principal = run.agentPrincipalId();
        if (principal == null || principal.isBlank()) {
            return AgentMemoryInjectionService.unavailable(maxEntries, maxTokens,
                    AgentMemoryInjectionService.DIAGNOSTIC_MISSING_PRINCIPAL);
        }
        UUID principalId;
        UUID workspaceId;
        try {
            principalId = UUID.fromString(principal);
            workspaceId = UUID.fromString(run.workspaceId());
        } catch (IllegalArgumentException e) {
            return AgentMemoryInjectionService.unavailable(maxEntries, maxTokens, "invalid_agent_principal");
        }
        return agentMemoryInjectionService.snapshot(principalId, workspaceId, maxEntries, maxTokens);
    }

    /**
     * PLAN-0628 M1 (D28-16): the skills listing component's per-run source document.
     *
     * <p>A skill listing is subject-scoped, so the same {@code validBinding} guard the memory
     * component uses applies: an invalid session/workspace binding must not resolve anyone's library.
     * CP passes {@code maxSkills} (a count) and never a token number — the budget belongs to the
     * Agent's ledger.</p>
     *
     * <p><b>PLAN-0628 M2a (D28-39): the Run's snapshot is the only read source.</b> When the Run was
     * admitted with a captured listing, this method renders from {@code chat_runs.skills_snapshot}
     * and never consults {@code skill_bindings} — so a binding added or removed after admission
     * cannot change what this Run's model sees. Only a pre-M2a Run ({@code {}} = "not captured",
     * D28-40) falls back to live resolution, and it says so in the view's diagnostics and in the log:
     * a historical Run must not silently look like "this was always the listing".</p>
     */
    private Map<String, Object> resolveSkillCatalog(JsonNode config, RunContext run,
                                                    boolean validBinding) {
        if (!validBinding) {
            return SkillCatalogSourceService.failed("invalid_session_workspace_binding").toMap();
        }
        UUID userId;
        UUID workspaceId;
        UUID principalId = null;
        try {
            userId = UUID.fromString(run.userId());
            workspaceId = UUID.fromString(run.workspaceId());
            String principal = run.agentPrincipalId();
            if (principal != null && !principal.isBlank()) {
                principalId = UUID.fromString(principal);
            }
        } catch (IllegalArgumentException invalidId) {
            return SkillCatalogSourceService.failed("invalid_agent_principal").toMap();
        }
        SkillCatalogSourceService.Request request =
                SkillCatalogSourceService.requestFrom(config, principalId, userId, workspaceId);
        if (!SkillCatalogSnapshotService.isAbsent(run.skillsSnapshot())) {
            return SkillCatalogSourceService
                    .renderFromSnapshot(run.skillsSnapshot(), request).toMap();
        }
        // D28-40 legacy fallback: the Run predates M2a, so nothing was captured. Resolve live (an
        // empty listing would make the capability set vanish overnight), mark the view, log the
        // reason — and never write the result back: a fabricated capture is worse than a missing one.
        Map<String, Object> fallback = skillCatalogSourceService.resolve(request).toMap();
        logger.warn("[LIFECYCLE] service=cp event=skill_snapshot_absent runId={} reason={} fallback=live",
                run.runId(), SkillCatalogSnapshotService.DIAG_ABSENT);
        return withDiagnostic(fallback, SkillCatalogSnapshotService.DIAG_ABSENT);
    }

    /** Adds a diagnostic to a component view without mutating (or trusting) the producer's map. */
    private static Map<String, Object> withDiagnostic(Map<String, Object> view, String diagnostic) {
        List<String> diagnostics = new ArrayList<>();
        if (view.get("diagnostics") instanceof List<?> existing) {
            for (Object entry : existing) {
                if (entry instanceof String text) {
                    diagnostics.add(text);
                }
            }
        }
        if (!diagnostics.contains(diagnostic)) {
            diagnostics.add(diagnostic);
        }
        Map<String, Object> marked = new LinkedHashMap<>(view);
        marked.put("diagnostics", List.copyOf(diagnostics));
        return marked;
    }

    private Map<String, Object> resolveTree(JsonNode config, String type, RunContext run, Session session,
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
            names.forEach(n -> {
                if (n.isTextual() && !n.asText().isBlank()) {
                    fileNames.add(fold(n.asText()));
                }
            });
        }
        if (agentsOnly && fileNames.isEmpty()) {
            fileNames.addAll(DEFAULT_AGENTS_FILES.stream().map(ContextTemplateSourceService::fold).toList());
        }
        List<Pattern> excludes = new ArrayList<>();
        JsonNode patterns = config.path("excludePatterns");
        if (patterns.isArray()) {
            patterns.forEach(n -> {
                if (n.isTextual()) {
                    excludes.add(glob(n.asText()));
                }
            });
        }
        ArrayDeque<Directory> queue = new ArrayDeque<>();
        queue.add(new Directory(".", 0));
        int scannedEntries = 0;
        PolicyContext policy = policyEngine.loadContext(run.userId(), run.workspaceId(), run.sessionId());
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
            if (!policyEngine.allowsByGrant(policy, "list_directory", policyBody, run.sessionId(),
                    run.userId(), run.workspaceId(), false)) {
                status = "failed";
                diagnostics.add("authorization_denied");
                break;
            }
            var verdict = policyEngine.evaluateVerdict(policy, "list_directory", policyBody,
                    run.sessionId(), null, run.userId(), run.workspaceId());
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
                if (entry.symlink()) {
                    continue;
                }
                if (path == null) {
                    status = "failed";
                    diagnostics.add("runtime_returned_invalid_path");
                    break;
                }
                String folded = fold(path);
                if (excluded(excludes, folded)) {
                    continue;
                }
                if (items.size() >= maxEntries) {
                    truncated = true;
                    diagnostics.add("entry_limit_reached");
                    break;
                }
                if (entry.directory()) {
                    if (directory.depth() < maxDepth) {
                        queue.addLast(new Directory(path, directory.depth() + 1));
                    } else if (directory.depth() == maxDepth) {
                        truncated = true;
                    }
                    if (!agentsOnly) {
                        items.add(path + "/");
                    }
                } else if (includeFiles && (!agentsOnly || fileNames.contains(fold(entry.name())))) {
                    items.add(path);
                }
            }
            if ("failed".equals(status)) {
                break;
            }
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
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String path = raw.replace('\\', '/');
        if (path.startsWith("/") || path.matches("^[A-Za-z]:.*")) {
            return null;
        }
        List<String> parts = new ArrayList<>();
        for (String part : path.split("/+")) {
            if (part.isEmpty() || ".".equals(part)) {
                continue;
            }
            if ("..".equals(part)) {
                return null;
            }
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
            } else if (c == '*') {
                regex.append("[^/]*");
            } else if (c == '?') {
                regex.append("[^/]");
            } else {
                if (".(){}+$^|[]\\".indexOf(c) >= 0) {
                    regex.append('\\');
                }
                regex.append(c);
            }
        }
        return Pattern.compile(regex.append('$').toString());
    }

    private static String fold(String value) {
        return value.replace('\\', '/').toLowerCase(Locale.ROOT);
    }

    /** Immutable run identifiers and frozen snapshots; consumers must treat the JsonNodes as read-only. */
    /**
     * @param runId the Run this resolution belongs to — carried for the D28-40 legacy-fallback log
     *     line, so "this Run had no snapshot" can be traced to the Run that rendered it
     * @param skillsSnapshot PLAN-0628 M2a: the listing frozen at admission; {@code {}} means "not
     *     captured" (D28-40), which is the only case that still resolves live
     * @param agentPrincipalId the subject whose memory may be injected (null for runs without a bound
     *     principal — the memory component then reports {@code missing_agent_principal} and injects
     *     nothing rather than falling back to a wider scope)
     */
    public record RunContext(String runId, String sessionId, String workspaceId, String userId,
                             JsonNode contextTemplateSnapshot, JsonNode skillsSnapshot,
                             String agentPrincipalId) {
    }

    private record Directory(String path, int depth) { }
}
