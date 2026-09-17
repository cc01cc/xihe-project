package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

@Service
public class ContextService {

    private static final Logger logger = LoggerFactory.getLogger(ContextService.class);

    private final EventStoreService eventStoreService;
    private final ContextProjectionService projectionService;
    private final ObjectMapper objectMapper;
    private final com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository approvalRepository;

    public ContextService(EventStoreService eventStoreService,
                          ContextProjectionService projectionService,
                          ObjectMapper objectMapper,
                          com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository approvalRepository) {
        this.eventStoreService = eventStoreService;
        this.objectMapper = objectMapper;
        this.projectionService = projectionService;
        this.approvalRepository = approvalRepository;
    }

    @Transactional
    public ContextEvent appendEvent(String sessionId, String workspaceId, String userId,
                                    String eventType, Object payload) {
        return eventStoreService.append(sessionId, workspaceId, userId, eventType, payload);
    }

    @Transactional
    public List<ContextEvent> appendBatch(String sessionId, String workspaceId, String userId,
                                          List<EventStoreService.EventPayload> payloads) {
        return eventStoreService.appendBatch(sessionId, workspaceId, userId, payloads);
    }

    @Transactional(readOnly = true)
    public ObjectNode getSnapshot(String sessionId, String workspaceId, String userId, Long afterSequence) {
        long effectiveAfter = afterSequence != null ? afterSequence : 0L;
        return projectionService.projectAndSave(sessionId, workspaceId, userId, effectiveAfter);
    }

    @Transactional(readOnly = true)
    public List<ContextEvent> readEvents(String sessionId, Long afterSequence) {
        return eventStoreService.read(sessionId, afterSequence);
    }

    @Transactional(readOnly = true)
    public Map<String, Object> replay(String sessionId, String workspaceId, String userId, Long afterSequence) {
        long effectiveAfter = afterSequence != null ? afterSequence : 0L;
        ObjectNode snapshot = projectionService.projectAndSave(sessionId, workspaceId, userId, effectiveAfter);
        List<ContextEvent> events = eventStoreService.read(sessionId, effectiveAfter);
        return Map.of("snapshot", snapshot, "events", events);
    }

    @Transactional(readOnly = true)
    public Long getLatestSequence(String sessionId) {
        return eventStoreService.getLatestSequence(sessionId);
    }

    @Transactional
    public Long fork(String sourceSessionId, Long atSequence, String newSessionId,
                     String workspaceId, String userId) {
        Long latestSequence = eventStoreService.fork(
                sourceSessionId, atSequence, newSessionId, workspaceId, userId);
        eventStoreService.append(newSessionId, workspaceId, userId, "session.forked", Map.of(
                "source_session_id", sourceSessionId,
                "at_sequence", atSequence
        ));
        return eventStoreService.getLatestSequence(newSessionId);
    }

    // PLAN-294 decision #7 (M2): messages inside the recent window are kept
    // verbatim in the projection and excluded from summarization.
    static final int KEEP_RECENT_MESSAGES = 10;

    @Transactional
    public ContextEvent compact(String sessionId, String workspaceId, String userId, Long upToSequence) {
        return compact(sessionId, workspaceId, userId, upToSequence, "auto");
    }

    /**
     * PLAN-0341 T1.1 (decision #3): overflow-forced compaction. Bypasses the
     * auto-compact cooldown gate and tags the event with trigger=overflow so
     * the next shouldAutoCompact call clears the cooldown window (冷却门清零).
     */
    @Transactional
    public ContextEvent compactForOverflow(String sessionId, String workspaceId, String userId) {
        logger.info("[LIFECYCLE] service=cp event=context_overflow_compaction sessionId={}", sessionId);
        // Overflow bypasses the recovery-band circuit (I4) and the cooldown gate.
        // Shrink failure still records the attempt; preflight decides the retry.
        return compact(sessionId, workspaceId, userId, null, "overflow");
    }

    @Transactional
    public ContextEvent compact(String sessionId, String workspaceId, String userId, Long upToSequence,
                                String trigger) {
        long latestSequence = eventStoreService.getLatestSequence(sessionId);
        long effectiveUpTo = upToSequence != null ? Math.min(upToSequence, latestSequence) : latestSequence;

        // PLAN-294 decision #16 (appendix D.3): resume from the previous
        // compaction cursor instead of re-summarizing from sequence 0 — the
        // prior summary is merged with the increment, never recomputed.
        com.fasterxml.jackson.databind.JsonNode previous = latestCompaction(sessionId);
        long previousCursor = previous != null && previous.has("up_to_sequence")
                ? previous.get("up_to_sequence").asLong() : 0L;
        String previousSummary = previous != null && previous.has("summary")
                ? previous.get("summary").asText() : null;

        ObjectNode context = projectionService.projectUpTo(sessionId, effectiveUpTo);
        String summary = summarizeMessages(sessionId, context, previousSummary, previousCursor);

        // PLAN-0341 T1.3 shrink validation (I2): a summary that does not shrink
        // its source is abandoned — never write back a bloated summary.
        // Degradation: truncation-only summary (keep-recent, no prior carry).
        if (!passesShrinkValidation(context, previousSummary, summary)) {
            logger.warn("[LIFECYCLE] service=cp event=compaction_shrink_failed sessionId={} trigger={} summaryChars={} priorChars={}",
                    sessionId, trigger, summary.length(),
                    previousSummary == null ? 0 : previousSummary.length());
            recordIneffectiveCompaction(sessionId, workspaceId, userId);
            summary = buildTruncationOnlySummary(context);
        }

        // Compute summary hash for integrity verification
        String summaryHash = computeSha256(summary);

        // Determine context epoch (new epoch after compaction)
        String newEpochId = java.util.UUID.randomUUID().toString();

        // Keep task plan items that are not completed (resume-friendly)
        java.util.List<String> keptItemIds = new java.util.ArrayList<>();
        com.fasterxml.jackson.databind.JsonNode taskPlan = context.get("metadata").get("task_plan");
        if (taskPlan != null && taskPlan.has("items")) {
            for (com.fasterxml.jackson.databind.JsonNode item : taskPlan.get("items")) {
                String status = item.has("status") ? item.get("status").asText() : "pending";
                if (!"completed".equals(status) && item.has("id")) {
                    keptItemIds.add(item.get("id").asText());
                }
            }
        }

        int keptRecent = countRecentWindow(context);
        ContextEvent applied = eventStoreService.append(sessionId, workspaceId, userId, "compaction.applied", Map.of(
                "up_to_sequence", effectiveUpTo,
                "summary", summary,
                "summaryHash", summaryHash,
                "contextEpoch", newEpochId,
                "keptItemIds", keptItemIds,
                "compacted_message_count", context.get("messages").size(),
                "kept_recent_count", keptRecent,
                "trigger", trigger == null || trigger.isBlank() ? "auto" : trigger
        ));

        // PLAN-0341 T1.3 recovery band (I3): residual must fall below
        // recoveryBand × window, else pause auto compaction (event, no table).
        applyRecoveryBand(sessionId, workspaceId, userId, context, trigger);
        return applied;
    }

    /**
     * PLAN-0341 T1.3 / I2: the new summary must be strictly smaller than the
     * pre-window source it replaces (prior summary + non-recent messages).
     * First compaction (no prior) always passes — there is nothing to bloat.
     */
    private boolean passesShrinkValidation(ObjectNode context, String previousSummary, String summary) {
        if (previousSummary == null || previousSummary.isBlank()) {
            return true;
        }
        ArrayNode messages = (ArrayNode) context.get("messages");
        if (messages == null) {
            return true;
        }
        int sourceChars = previousSummary.length();
        int size = messages.size();
        int recentStart = Math.max(0, size - KEEP_RECENT_MESSAGES);
        for (int i = 0; i < recentStart; i++) {
            sourceChars += messages.get(i).path("content").asText("").length();
        }
        // Allow a small slack so near-parity (noise) is not treated as failure.
        return summary.length() < sourceChars || summary.length() <= previousSummary.length();
    }

    /** Degradation path when shrink validation fails: keep-recent only. */
    private String buildTruncationOnlySummary(ObjectNode context) {
        ArrayNode messages = (ArrayNode) context.get("messages");
        StringBuilder sb = new StringBuilder();
        sb.append(SECTION_GOAL).append(" (compacted by truncation)\n");
        sb.append(SECTION_RECENT).append(' ');
        if (messages != null) {
            int size = messages.size();
            int recentStart = Math.max(0, size - KEEP_RECENT_MESSAGES);
            List<String> recent = new ArrayList<>();
            for (int i = recentStart; i < size; i++) {
                String role = messages.get(i).path("role").asText("");
                String content = messages.get(i).path("content").asText("");
                if (content.isBlank()) continue;
                recent.add("[" + role + "] " + (content.length() > 200 ? content.substring(0, 200) : content));
            }
            for (int i = 0; i < recent.size(); i++) {
                sb.append(recent.get(i)).append(i < recent.size() - 1 ? " ; " : "");
            }
        }
        return sb.toString();
    }

    private void recordIneffectiveCompaction(String sessionId, String workspaceId, String userId) {
        // Consecutive ineffective counter is auxiliary (#23); recovery band is
        // the primary circuit. This event is the observability trail (V8).
        eventStoreService.append(sessionId, workspaceId, userId, "context.compaction_ineffective", Map.of(
                "reason", "shrink_validation_failed"
        ));
    }

    /** PLAN-0341 T1.3 I3: open the auto-compact circuit when residual stays high. */
    private void applyRecoveryBand(String sessionId, String workspaceId, String userId,
                                   ObjectNode context, String trigger) {
        long residual = estimateInputTokens(context);
        long window = resolveWindowTokens(sessionId, null);
        long bandLimit = (long) (window * SOFT_THRESHOLD_PCT * RECOVERY_BAND);
        if (residual < bandLimit) {
            return;
        }
        logger.warn("[LIFECYCLE] service=cp event=context_compaction_circuit_open sessionId={} residual={} bandLimit={} trigger={}",
                sessionId, residual, bandLimit, trigger);
        eventStoreService.append(sessionId, workspaceId, userId, "context.compaction_circuit", Map.of(
                "state", "open",
                "reason", "recovery_band",
                "residualTokens", residual,
                "bandLimit", bandLimit,
                "trigger", trigger == null ? "auto" : trigger
        ));
    }

    /**
     * PLAN-0341 T1.1 preflight (decision #2 ②): after an overflow compaction,
     * estimate the post-compaction input size. Returns false when the estimate
     * (plus safety margin) still exceeds the soft threshold — the retry would
     * almost certainly overflow again, so fail fast instead of burning a call.
     *
     * @param configuredMaxInputTokens optional model window from context-policy
     *                                 (T1.6); when null, falls back to the last
     *                                 usage-reported window, then a conservative default
     */
    public boolean preflightRetryAfterOverflow(String sessionId, Long configuredMaxInputTokens) {
        ObjectNode context = projectionService.projectUpTo(
                sessionId, eventStoreService.getLatestSequence(sessionId));
        if (context == null) {
            return false;
        }
        long estimate = estimateInputTokens(context);
        long threshold = resolveWindowTokens(sessionId, configuredMaxInputTokens);
        // Safety margin 10%: rule-based summarization has no LLM guarantee.
        long limit = (long) (threshold * SOFT_THRESHOLD_PCT * 1.10);
        boolean canRetry = estimate < limit;
        logger.info("[LIFECYCLE] service=cp event=context_overflow_preflight sessionId={} estimate={} threshold={} limit={} canRetry={}",
                sessionId, estimate, threshold, limit, canRetry);
        return canRetry;
    }

    /** Rough chars/4 estimate over messages + SUM + L1. Refined by T1.6 tokenizer path. */
    private long estimateInputTokens(ObjectNode context) {
        int chars = 0;
        com.fasterxml.jackson.databind.JsonNode messages = context.get("messages");
        if (messages != null && messages.isArray()) {
            for (com.fasterxml.jackson.databind.JsonNode msg : messages) {
                chars += msg.path("content").asText("").length();
            }
        }
        com.fasterxml.jackson.databind.JsonNode epoch = context.get("epoch");
        if (epoch != null) {
            com.fasterxml.jackson.databind.JsonNode sysMsgs = epoch.get("system_messages");
            if (sysMsgs != null && sysMsgs.isArray()) {
                for (com.fasterxml.jackson.databind.JsonNode s : sysMsgs) {
                    chars += s.asText("").length();
                }
            }
            chars += epoch.path("l1_rendered").asText("").length();
        }
        return Math.max(1, chars / 4);
    }

    /**
     * Window resolution priority (T1.6): configured maxInputTokens → last
     * usage-reported windowTokens → conservative code default.
     */
    private long resolveWindowTokens(String sessionId, Long configuredMaxInputTokens) {
        if (configuredMaxInputTokens != null && configuredMaxInputTokens > 0) {
            return configuredMaxInputTokens;
        }
        com.fasterxml.jackson.databind.JsonNode usage = latestUsage(sessionId);
        if (usage != null) {
            long window = usage.path("usage").path("windowTokens").asLong(
                    usage.path("windowTokens").asLong(0));
            if (window > 0) {
                return window;
            }
        }
        // Last resort only (no config, no usage). Conservative: underestimates
        // large-window models so compaction fires earlier rather than overflowing.
        return 128_000L;
    }

    /** Latest compaction.applied event payload for the session, or null. */
    private com.fasterxml.jackson.databind.JsonNode latestCompaction(String sessionId) {
        List<com.cc01cc.p.xihe.cp.context.entity.ContextEvent> events = eventStoreService.read(sessionId, 0L);
        for (int i = events.size() - 1; i >= 0; i--) {
            com.cc01cc.p.xihe.cp.context.entity.ContextEvent e = events.get(i);
            if ("compaction.applied".equals(e.getEventType())) {
                try {
                    return objectMapper.readTree(e.getPayload());
                } catch (Exception ex) {
                    logger.warn("[LIFECYCLE] service=cp event=compaction_payload_parse_failed sessionId={}", sessionId);
                    return null;
                }
            }
        }
        return null;
    }

    /** Messages inside the keep-recent window (mirrors the projection tail). */
    private int countRecentWindow(ObjectNode context) {
        com.fasterxml.jackson.databind.JsonNode messages = context.get("messages");
        if (messages == null || !messages.isArray()) return 0;
        return Math.min(KEEP_RECENT_MESSAGES, messages.size());
    }

    // PLAN-294 decisions #5/#11/#18 (M3): the pre-run compaction gate.
    // Soft threshold (default 70% of the model window) triggers a从容 compaction
    // before the run; hysteresis parameters (appendix G / E.5) keep a full
    // session from oscillating between compress and grow every turn.
    static final double SOFT_THRESHOLD_PCT = 0.70;
    static final int MIN_MESSAGES_TO_COMPACTION = 12;
    static final int COMPACTION_COOLDOWN_EVENTS = 10;
    static final int MAX_CONSECUTIVE_INEFFECTIVE = 3;
    /** PLAN-0341 T1.3 (Q1 freeze): recovery band — residual must fall below this
     *  fraction of the window after compaction, else auto-compact is paused. */
    static final double RECOVERY_BAND = 0.8;
    /** Significant growth (× soft threshold) that closes an open circuit. */
    static final double CIRCUIT_RECOVERY_GROWTH = 1.0;

    /** Latest llm_usage payload for the session's runs, or null. */
    public com.fasterxml.jackson.databind.JsonNode latestUsage(String sessionId) {
        List<com.cc01cc.p.xihe.cp.context.entity.ContextEvent> events = eventStoreService.read(sessionId, 0L);
        for (int i = events.size() - 1; i >= 0; i--) {
            com.cc01cc.p.xihe.cp.context.entity.ContextEvent e = events.get(i);
            // The relay bridges the agent's usage SSE event into the context
            // event store as llm.usage (mirrored from the operation extension)
            // so compaction gating stays single-source (context_events).
            if ("llm.usage".equals(e.getEventType())) {
                try {
                    return objectMapper.readTree(e.getPayload());
                } catch (Exception ex) {
                    logger.warn("[LIFECYCLE] service=cp event=usage_event_parse_failed sessionId={}", sessionId);
                    return null;
                }
            }
        }
        return null;
    }

    public boolean shouldAutoCompact(String sessionId) {
        // projectUpTo (inclusive of the latest event) — the historical
        // shouldAutoCompact passed latestSeq into project(afterSequence),
        // whose exclusive-lower-bound semantics made the projection EMPTY
        // (the dead-code bug that stayed hidden while nothing called it).
        ObjectNode context = projectionService.projectUpTo(
                sessionId, eventStoreService.getLatestSequence(sessionId));
        if (context == null) return false;

        // PLAN-0341 T1.3: recovery-band circuit. Open circuit pauses AUTO
        // compaction only; overflow force-compact bypasses this gate entirely.
        // Recovery criterion (#53): significant growth past the soft threshold.
        if (isCompactionCircuitOpen(sessionId)) {
            if (hasSignificantGrowth(sessionId, context)) {
                closeCompactionCircuit(sessionId, context);
                logger.info("[LIFECYCLE] service=cp event=context_compaction_circuit_closed sessionId={}", sessionId);
            } else {
                return false;
            }
        }

        // Hysteresis ①: cooldown — a compaction must be followed by at least
        // COMPACTION_COOLDOWN_EVENTS new events before the next one.
        // PLAN-0341 decision #3: overflow-triggered compaction clears the
        // cooldown gate so the next normal turn can still auto-compact.
        com.fasterxml.jackson.databind.JsonNode previous = latestCompaction(sessionId);
        if (previous != null && previous.has("up_to_sequence")) {
            String previousTrigger = previous.path("trigger").asText("auto");
            if (!"overflow".equals(previousTrigger)) {
                long latestSeq = eventStoreService.getLatestSequence(sessionId);
                if (latestSeq - previous.get("up_to_sequence").asLong() < COMPACTION_COOLDOWN_EVENTS) {
                    return false;
                }
            }
        }

        com.fasterxml.jackson.databind.JsonNode messages = context.get("messages");
        int messageCount = messages != null && messages.isArray() ? messages.size() : 0;

        // Primary signal: the provider/estimated token count of the last run
        // (decision #5 ②③; real when available, estimated otherwise). The
        // window size comes from the compaction contextPolicy when present.
        com.fasterxml.jackson.databind.JsonNode usage = latestUsage(sessionId);
        if (usage != null) {
            long inputTokens = usage.path("usage").path("inputTokens").asLong(
                    usage.path("inputTokens").asLong(0));
            long window = usage.path("usage").path("windowTokens").asLong(
                    usage.path("windowTokens").asLong(0));
            if (inputTokens > 0 && window > 0 && inputTokens >= (long) (window * SOFT_THRESHOLD_PCT)) {
                return true;
            }
        }

        // Fallback signals (decision #5 ④): no usable token data — message
        // count and tool-call volume thresholds remain the deterministic
        // backstop. They also gate the token signal below a minimum volume so
        // a single giant paste cannot thrash the gate.
        if (messageCount >= MIN_MESSAGES_TO_COMPACTION && messageCount > 50) return true;

        com.fasterxml.jackson.databind.JsonNode meta = context.get("metadata");
        if (meta != null && meta.has("token_count") && meta.get("token_count").asInt(0) > 100000) return true;

        if (meta != null && meta.has("tool_calls")) {
            com.fasterxml.jackson.databind.JsonNode toolCalls = meta.get("tool_calls");
            if (toolCalls.isArray() && toolCalls.size() > 20) return true;
        }

        return false;
    }

    /** Latest non-closed compaction circuit event, or null. */
    private com.fasterxml.jackson.databind.JsonNode latestOpenCircuit(String sessionId) {
        List<ContextEvent> events = eventStoreService.read(sessionId, 0L);
        for (int i = events.size() - 1; i >= 0; i--) {
            ContextEvent e = events.get(i);
            if ("context.compaction_circuit".equals(e.getEventType())) {
                try {
                    var payload = objectMapper.readTree(e.getPayload());
                    if ("open".equals(payload.path("state").asText())) {
                        return payload;
                    }
                    return null;
                } catch (Exception ex) {
                    logger.warn("[LIFECYCLE] service=cp event=circuit_payload_parse_failed sessionId={}", sessionId);
                    return null;
                }
            }
        }
        return null;
    }

    private boolean isCompactionCircuitOpen(String sessionId) {
        return latestOpenCircuit(sessionId) != null;
    }

    /** PLAN-0341 T1.3 recovery criterion (#53): growth past the residual
     *  recorded when the circuit opened — not merely re-crossing soft. */
    private boolean hasSignificantGrowth(String sessionId, ObjectNode context) {
        var open = latestOpenCircuit(sessionId);
        if (open == null) {
            return false;
        }
        long residualAtOpen = open.path("residualTokens").asLong(0);
        long current = estimateInputTokens(context);
        // Significant = current estimate grew meaningfully past the failed residual.
        return residualAtOpen > 0 && current >= (long) (residualAtOpen * 1.15);
    }

    private void closeCompactionCircuit(String sessionId, ObjectNode context) {
        eventStoreService.append(sessionId,
                context.path("workspace_id").asText(""),
                context.path("user_id").asText(""),
                "context.compaction_circuit", Map.of(
                        "state", "closed",
                        "reason", "significant_growth"
                ));
    }

    private String computeSha256(String data) {
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(data.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : hash) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            return "hash_error";
        }
    }

    // PLAN-294 decision #3 / appendix E.3 + PLAN-0341 T1.3: structured sectioned
    // summary with carry-forward. Prior sections are parsed and explicitly
    // re-emitted (not blob-appended); same-section items are deduped; completed
    // task items are archived out of Active.
    private static final int GOAL_MAX_CHARS = 500;
    private static final int ERRORS_KEPT = 3;
    private static final int NEXT_MOVE_MAX_CHARS = 300;

    private static final String SECTION_GOAL = "[Goal]";
    private static final String SECTION_WORK = "[Work State]";
    private static final String SECTION_NEXT = "[Next Move]";
    private static final String SECTION_FILES = "[Files&Artifacts]";
    private static final String SECTION_ERRORS = "[Errors]";
    private static final String SECTION_RECENT = "[Recent]";
    private static final String SECTION_CONSTRAINTS = "[Constraints]";

    private String summarizeMessages(String sessionId, ObjectNode context, String previousSummary, long previousCursor) {
        ArrayNode messages = (ArrayNode) context.get("messages");
        if (messages == null || messages.isEmpty()) {
            return previousSummary != null ? previousSummary : "No messages to compact.";
        }

        // Parse prior summary into sections (carry-forward source).
        Map<String, String> prior = parseSummarySections(previousSummary);

        StringBuilder goal = new StringBuilder();
        java.util.Set<String> files = new java.util.LinkedHashSet<>();
        List<String> errors = new ArrayList<>();
        List<String> recent = new ArrayList<>();
        List<String> active = new ArrayList<>();
        List<String> completed = new ArrayList<>();
        StringBuilder nextMove = new StringBuilder();

        int size = messages.size();
        int recentStart = Math.max(0, size - KEEP_RECENT_MESSAGES);
        for (int i = 0; i < size; i++) {
            JsonNode msg = messages.get(i);
            String role = msg.path("role").asText("");
            String content = msg.path("content").asText("");
            if (content.isBlank()) continue;

            if ("human".equals(role) && goal.length() == 0) {
                goal.append(content, 0, Math.min(content.length(), GOAL_MAX_CHARS));
            }
            // File-path extraction (verbatim): workspace-relative POSIX paths.
            java.util.regex.Matcher m = FILE_PATH_PATTERN.matcher(content);
            while (m.find()) {
                files.add(m.group());
            }
            if (content.contains("error") || content.contains("Error") || content.contains("ERROR")) {
                errors.add(content.length() > 300 ? content.substring(0, 300) : content);
            }
            if (i >= recentStart) {
                recent.add("[" + role + "] " + (content.length() > 200 ? content.substring(0, 200) : content));
            }
            // Lightweight work-state signals from task_plan metadata below.
        }

        // Task-plan driven Work State (Completed archived out of Active).
        JsonNode taskPlan = context.path("metadata").path("task_plan");
        if (taskPlan.has("items")) {
            for (JsonNode item : taskPlan.get("items")) {
                String title = item.path("title").asText(item.path("id").asText(""));
                String status = item.path("status").asText("pending");
                if (title.isBlank()) continue;
                if ("completed".equals(status)) {
                    completed.add(title);
                } else {
                    active.add(title + " (" + status + ")");
                }
            }
        }
        if (nextMove.length() == 0 && !active.isEmpty()) {
            nextMove.append(active.get(0), 0, Math.min(active.get(0).length(), NEXT_MOVE_MAX_CHARS));
        } else if (nextMove.length() == 0) {
            String priorNext = prior.get(SECTION_NEXT);
            if (priorNext != null && !priorNext.isBlank()) {
                nextMove.append(priorNext, 0, Math.min(priorNext.length(), NEXT_MOVE_MAX_CHARS));
            }
        }

        // Carry-forward: union prior files/errors with dedup.
        String priorFiles = prior.get(SECTION_FILES);
        if (priorFiles != null && !priorFiles.isBlank()) {
            for (String f : priorFiles.split(",")) {
                String trimmed = f.trim();
                if (!trimmed.isEmpty()) {
                    files.add(trimmed);
                }
            }
        }
        String priorErrors = prior.get(SECTION_ERRORS);
        if (priorErrors != null && !priorErrors.isBlank()) {
            for (String err : priorErrors.split("\\|")) {
                String trimmed = err.trim();
                if (!trimmed.isEmpty() && !errors.contains(trimmed)) {
                    errors.add(0, trimmed);
                }
            }
        }
        String priorActive = prior.get(SECTION_WORK);
        if (priorActive != null && !active.isEmpty()) {
            // Prior Active items that are not in the current plan stay carried.
            for (String line : priorActive.split(";")) {
                String trimmed = line.trim();
                if (trimmed.isEmpty() || trimmed.startsWith("Completed:")) {
                    continue;
                }
                boolean already = active.stream().anyMatch(a -> trimmed.contains(a) || a.contains(trimmed));
                if (!already && !trimmed.startsWith("(")) {
                    active.add(trimmed);
                }
            }
        }

        StringBuilder sb = new StringBuilder();
        // Goal: keep prior if present (first human is often just "hi"), else extract.
        String priorGoal = prior.get(SECTION_GOAL);
        if (priorGoal != null && !priorGoal.isBlank() && !"(not stated)".equals(priorGoal)) {
            sb.append(SECTION_GOAL).append(' ').append(priorGoal).append('\n');
        } else {
            sb.append(SECTION_GOAL).append(' ').append(goal.length() > 0 ? goal : "(not stated)").append('\n');
        }
        if (!active.isEmpty() || !completed.isEmpty()) {
            sb.append(SECTION_WORK).append(' ');
            if (!active.isEmpty()) {
                sb.append("Active: ").append(String.join("; ", active));
            }
            if (!completed.isEmpty()) {
                if (!active.isEmpty()) sb.append(" | ");
                sb.append("Completed: ").append(String.join("; ", completed));
            }
            sb.append('\n');
        } else if (prior.containsKey(SECTION_WORK) && !prior.get(SECTION_WORK).isBlank()) {
            sb.append(SECTION_WORK).append(' ').append(prior.get(SECTION_WORK)).append('\n');
        }
        if (nextMove.length() > 0) {
            sb.append(SECTION_NEXT).append(' ').append(nextMove).append('\n');
        }
        // PLAN-0341 T1.5 (I6): code-extracted constraints — verbatim, never
        // summarized away. Prior Constraints are carried forward; new ones from
        // this window and decided approvals are merged with dedup.
        List<String> constraints = extractConstraints(sessionId, messages, prior.get(SECTION_CONSTRAINTS));
        if (!constraints.isEmpty()) {
            sb.append(SECTION_CONSTRAINTS).append(' ').append(String.join(" | ", constraints)).append('\n');
        }
        if (!files.isEmpty()) {
            sb.append(SECTION_FILES).append(' ').append(String.join(", ", files)).append('\n');
        }
        if (!errors.isEmpty()) {
            sb.append(SECTION_ERRORS).append(' ');
            int from = Math.max(0, errors.size() - ERRORS_KEPT);
            for (int i = from; i < errors.size(); i++) {
                sb.append(errors.get(i)).append(i < errors.size() - 1 ? " | " : "");
            }
            sb.append('\n');
        }
        sb.append(SECTION_RECENT).append(' ');
        for (int i = 0; i < recent.size(); i++) {
            sb.append(recent.get(i)).append(i < recent.size() - 1 ? " ; " : "");
        }
        return sb.toString();
    }

    /** Parse a sectioned summary into a map of section header → body. */
    private Map<String, String> parseSummarySections(String summary) {
        Map<String, String> sections = new java.util.LinkedHashMap<>();
        if (summary == null || summary.isBlank()) {
            return sections;
        }
        String[] lines = summary.split("\n");
        String current = null;
        StringBuilder body = new StringBuilder();
        for (String line : lines) {
            if (line.startsWith("[") && line.contains("]")) {
                if (current != null) {
                    sections.put(current, body.toString().trim());
                }
                int end = line.indexOf(']');
                current = line.substring(0, end + 1);
                body = new StringBuilder();
                String rest = line.substring(end + 1).trim();
                if (!rest.isEmpty()) {
                    body.append(rest);
                }
            } else if (current != null) {
                if (body.length() > 0) body.append(' ');
                body.append(line.trim());
            }
        }
        if (current != null) {
            sections.put(current, body.toString().trim());
        }
        return sections;
    }

    // PLAN-0341 T1.5 (decision #31): rule-based SC subset. Approval decisions
    // and user explicit constraints are code-extracted and kept verbatim in
    // [Constraints]; they never participate in the summarizer's take-data.
    private static final int CONSTRAINTS_MAX = 12;
    private static final int CONSTRAINT_MAX_CHARS = 240;
    private static final java.util.regex.Pattern CONSTRAINT_PATTERN = java.util.regex.Pattern.compile(
            "(?:不要动|不要改|不要提交|禁止|必须先|务必先|不要删除|别动|别改|"
                    + "do not|don't|never|must always|must not|forbid|stop)\\b[^.\\n。！!？?]{0,120}",
            java.util.regex.Pattern.CASE_INSENSITIVE);

    private List<String> extractConstraints(String sessionId, ArrayNode messages, String priorConstraints) {
        java.util.LinkedHashSet<String> out = new java.util.LinkedHashSet<>();
        if (priorConstraints != null && !priorConstraints.isBlank()) {
            for (String part : priorConstraints.split("\\|")) {
                String trimmed = part.trim();
                if (!trimmed.isEmpty()) {
                    out.add(trimmed);
                }
            }
        }
        // ① User explicit constraints from human messages (verbatim match span).
        if (messages != null) {
            for (var msg : messages) {
                if (!"human".equals(msg.path("role").asText(""))) {
                    continue;
                }
                String content = msg.path("content").asText("");
                if (content.isBlank()) {
                    continue;
                }
                var matcher = CONSTRAINT_PATTERN.matcher(content);
                while (matcher.find() && out.size() < CONSTRAINTS_MAX) {
                    String span = matcher.group().trim();
                    if (span.length() > CONSTRAINT_MAX_CHARS) {
                        span = span.substring(0, CONSTRAINT_MAX_CHARS);
                    }
                    out.add(span);
                }
            }
        }
        // ② Decided approvals (verbatim tool/action + decision).
        try {
            var decided = approvalRepository.findBySessionIdAndStateInOrderByCreatedAtDesc(
                    sessionId, List.of("approved", "rejected", "expired"));
            for (var approval : decided) {
                if (out.size() >= CONSTRAINTS_MAX) {
                    break;
                }
                String decision = Boolean.TRUE.equals(approval.getApproved()) ? "approved"
                        : Boolean.FALSE.equals(approval.getApproved()) ? "denied"
                        : approval.getState();
                String line = "[" + decision + "] " + approval.getTool() + ": "
                        + truncate(approval.getAction(), 120);
                out.add(line);
            }
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=constraint_approval_extract_failed sessionId={} error={}",
                    sessionId, e.getMessage());
        }
        return new ArrayList<>(out);
    }

    private static String truncate(String s, int max) {
        if (s == null) {
            return "";
        }
        return s.length() <= max ? s : s.substring(0, max);
    }

    private static final java.util.regex.Pattern FILE_PATH_PATTERN = java.util.regex.Pattern.compile(
            "[A-Za-z0-9_\\-./]+\\.[A-Za-z0-9]{1,8}");
}
