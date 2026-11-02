package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.runtime.RuntimeContextSourceClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * PLAN-0627 M1 / D27-21: resolve the ancestor {@code AGENTS.md} chain for one touched path.
 *
 * <p>Contract frozen by the M0/M1 rulings:
 * <ul>
 *   <li>chain starts at the touched path's directory, walking <b>up</b> to the workspace
 *       root and stops there — the upper bound is the workspace root, never the git root
 *       (Runtime cannot read outside the workspace);</li>
 *   <li>the <b>workspace-root</b> {@code AGENTS.md} is <b>not</b> part of the chain: it is
 *       already injected eagerly by {@code root_agents_md}/L1, so including it would double
 *       the root rules and let eviction reach the root (D27-21);</li>
 *   <li>at most {@link #MAX_ANCESTORS} sub-directory layers are returned, keeping the
 *       nearest ones (frozen "超限保留最近祖先");</li>
 *   <li>entries are returned <b>root -&gt; nearest</b> so rendering is deterministic and the
 *       most specific file comes last;</li>
 *   <li>authorization reuses the ordinary tool policy: a grant denial / ASK / DENY for a
 *       candidate file only skips that file (no approval prompt is ever raised — injection
 *       is system-initiated, never a user action); a transport/contract failure fails the
 *       whole resolution closed with no entries.</li>
 * </ul>
 *
 * <p>The resolver is stateless and does not cache: PLAN-0627 keeps the run-scoped dedupe and
 * the injection budget ledger on the Agent side ({@code context/injection_budget.py}).
 */
@Service
public class NestedAgentsMdResolver {

    private static final Logger logger = LoggerFactory.getLogger(NestedAgentsMdResolver.class);

    /** Frozen single candidate file name (D27-04: exact case, no CLAUDE.md/GEMINI.md). */
    static final String AGENTS_FILE = "AGENTS.md";
    /** Depth bound; keeps the nearest layers when a path is deeper than this. */
    static final int MAX_ANCESTORS = 32;
    /** Per-file raw read bound (the Agent applies its own 4 KiB per-file budget). */
    static final int MAX_FILE_BYTES = 64 * 1024;

    private static final String DIAG_GRANT_DENIED = "nested_agents_md_grant_denied";
    private static final String DIAG_POLICY_ASK = "nested_agents_md_policy_ask_skipped";
    private static final String DIAG_POLICY_DENIED = "nested_agents_md_policy_denied";
    private static final String DIAG_UNSAFE_PATH = "nested_agents_md_unsafe_path";

    private final RuntimeContextSourceClient runtimeClient;
    private final PolicyEngine policyEngine;
    private final ObjectMapper objectMapper;

    public NestedAgentsMdResolver(RuntimeContextSourceClient runtimeClient,
                                  PolicyEngine policyEngine,
                                  ObjectMapper objectMapper) {
        this.runtimeClient = runtimeClient;
        this.policyEngine = policyEngine;
        this.objectMapper = objectMapper;
    }

    /** One ancestor file. {@code truncated} marks a read cut at {@link #MAX_FILE_BYTES}. */
    public record Entry(String path, String content, boolean truncated) { }

    /** Resolution outcome: {@code ready | truncated | failed | unavailable}. */
    public record Resolution(String status, List<Entry> entries, List<String> diagnostics) {
        public Resolution {
            entries = List.copyOf(entries == null ? List.of() : entries);
            diagnostics = List.copyOf(diagnostics == null ? List.of() : diagnostics);
        }
    }

    /**
     * @param sessionId    session the run belongs to (access + policy scope)
     * @param userId       requesting user (policy context)
     * @param workspaceId  workspace the touched path lives in (Runtime scope)
     * @param tool         tool that touched the path; {@code list_directory} means the path
     *                     itself is the directory, everything else treats it as a file
     * @param touchedPath  workspace-relative path reported by the tool
     */
    public Resolution resolve(String sessionId, String userId, String workspaceId,
                              String tool, String touchedPath) {
        String normalized = normalizeTouchedPath(touchedPath);
        if (normalized == null) {
            logger.warn("nested AGENTS.md resolve rejected an unsafe path sessionId={} workspaceId={}",
                    sessionId, workspaceId);
            return new Resolution("failed", List.of(), List.of(DIAG_UNSAFE_PATH));
        }
        boolean directoryTouch = "list_directory".equals(tool);
        List<String> nearestFirst = ancestorDirectories(normalized, directoryTouch);
        if (nearestFirst.isEmpty()) {
            // Touched path is the workspace root itself: the root file belongs to L1.
            return new Resolution("ready", List.of(), List.of());
        }

        PolicyContext policy = policyEngine.loadContext(userId, workspaceId, sessionId);
        List<Entry> entries = new ArrayList<>();
        List<String> diagnostics = new ArrayList<>();
        boolean truncated = false;
        for (int index = nearestFirst.size() - 1; index >= 0; index--) {
            String directory = nearestFirst.get(index);
            String filePath = directory + "/" + AGENTS_FILE;
            String policyBody;
            try {
                policyBody = policyBody(filePath);
            } catch (Exception serializationError) {
                logger.warn("nested AGENTS.md policy request serialization failed sessionId={} errorType={}",
                        sessionId, serializationError.getClass().getName());
                return new Resolution("failed", List.of(), List.of("nested_agents_md_policy_request_invalid"));
            }
            if (!policyEngine.allowsByGrant(policy, "read_file", policyBody, sessionId,
                    userId, workspaceId, false)) {
                diagnostics.add(DIAG_GRANT_DENIED);
                continue;
            }
            var verdict = policyEngine.evaluateVerdict(policy, "read_file", policyBody,
                    sessionId, null, userId, workspaceId);
            if (verdict.effect() == PolicyEffect.ASK) {
                // System-initiated read: never open an approval prompt for it (D27-10).
                diagnostics.add(DIAG_POLICY_ASK);
                continue;
            }
            if (verdict.effect() != PolicyEffect.ALLOW) {
                diagnostics.add(DIAG_POLICY_DENIED);
                continue;
            }
            RuntimeContextSourceClient.SourceRead read = runtimeClient.readFile(workspaceId, filePath);
            if (read.kind() == RuntimeContextSourceClient.SourceReadKind.ABSENT) {
                continue;
            }
            if (read.kind() == RuntimeContextSourceClient.SourceReadKind.ERROR) {
                String failureStatus = read.failureStatus();
                logger.warn("nested AGENTS.md read failed sessionId={} workspaceId={} path={} status={} httpStatus={}",
                        sessionId, workspaceId, filePath, failureStatus, read.httpStatus());
                return new Resolution(failureStatus, List.of(),
                        List.of("nested_agents_md_runtime_" + failureStatus));
            }
            String content = read.content() == null ? "" : read.content();
            if (content.isBlank()) {
                continue;
            }
            boolean cut = false;
            if (content.getBytes(StandardCharsets.UTF_8).length > MAX_FILE_BYTES) {
                content = cutToBytes(content, MAX_FILE_BYTES);
                cut = true;
                truncated = true;
            }
            entries.add(new Entry(filePath, content, cut));
        }
        String status = truncated ? "truncated" : "ready";
        logger.debug("nested AGENTS.md resolved sessionId={} tool={} entries={} diagnostics={}",
                sessionId, tool, entries.size(), diagnostics.size());
        return new Resolution(status, entries, diagnostics);
    }

    private String policyBody(String filePath) throws Exception {
        return objectMapper.writeValueAsString(Map.of("params",
                Map.of("arguments", Map.of("path", filePath))));
    }

    /**
     * Workspace-relative normalization; {@code null} when the path cannot be trusted.
     * Mirrors the path rules of the existing tree resolver so there is one vocabulary.
     */
    static String normalizeTouchedPath(String raw) {
        if (raw == null || raw.isBlank()) {
            return "";
        }
        String path = raw.strip().replace('\\', '/');
        if (path.indexOf('\u0000') >= 0 || path.startsWith("/") || path.startsWith("//")) {
            return null;
        }
        if (path.matches("^[A-Za-z]:.*")) {
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
        return String.join("/", parts);
    }

    /**
     * Directories between the touched path's own directory and the workspace root,
     * <b>nearest first</b>, capped at {@link #MAX_ANCESTORS} (the cap therefore drops the
     * farthest layers, matching the frozen eviction order).
     */
    static List<String> ancestorDirectories(String normalizedPath, boolean directoryTouch) {
        String directory;
        if (normalizedPath.isEmpty()) {
            return List.of();
        }
        if (directoryTouch) {
            directory = normalizedPath;
        } else {
            int slash = normalizedPath.lastIndexOf('/');
            directory = slash < 0 ? "" : normalizedPath.substring(0, slash);
        }
        List<String> nearestFirst = new ArrayList<>();
        while (!directory.isEmpty() && nearestFirst.size() < MAX_ANCESTORS) {
            nearestFirst.add(directory);
            int slash = directory.lastIndexOf('/');
            directory = slash < 0 ? "" : directory.substring(0, slash);
        }
        return nearestFirst;
    }

    private static String cutToBytes(String text, int maxBytes) {
        byte[] raw = text.getBytes(StandardCharsets.UTF_8);
        if (raw.length <= maxBytes) {
            return text;
        }
        int limit = maxBytes;
        while (limit > 0 && (raw[limit] & 0xC0) == 0x80) {
            limit--;
        }
        return new String(raw, 0, limit, StandardCharsets.UTF_8);
    }
}
