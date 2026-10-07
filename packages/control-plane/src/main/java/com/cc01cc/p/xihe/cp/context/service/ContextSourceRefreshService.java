package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.context.entity.ContextSourceHash;
import com.cc01cc.p.xihe.cp.context.repository.ContextSourceHashRepository;
import com.cc01cc.p.xihe.cp.logging.LogRedactor;
import com.cc01cc.p.xihe.cp.runtime.RuntimeContextSourceClient;
import com.cc01cc.p.xihe.cp.runtime.RuntimeContextSourceClient.SourceRead;
import com.cc01cc.p.xihe.cp.runtime.RuntimeContextSourceClient.SourceReadKind;
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
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * PLAN-0340: per-run context source refresh with L1-slot replacement events.
 *
 * <p>PLAN-0382 (Q2=A frozen, spec §3): {@code context.source_changed} carries
 * {@code l1_status} ({@code ok|missing|unavailable|failed|unknown}); the legacy
 * {@code status} key keeps its emission vocabulary and gains {@code missing} and
 * {@code unavailable}. Content reads emit {@code created}/{@code updated} plus
 * {@code l1_status=ok}; an absent file ({@code found:false}) is a legal
 * {@code missing} (never an error); transport/5xx failures emit
 * {@code unavailable} and 4xx/parse failures emit {@code failed} — both are
 * fail-closed for this run (no stale L1 injection, no unmarked {@code sources}
 * fallback, BL-48).
 *
 * <p>Env facts refresh runs on every path now, keeps last-known-good values
 * when Runtime is unreachable and only flips {@code env_status=unavailable}
 * (spec §2.1 idempotency double rule: value-set + status dedupe, status flips
 * always emit, {@code observedAt} never triggers an event).
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

    /** PLAN-0382 l1_status five values (spec §3). */
    public static final String L1_OK = "ok";
    public static final String L1_MISSING = "missing";
    public static final String L1_UNAVAILABLE = "unavailable";
    public static final String L1_FAILED = "failed";
    public static final String L1_UNKNOWN = "unknown";

    /** PLAN-0382 env_status four values (spec §3). */
    public static final String ENV_OK = "ok";
    public static final String ENV_NOT_REPOSITORY = "not_repository";
    public static final String ENV_UNAVAILABLE = "unavailable";
    public static final String ENV_UNKNOWN = "unknown";

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
     * @return status token for logging and the U2 SSE gate
     *         ({@code created|updated|unchanged|missing|unavailable|failed})
     */
    @Transactional
    public String refreshForRun(String sessionId, String workspaceId, String userId) {
        return refreshForRun(sessionId, workspaceId, userId, true);
    }

    @Transactional
    public String refreshForRun(String sessionId, String workspaceId, String userId, boolean refreshRootAgentsMd) {
        String result = refreshRootAgentsMd
                ? refreshRootAgents(sessionId, workspaceId, userId)
                : STATUS_UNCHANGED;
        // PLAN-0382: env facts refresh on EVERY path, independent of the root
        // AGENTS.md source-refresh policy selected by the template component.
        refreshEnvFacts(sessionId, workspaceId, userId);
        return result;
    }

    /** Backward-compatible explicit refresh path for existing callers/tests. */
    @Transactional
    public String refresh(String sessionId, String workspaceId, String userId) {
        return refreshForRun(sessionId, workspaceId, userId, true);
    }

    /**
     * A per_session root source pins the first successful content read or
     * explicit found:false observation. Transient unknown/unavailable/failed
     * states are not pinned and are retried on a later Run.
     */
    @Transactional(readOnly = true)
    public boolean hasSuccessfulSessionL1Snapshot(String sessionId) {
        String status = projectedL1Status(sessionId);
        if (L1_OK.equals(status) || L1_MISSING.equals(status)) {
            return true;
        }
        return status == null && lastSessionL1Hash(sessionId) != null;
    }

    private String refreshRootAgents(String sessionId, String workspaceId, String userId) {
        SourceRead read;
        try {
            read = runtimeContextSourceClient.readAgents(workspaceId);
        } catch (Exception e) {
            logger.warn(LogRedactor.redact(
                    "Runtime source fetch failed workspaceId=" + workspaceId + " err=" + e.getMessage()));
            read = SourceRead.error(null);
        }

        String result;
        if (read.kind() == SourceReadKind.ABSENT) {
            result = emitMissing(sessionId, workspaceId, userId);
        } else if (read.kind() == SourceReadKind.ERROR) {
            String failureStatus = read.failureStatus();
            emitSourceState(sessionId, workspaceId, userId, failureStatus);
            result = failureStatus;
        } else {
            result = ingestContent(sessionId, workspaceId, userId, read.content());
        }
        return result;
    }

    /** CONTENT branch: a successful read, including a legal empty file (l1_status=ok). */
    private String ingestContent(String sessionId, String workspaceId, String userId, String content) {
        String text = content == null ? "" : content;
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

        String rendered = text.isBlank()
                ? ""
                : ContextInjectionRender.renderAgentsChain(List.of(
                        new ContextInjectionRender.SourceEntry(SOURCE_PATH, text)));
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("status", created ? STATUS_CREATED : STATUS_UPDATED);
        payload.put("l1_status", L1_OK);
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
        src.put("state", L1_OK);

        Map<String, Object> eventPayload = objectMapper.convertValue(payload, Map.class);
        contextService.appendEvent(sessionId, workspaceId, userId, "context.source_changed", eventPayload);
        upsertWorkspaceHash(workspaceId, hash, existing.orElse(null));
        logger.info(LogRedactor.redact(
                "context sources refreshed sessionId=" + sessionId + " status=" + payload.get("status").asText()
                        + " hashPrefix=" + hash.substring(0, Math.min(8, hash.length()))));
        return payload.get("status").asText();
    }

    /**
     * PLAN-0382 spec §3: found:false clears any injected L1 with an explicit
     * {@code missing} mark (legal absence — never an error/告警). Idempotent per
     * the l1 double rule: hash empty + status already missing → no event.
     */
    private String emitMissing(String sessionId, String workspaceId, String userId) {
        if (L1_MISSING.equals(projectedL1Status(sessionId)) && lastSessionL1Hash(sessionId) == null) {
            return L1_MISSING;
        }
        emitSourceState(sessionId, workspaceId, userId, L1_MISSING);
        return L1_MISSING;
    }

    /**
     * PLAN-0382 Q2=A: emit a cleared L1 slot with an explicit status
     * ({@code missing|unavailable|failed}). Fail-closed for this run: the slot
     * is emptied with its state mark, so replay can never fall back to the old
     * {@code sources} array unmarked (BL-48 — projection clears it too).
     * Idempotent: identical (hash empty, status) already projected → skip.
     */
    private void emitSourceState(String sessionId, String workspaceId, String userId, String l1Status) {
        if (l1Status.equals(projectedL1Status(sessionId)) && lastSessionL1Hash(sessionId) == null) {
            return;
        }
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("status", l1Status);
        payload.put("l1_status", l1Status);
        payload.put("source_hash", "");
        payload.put("rendered_text", "");
        payload.putArray("sources");
        contextService.appendEvent(sessionId, workspaceId, userId, "context.source_changed",
                objectMapper.convertValue(payload, Map.class));
        logger.info(LogRedactor.redact(
                "context source state sessionId=" + sessionId + " l1_status=" + l1Status));
    }

    /**
     * PLAN-0382 T0.5/B6: {@code ChatController.refreshForRun} used to swallow
     * refresh exceptions without any event, so an old {@code l1_status=ok}
     * survived as if fresh (fail-open bypass of the frozen fail-closed policy).
     * This method records the failure state explicitly; the run itself still
     * continues (availability), but the L1 slot is fail-closed for it.
     */
    @Transactional
    public void markSourceUnavailable(String sessionId, String workspaceId, String userId) {
        try {
            emitSourceState(sessionId, workspaceId, userId, L1_UNAVAILABLE);
        } catch (Exception e) {
            // Last resort: never let the failure marker break the run it protects.
            logger.warn(LogRedactor.redact(
                    "emit source unavailable failed sessionId=" + sessionId + " err=" + e.getMessage()));
        }
    }

    /**
     * PLAN-0382 T1.2/T1.4 (spec §2.1 value-source table + idempotency double rule):
     * env facts emission.
     *
     * <ul>
     *   <li>Runtime reachable: {@code env_status = not_repository | ok}; new fact
     *       keys ({@code cwd/platform/shell/observedAt}) map to {@code env_cwd/
     *       env_platform/env_shell/env_observed_at}; a response missing the new
     *       keys (Runtime &lt; PLAN-0427, mixed deployment) records
     *       {@code env_status=unknown} with null fields.</li>
     *   <li>Runtime unreachable: keep every last-known-good value, only flip
     *       {@code env_status=unavailable} (never rewrite LKG to empty).</li>
     *   <li>Emit only when the six value fields or the status changed;
     *       {@code observedAt} never triggers an event by itself.</li>
     * </ul>
     */
    private void refreshEnvFacts(String sessionId, String workspaceId, String userId) {
        Optional<Map<String, Object>> factsOpt = runtimeContextSourceClient.readGitFacts(workspaceId);
        ObjectNode context = projectionService.project(sessionId, 0L);
        ObjectNode epoch = (ObjectNode) context.get("epoch");

        String prevBranch = epochPath(epoch, "env_branch");
        String prevHead = epochPath(epoch, "env_head");
        boolean prevIsRepo = epoch != null && epoch.path("env_is_repository").asBoolean(false);
        String prevCwd = epochPathOrNull(epoch, "env_cwd");
        String prevPlatform = epochPathOrNull(epoch, "env_platform");
        String prevShell = epochPathOrNull(epoch, "env_shell");
        String prevObservedAt = epochPathOrNull(epoch, "env_observed_at");
        String prevStatus = epochPathOrNull(epoch, "env_status");

        String status;
        String branch;
        String head;
        boolean isRepository;
        String cwd;
        String platform;
        String shell;
        String observedAt;

        if (factsOpt.isEmpty()) {
            // Unreachable: keep last-known-good values, flip the status only.
            status = ENV_UNAVAILABLE;
            branch = prevBranch;
            head = prevHead;
            isRepository = prevIsRepo;
            cwd = prevCwd;
            platform = prevPlatform;
            shell = prevShell;
            observedAt = prevObservedAt;
        } else {
            Map<String, Object> facts = factsOpt.get();
            isRepository = Boolean.TRUE.equals(facts.get("isRepository"));
            branch = factText(facts, "branch");
            head = factText(facts, "head");
            // Mixed deployment (spec §5): old Runtime never sends observedAt.
            boolean upgraded = facts.containsKey("observedAt");
            status = !upgraded ? ENV_UNKNOWN : (isRepository ? ENV_OK : ENV_NOT_REPOSITORY);
            cwd = upgraded ? factTextOrNull(facts, "cwd") : null;
            platform = upgraded ? factTextOrNull(facts, "platform") : null;
            shell = upgraded ? factTextOrNull(facts, "shell") : null;
            observedAt = upgraded ? factTextOrNull(facts, "observedAt")
                    : java.time.Instant.now().toString();
        }

        boolean statusChanged = !java.util.Objects.equals(status, prevStatus);
        boolean valuesChanged = !branch.equals(prevBranch)
                || !head.equals(prevHead)
                || isRepository != prevIsRepo
                || !java.util.Objects.equals(cwd, prevCwd)
                || !java.util.Objects.equals(platform, prevPlatform)
                || !java.util.Objects.equals(shell, prevShell);
        if (!statusChanged && !valuesChanged) {
            return; // double rule 1: value-set + status identical → no event.
        }

        ObjectNode payload = objectMapper.createObjectNode();
        // Legacy keys (readers predating PLAN-0382).
        payload.put("branch", branch);
        payload.put("head", head);
        payload.put("is_repository", isRepository);
        // PLAN-0382 keys (additive).
        payload.put("env_status", status);
        putNullable(payload, "env_cwd", cwd);
        putNullable(payload, "env_platform", platform);
        putNullable(payload, "env_shell", shell);
        putNullable(payload, "env_observed_at", observedAt);
        contextService.appendEvent(sessionId, workspaceId, userId, "context.env_updated",
                objectMapper.convertValue(payload, Map.class));
    }

    private static String factText(Map<String, Object> facts, String key) {
        Object value = facts.get(key);
        return value == null ? "" : String.valueOf(value);
    }

    private static String factTextOrNull(Map<String, Object> facts, String key) {
        Object value = facts.get(key);
        return value == null ? null : String.valueOf(value);
    }

    private static String epochPath(ObjectNode epoch, String field) {
        return epoch == null ? "" : epoch.path(field).asText("");
    }

    private static String epochPathOrNull(ObjectNode epoch, String field) {
        if (epoch == null || !epoch.has(field) || epoch.get(field).isNull()) {
            return null;
        }
        return epoch.get(field).asText(null);
    }

    private static void putNullable(ObjectNode payload, String field, String value) {
        if (value == null) {
            payload.putNull(field);
        } else {
            payload.put(field, value);
        }
    }

    /** Legacy projection read: l1_status of the projected epoch, or null when absent. */
    private String projectedL1Status(String sessionId) {
        ObjectNode context = projectionService.project(sessionId, 0L);
        ObjectNode epoch = (ObjectNode) context.get("epoch");
        if (epoch == null || !epoch.hasNonNull("l1_status")) {
            return null;
        }
        String status = epoch.get("l1_status").asText();
        return status.isBlank() ? null : status;
    }

    private void upsertWorkspaceHash(String workspaceId, String hash, ContextSourceHash existing) {
        ContextSourceHash row = existing != null ? existing : new ContextSourceHash(workspaceId, SOURCE_KEY, hash);
        row.setHash(hash);
        sourceHashRepository.save(row);
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
