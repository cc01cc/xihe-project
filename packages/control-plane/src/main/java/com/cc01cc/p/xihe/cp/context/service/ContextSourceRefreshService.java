package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.context.entity.ContextSourceHash;
import com.cc01cc.p.xihe.cp.context.repository.ContextSourceHashRepository;
import com.cc01cc.p.xihe.cp.logging.LogRedactor;
import com.cc01cc.p.xihe.cp.runtime.RuntimeContextSourceClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0340: per-run context source refresh with L1-slot replacement events.
 *
 * <p>Emits {@code context.source_changed} with an L1 payload (not a history
 * message append). Unchanged content does not emit. I/O failure clears the
 * source ({@code status=failed}) and stays fail-open for the run.
 */
@Service
public class ContextSourceRefreshService {

    private static final Logger logger = LoggerFactory.getLogger(ContextSourceRefreshService.class);

    /** Frozen source key for workspace-root AGENTS.md (M1 single-path). */
    public static final String SOURCE_KEY = "AGENTS.md";
    public static final String SOURCE_PATH = "AGENTS.md";

    public static final String STATUS_CREATED = "created";
    public static final String STATUS_UPDATED = "updated";
    public static final String STATUS_UNCHANGED = "unchanged";
    public static final String STATUS_FAILED = "failed";

    public static final int DEFAULT_AGENTS_MD_MAX_BYTES = 32_768;
    public static final int DEFAULT_ENV_MAX_BYTES = 4_096;

    private final ContextService contextService;
    private final ContextSourceHashRepository sourceHashRepository;
    private final RuntimeContextSourceClient runtimeContextSourceClient;
    private final ContextProjectionService projectionService;
    private final ObjectMapper objectMapper;

    public ContextSourceRefreshService(ContextService contextService,
                                       ContextSourceHashRepository sourceHashRepository,
                                       RuntimeContextSourceClient runtimeContextSourceClient,
                                       ContextProjectionService projectionService,
                                       ObjectMapper objectMapper) {
        this.contextService = contextService;
        this.sourceHashRepository = sourceHashRepository;
        this.runtimeContextSourceClient = runtimeContextSourceClient;
        this.projectionService = projectionService;
        this.objectMapper = objectMapper;
    }

    /**
     * Refresh sources for one chat run. Always attempts a read; compares against
     * the workspace hash AND the session's last injected L1 hash (first inject
     * must not be suppressed by another session's hash).
     *
     * @return status token for logging ({@code created|updated|unchanged|failed})
     */
    @Transactional
    public String refreshForRun(String sessionId, String workspaceId, String userId) {
        return refresh(sessionId, workspaceId, userId);
    }

    @Transactional
    public String refresh(String sessionId, String workspaceId, String userId) {
        Optional<String> content;
        try {
            content = runtimeContextSourceClient.readAgents(workspaceId);
        } catch (Exception e) {
            logger.warn(LogRedactor.redact(
                    "Runtime source fetch failed workspaceId=" + workspaceId + " err=" + e.getMessage()));
            emitFailed(sessionId, workspaceId, userId);
            return STATUS_FAILED;
        }

        if (content.isEmpty() || content.get().isBlank()) {
            // No file: clear L1 agents source if session already has one.
            if (sessionHasAgentsSource(sessionId)) {
                emitFailed(sessionId, workspaceId, userId);
                return STATUS_FAILED;
            }
            return STATUS_UNCHANGED;
        }

        String text = content.get();
        boolean truncated = false;
        byte[] raw = text.getBytes(StandardCharsets.UTF_8);
        int maxBytes = DEFAULT_AGENTS_MD_MAX_BYTES;
        if (raw.length > maxBytes) {
            text = new String(raw, 0, maxBytes, StandardCharsets.UTF_8);
            truncated = true;
        }
        String hash = sha256(text.getBytes(StandardCharsets.UTF_8));

        String lastInjected = lastSessionL1Hash(sessionId);
        boolean firstOrChanged = lastInjected == null || !lastInjected.equals(hash);

        Optional<ContextSourceHash> existing = sourceHashRepository
                .findByWorkspaceIdAndSourceKey(workspaceId, SOURCE_KEY);
        String prevWorkspaceHash = existing.map(ContextSourceHash::getHash).orElse(null);
        boolean created = prevWorkspaceHash == null;

        if (!firstOrChanged) {
            // Session already has this content in L1; keep workspace row fresh.
            upsertWorkspaceHash(workspaceId, hash, existing.orElse(null));
            return STATUS_UNCHANGED;
        }

        String rendered = renderAgentsBlock(text);
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("status", created ? STATUS_CREATED : STATUS_UPDATED);
        payload.put("source_hash", hash);
        payload.put("baseline_hash", hash); // legacy field; L1 uses source_hash
        payload.put("rendered_text", rendered);
        ArrayNode sources = payload.putArray("sources");
        ObjectNode src = sources.addObject();
        src.put("key", SOURCE_KEY);
        src.put("path", SOURCE_PATH);
        src.put("source_type", "agents_md");
        src.put("content", text);
        src.put("content_hash", hash);
        src.put("truncated", truncated);
        src.put("bytes", raw.length);
        src.put("state", "ok");

        Map<String, Object> eventPayload = objectMapper.convertValue(payload, Map.class);
        contextService.appendEvent(sessionId, workspaceId, userId, "context.source_changed", eventPayload);
        upsertWorkspaceHash(workspaceId, hash, existing.orElse(null));
        logger.info(LogRedactor.redact(
                "context sources refreshed sessionId=" + sessionId + " status=" + payload.get("status").asText()
                        + " hashPrefix=" + hash.substring(0, Math.min(8, hash.length()))));
        return payload.get("status").asText();
    }

    private void emitFailed(String sessionId, String workspaceId, String userId) {
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("status", STATUS_FAILED);
        payload.put("source_hash", "");
        payload.put("rendered_text", "");
        payload.putArray("sources");
        contextService.appendEvent(sessionId, workspaceId, userId, "context.source_changed",
                objectMapper.convertValue(payload, Map.class));
    }

    private void upsertWorkspaceHash(String workspaceId, String hash, ContextSourceHash existing) {
        ContextSourceHash row = existing != null ? existing : new ContextSourceHash(workspaceId, SOURCE_KEY, hash);
        row.setHash(hash);
        sourceHashRepository.save(row);
    }

    private boolean sessionHasAgentsSource(String sessionId) {
        ObjectNode context = projectionService.project(sessionId, 0L);
        ObjectNode epoch = (ObjectNode) context.get("epoch");
        if (epoch == null) {
            return false;
        }
        if (epoch.hasNonNull("source_hash") && !epoch.get("source_hash").asText().isBlank()) {
            return true;
        }
        return epoch.hasNonNull("l1_rendered") && !epoch.get("l1_rendered").asText().isBlank();
    }

    private String lastSessionL1Hash(String sessionId) {
        ObjectNode context = projectionService.project(sessionId, 0L);
        ObjectNode epoch = (ObjectNode) context.get("epoch");
        if (epoch == null || !epoch.hasNonNull("source_hash")) {
            return null;
        }
        String hash = epoch.get("source_hash").asText();
        return hash.isBlank() ? null : hash;
    }

    static String renderAgentsBlock(String body) {
        return "<system-reminder>\n"
                + "Workspace rules from AGENTS.md (trusted project instructions):\n"
                + "----- AGENTS.md -----\n"
                + body.stripTrailing()
                + "\n----- end AGENTS.md -----\n"
                + "</system-reminder>";
    }

    static String sha256(byte[] content) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] encoded = digest.digest(content);
            return Base64.getEncoder().encodeToString(encoded);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }
}
