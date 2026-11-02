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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

/**
 * PLAN-0635 M2 (D35-03): resolve {@code @文件/目录} tokens in a user message into injectable
 * entries that CP hands to the Agent.
 *
 * <p><b>Reuse, not re-implementation</b> (rulings in the PLAN):</p>
 * <ul>
 *   <li>path rejection is {@link NestedAgentsMdResolver#normalizeTouchedPath} — same package, so
 *       the frozen rules (absolute path / {@code ..} / drive letter / NUL) are shared verbatim
 *       instead of being copied. Widening that helper to {@code public} is explicitly not done;</li>
 *   <li>the read bound is {@link NestedAgentsMdResolver#MAX_FILE_BYTES} (64 KiB) — the same
 *       cap the nested AGENTS.md resolver applies;</li>
 *   <li>authorization reuses the ordinary tool policy ({@code read_file} / {@code list_directory})
 *       exactly like the nested resolver: a denial or ASK only skips that candidate, because
 *       injection is system-initiated and must never open an approval prompt.</li>
 * </ul>
 *
 * <p><b>Token counting is deliberately absent.</b> CP does not estimate tokens: the Agent owns
 * the run-scoped {@code InjectionLedger} and {@code conservative_token_count} (same split as
 * PLAN-0629 memory and PLAN-0627 nested rules). CP only reports {@code truncated} so the Agent
 * can tell the model that a read was cut short.</p>
 *
 * <p><b>Participant-first.</b> A token that the session roster already resolves as a member
 * mention is never treated as a path (the caller supplies that predicate, so the roster matching
 * itself stays the single implementation in {@code chat/MentionParser}).</p>
 */
@Service
public class MentionPathResolver {

    private static final Logger logger = LoggerFactory.getLogger(MentionPathResolver.class);

    /** Top-level entries listed for an {@code @directory} mention (D35-03: bounded). */
    static final int MAX_DIRECTORY_ENTRIES = 20;
    /** Upper bound of distinct path mentions resolved per message (bounded work per turn). */
    static final int MAX_MENTIONS_PER_MESSAGE = 8;

    static final String DIAG_UNSAFE = "mention_path_unsafe";
    static final String DIAG_GRANT_DENIED = "mention_path_grant_denied";
    static final String DIAG_POLICY_ASK = "mention_path_policy_ask_skipped";
    static final String DIAG_POLICY_DENIED = "mention_path_policy_denied";
    static final String DIAG_RUNTIME_UNAVAILABLE = "mention_path_runtime_unavailable";
    static final String DIAG_RUNTIME_FAILED = "mention_path_runtime_failed";
    static final String DIAG_TOO_MANY = "mention_path_limit_reached";

    private final RuntimeContextSourceClient runtimeClient;
    private final PolicyEngine policyEngine;
    private final ObjectMapper objectMapper;

    public MentionPathResolver(RuntimeContextSourceClient runtimeClient,
                               PolicyEngine policyEngine,
                               ObjectMapper objectMapper) {
        this.runtimeClient = runtimeClient;
        this.policyEngine = policyEngine;
        this.objectMapper = objectMapper;
    }

    /**
     * One resolved mention. {@code kind} is {@code file} or {@code directory};
     * {@code content} is the file body (bounded) or the newline-joined directory entry names.
     */
    public record Entry(String path, String kind, String content, boolean truncated) { }

    /** Resolution outcome; {@code diagnostics} carry codes only, never file text. */
    public record Resolution(List<Entry> entries, List<String> diagnostics) {
        public Resolution {
            entries = List.copyOf(entries == null ? List.of() : entries);
            diagnostics = List.copyOf(diagnostics == null ? List.of() : diagnostics);
        }

        public static Resolution empty() {
            return new Resolution(List.of(), List.of());
        }
    }

    /**
     * @param sessionId          session the run belongs to (policy + access scope)
     * @param userId             requesting user
     * @param workspaceId        workspace the paths are relative to
     * @param content            the raw user message (the token source)
     * @param isParticipantToken tokens already claimed by the session roster
     */
    public Resolution resolve(String sessionId, String userId, String workspaceId,
                              String content, Predicate<String> isParticipantToken) {
        if (content == null || content.isBlank() || !content.contains("@")) {
            return Resolution.empty();
        }
        List<String> rawTokens = scanAtTokens(content);
        if (rawTokens.isEmpty()) {
            return Resolution.empty();
        }
        PolicyContext policy = null;
        List<Entry> entries = new ArrayList<>();
        List<String> diagnostics = new ArrayList<>();
        Map<String, Boolean> seen = new LinkedHashMap<>();
        for (String token : rawTokens) {
            if (entries.size() >= MAX_MENTIONS_PER_MESSAGE) {
                diagnostics.add(DIAG_TOO_MANY);
                break;
            }
            if ("all".equalsIgnoreCase(token) || isParticipantToken.test(token)) {
                // Participant-first: the roster owns this token, it is not a path (D35-03).
                continue;
            }
            if (!looksLikePath(token)) {
                continue;
            }
            String normalized = NestedAgentsMdResolver.normalizeTouchedPath(token);
            if (normalized == null || normalized.isEmpty()) {
                diagnostics.add(DIAG_UNSAFE);
                continue;
            }
            if (seen.putIfAbsent(normalized, Boolean.TRUE) != null) {
                continue;
            }
            if (policy == null) {
                policy = policyEngine.loadContext(userId, workspaceId, sessionId);
            }
            Entry entry = resolveOne(policy, sessionId, userId, workspaceId, normalized, diagnostics);
            if (entry != null) {
                entries.add(entry);
            }
        }
        if (!entries.isEmpty() || !diagnostics.isEmpty()) {
            logger.debug("mention paths resolved sessionId={} entries={} diagnostics={}",
                    sessionId, entries.size(), diagnostics.size());
        }
        return new Resolution(entries, diagnostics);
    }

    /**
     * Scans `@tokens` with the same boundary rules as {@code chat/MentionParser}: a `@` glued to
     * a preceding word (an email address) is not a token, and a token ends at whitespace.
     */
    static List<String> scanAtTokens(String content) {
        List<String> tokens = new ArrayList<>();
        int index = 0;
        while (index < content.length()) {
            int at = content.indexOf('@', index);
            if (at < 0) {
                break;
            }
            boolean wordStart = at == 0 || Character.isWhitespace(content.charAt(at - 1));
            if (!wordStart) {
                index = at + 1;
                continue;
            }
            int end = at + 1;
            while (end < content.length() && !Character.isWhitespace(content.charAt(end))) {
                end++;
            }
            if (end > at + 1) {
                tokens.add(content.substring(at + 1, end));
            }
            index = end;
        }
        return tokens;
    }

    /** A mention token is a path candidate only when it carries a path shape (D35-03). */
    static boolean looksLikePath(String token) {
        return token.indexOf('/') >= 0 || token.indexOf('.') >= 0;
    }

    private Entry resolveOne(PolicyContext policy, String sessionId, String userId,
                             String workspaceId, String path, List<String> diagnostics) {
        String readFileBody;
        try {
            readFileBody = policyBody(path);
        } catch (Exception serializationError) {
            logger.warn("mention path policy request serialization failed sessionId={} errorType={}",
                    sessionId, serializationError.getClass().getName());
            diagnostics.add(DIAG_RUNTIME_FAILED);
            return null;
        }
        if (!policyEngine.allowsByGrant(policy, "read_file", readFileBody, sessionId, userId,
                workspaceId, false)) {
            diagnostics.add(DIAG_GRANT_DENIED);
            return null;
        }
        PolicyEffect fileEffect = policyEngine.evaluateVerdict(policy, "read_file", readFileBody,
                sessionId, null, userId, workspaceId).effect();
        if (fileEffect == PolicyEffect.ASK) {
            // System-initiated read: never raise an approval prompt (mirrors D27-10).
            diagnostics.add(DIAG_POLICY_ASK);
            return null;
        }
        if (fileEffect != PolicyEffect.ALLOW) {
            diagnostics.add(DIAG_POLICY_DENIED);
            return null;
        }

        RuntimeContextSourceClient.SourceRead read = runtimeClient.readFile(workspaceId, path);
        if (read.kind() == RuntimeContextSourceClient.SourceReadKind.ERROR) {
            diagnostics.add(diagFor(read.failureStatus()));
            return null;
        }
        if (read.kind() == RuntimeContextSourceClient.SourceReadKind.CONTENT) {
            String text = read.content() == null ? "" : read.content();
            boolean cut = text.getBytes(StandardCharsets.UTF_8).length
                    > NestedAgentsMdResolver.MAX_FILE_BYTES;
            if (cut) {
                // Shared byte-bounded cut — see NestedAgentsMdResolver.cutToBytes (package-private
                // on purpose: one truncation implementation, no new public API).
                text = NestedAgentsMdResolver.cutToBytes(text,
                        NestedAgentsMdResolver.MAX_FILE_BYTES);
            }
            return new Entry(path, "file", text, cut);
        }
        // ABSENT as a file: it may be a directory mention instead.
        if (policyEngine.evaluateVerdict(policy, "list_directory", readFileBody, sessionId, null,
                userId, workspaceId).effect() != PolicyEffect.ALLOW) {
            diagnostics.add(DIAG_POLICY_DENIED);
            return null;
        }
        RuntimeContextSourceClient.DirectoryRead directory =
                runtimeClient.listDirectory(workspaceId, path);
        if (directory.entries().isEmpty()) {
            // Neither a readable file nor a listable directory: stay literal, report nothing.
            return null;
        }
        List<String> names = new ArrayList<>();
        for (RuntimeContextSourceClient.DirectoryEntry entry : directory.entries()) {
            if (names.size() >= MAX_DIRECTORY_ENTRIES) {
                break;
            }
            names.add(entry.directory() ? entry.name() + "/" : entry.name());
        }
        boolean truncated = directory.entries().size() > names.size();
        return new Entry(path, "directory", String.join("\n", names), truncated);
    }

    private static String diagFor(String failureStatus) {
        return "unavailable".equals(failureStatus) ? DIAG_RUNTIME_UNAVAILABLE : DIAG_RUNTIME_FAILED;
    }

    private String policyBody(String path) throws Exception {
        return objectMapper.writeValueAsString(Map.of("params",
                Map.of("arguments", Map.of("path", path))));
    }
}
