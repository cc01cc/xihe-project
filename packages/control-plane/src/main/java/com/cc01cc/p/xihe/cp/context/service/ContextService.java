package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.cc01cc.p.xihe.cp.context.summary.ConstraintExtractor;
import com.cc01cc.p.xihe.cp.context.summary.SummaryProvider;
import com.cc01cc.p.xihe.cp.context.summary.SummarySections;
import com.cc01cc.p.xihe.cp.usage.UsageCostMapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public class ContextService {

    private static final Logger logger = LoggerFactory.getLogger(ContextService.class);

    private final EventStoreService eventStoreService;
    private final ContextProjectionService projectionService;
    private final ObjectMapper objectMapper;
    private final com.cc01cc.p.xihe.cp.chat.SseEmitterManager sseManager;
    private final SummaryProvider summaryProvider;
    private final UsageCostMapper usageCostMapper;
    private final ConstraintExtractor constraintExtractor;
    private final com.cc01cc.p.xihe.cp.service.BranchPathService branchPathService;

    public ContextService(EventStoreService eventStoreService,
                          ContextProjectionService projectionService,
                          ObjectMapper objectMapper,
                          com.cc01cc.p.xihe.cp.chat.SseEmitterManager sseManager,
                          SummaryProvider summaryProvider,
                          UsageCostMapper usageCostMapper,
                          ConstraintExtractor constraintExtractor,
                          com.cc01cc.p.xihe.cp.service.BranchPathService branchPathService) {
        this.eventStoreService = eventStoreService;
        this.objectMapper = objectMapper;
        this.projectionService = projectionService;
        this.sseManager = sseManager;
        this.summaryProvider = summaryProvider;
        this.usageCostMapper = usageCostMapper;
        this.constraintExtractor = constraintExtractor;
        this.branchPathService = branchPathService;
    }

    /**
     * PLAN-0410 T2.2/T2.3: one resolved branch scope shared by every
     * compaction / usage / circuit read and write of a call.
     *
     * <p>Selector precedence: an explicit CP-validated {@code branchId}
     * (409 {@code BRANCH_RUN_MISMATCH} when it disagrees with {@code runId});
     * else the durable branch derived from {@code runId} (fail-closed on
     * unknown/cross-Session runs); else the Session root (legacy entry points
     * without any selector — bootstrap, not a fallback for a FAILED lookup).
     */
    private String resolveScopeBranch(String sessionId, String runId, String branchId) {
        boolean explicit = branchId != null && !branchId.isBlank();
        boolean hasRun = runId != null && !runId.isBlank();
        if (hasRun) {
            String derived = branchPathService.deriveBranchForRun(sessionId, runId);
            if (explicit && !derived.equals(branchId)) {
                throw new com.cc01cc.p.xihe.cp.config.CpApiException(
                        org.springframework.http.HttpStatus.CONFLICT, "BRANCH_RUN_MISMATCH",
                        "runId resolves to a different branch than the requested branchId");
            }
            return derived;
        }
        if (explicit) {
            // Fail-closed validation of a caller-supplied branch (404 codes).
            branchPathService.resolveVisibility(sessionId, branchId);
            return branchId;
        }
        return branchPathService.ensureRootBranchId(sessionId);
    }

    /** PLAN-0410 T2.2: resolved branch scope carried through one compaction/gate call. */
    private record BranchScope(String branchId, String runId,
                               com.cc01cc.p.xihe.cp.service.BranchPathService.BranchVisibility visibility) {
    }

    private BranchScope resolveScope(String sessionId, String runId, String branchId) {
        String scopeBranch = resolveScopeBranch(sessionId, runId, branchId);
        return new BranchScope(scopeBranch, runId, branchPathService.resolveVisibility(sessionId, scopeBranch));
    }

    @Transactional
    public ContextEvent appendEvent(String sessionId, String workspaceId, String userId,
                                    String eventType, Object payload) {
        return appendEvent(sessionId, workspaceId, userId, eventType, payload, null);
    }

    /** PLAN-0410 T1.4: pass-through for the internal {@code correlation_id}. */
    @Transactional
    public ContextEvent appendEvent(String sessionId, String workspaceId, String userId,
                                    String eventType, Object payload, String correlationId) {
        return eventStoreService.append(sessionId, workspaceId, userId, eventType, payload, correlationId);
    }

    @Transactional
    public List<ContextEvent> appendBatch(String sessionId, String workspaceId, String userId,
                                          List<EventStoreService.EventPayload> payloads) {
        return eventStoreService.appendBatch(sessionId, workspaceId, userId, payloads);
    }

    // PLAN-0410 T2.1: snapshot/replay upsert the durable projection cache row
    // (per-branch key), so their transaction is write-capable — the former
    // readOnly hint could silently skip the INSERT on PostgreSQL.
    @Transactional
    public ObjectNode getSnapshot(String sessionId, String workspaceId, String userId, Long afterSequence) {
        return getSnapshot(sessionId, workspaceId, userId, afterSequence, null, null);
    }

    /**
     * PLAN-0410 T2.3: internal snapshot with a CP-validated branch selector.
     * {@code branchId} and {@code runId} may both be supplied and must then
     * agree; invalid/foreign selectors fail closed (404/409) instead of
     * silently falling back to the Session root.
     */
    @Transactional
    public ObjectNode getSnapshot(String sessionId, String workspaceId, String userId, Long afterSequence,
                                  String branchId, String runId) {
        long effectiveAfter = afterSequence != null ? afterSequence : 0L;
        String scopeBranch = resolveScopeBranch(sessionId, runId, branchId);
        return projectionService.projectAndSave(sessionId, workspaceId, userId, effectiveAfter, scopeBranch);
    }

    @Transactional(readOnly = true)
    public List<ContextEvent> readEvents(String sessionId, Long afterSequence) {
        return eventStoreService.read(sessionId, afterSequence);
    }

    @Transactional
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

    // PLAN-0354 spec §7: compaction is intentionally NOT @Transactional — the
    // summary hop may spend up to summaryTimeoutMs (60s max) on an external
    // HTTP call, which must never hold a DB transaction/connection (0346 lock
    // timeout is 5s). Projection reads and event appends keep their own short
    // transactions inside the collaborators.
    public ContextEvent compact(String sessionId, String workspaceId, String userId, Long upToSequence) {
        return compact(sessionId, workspaceId, userId, upToSequence, "auto", null);
    }

    public ContextEvent compact(String sessionId, String workspaceId, String userId, Long upToSequence,
                                String trigger) {
        return compact(sessionId, workspaceId, userId, upToSequence, trigger, null);
    }

    /**
     * PLAN-0341 T1.1 (decision #3): overflow-forced compaction. Bypasses the
     * auto-compact cooldown gate and tags the event with trigger=overflow so
     * the next shouldAutoCompact call clears the cooldown window (冷却门清零).
     */
    public ContextEvent compactForOverflow(String sessionId, String workspaceId, String userId) {
        return compactForOverflow(sessionId, workspaceId, userId, null);
    }

    public ContextEvent compactForOverflow(String sessionId, String workspaceId, String userId, String runId) {
        logger.info("[LIFECYCLE] service=cp event=context_overflow_compaction sessionId={}", sessionId);
        // Overflow bypasses the recovery-band circuit (I4) and the cooldown gate.
        // Shrink failure still records the attempt; preflight decides the retry.
        return compact(sessionId, workspaceId, userId, null, "overflow", runId);
    }

    public ContextEvent compact(String sessionId, String workspaceId, String userId, Long upToSequence,
                                String trigger, String runId) {
        return compact(sessionId, workspaceId, userId, upToSequence, trigger, runId, null);
    }

    /**
     * PLAN-0410 T2.2: the whole compaction flow — projection input, prior
     * summary cursor, recovery band and the events it writes — runs on ONE
     * resolved branch path (auto/overflow derive it from the triggering Run,
     * manual compaction from the CP-validated branchId of field-matrix §6).
     */
    public ContextEvent compact(String sessionId, String workspaceId, String userId, Long upToSequence,
                                String trigger, String runId, String branchId) {
        BranchScope scope = resolveScope(sessionId, runId, branchId);
        // PLAN-0410 T2.2: the cursor is clamped to this branch path's latest
        // visible sequence — sibling Run events never enter the compacted
        // prefix nor the cooldown math that reuses this cursor.
        long branchLatest = latestVisibleSequence(sessionId, scope);
        long effectiveUpTo = upToSequence != null ? Math.min(upToSequence, branchLatest) : branchLatest;
        String effectiveTrigger = trigger == null || trigger.isBlank() ? "auto" : trigger;

        // PLAN-294 decision #16 (appendix D.3): resume from the previous
        // compaction cursor instead of re-summarizing from sequence 0 — the
        // prior summary is merged with the increment, never recomputed.
        com.fasterxml.jackson.databind.JsonNode previous = latestCompaction(sessionId, scope.visibility());
        long previousCursor = previous != null && previous.has("up_to_sequence")
                ? previous.get("up_to_sequence").asLong() : 0L;
        String previousSummary = previous != null && previous.has("summary")
                ? previous.get("summary").asText() : null;

        ObjectNode context = projectionService.projectUpTo(sessionId, effectiveUpTo, scope.visibility());

        // PLAN-0354 Q4/Q5: statistical observation fields around the provider
        // hop; summary text remains in the existing `summary` field only.
        long beforeTokens = estimateInputTokens(context);
        SummaryProvider.SummaryResult result = summaryProvider.summarize(new SummaryProvider.SummaryRequest(
                sessionId, workspaceId, userId, context, previousSummary, previousCursor, effectiveTrigger, runId));
        String summary = result.summary();
        String provider = result.provider();
        String model = result.model() == null ? "" : result.model();
        long durationMs = result.durationMs();
        String source = result.source();
        String fallbackReason = result.fallbackReason();
        Map<String, Object> usage = result.usage();

        // PLAN-0341 T1.3 shrink validation (I2): a summary that does not shrink
        // its source is abandoned — never write back a bloated summary.
        // Degradation: truncation-only summary (keep-recent, no prior carry).
        // PLAN-0354 §6: the applied summary is report as provider=rule with
        // fallbackReason=shrink_failed; the LLM usage stays (cost incurred).
        if (!passesShrinkValidation(context, previousSummary, summary)) {
            logger.warn("[LIFECYCLE] service=cp event=compaction_shrink_failed sessionId={} trigger={} summaryChars={} priorChars={}",
                    sessionId, effectiveTrigger, summary.length(),
                    previousSummary == null ? 0 : previousSummary.length());
            recordIneffectiveCompaction(sessionId, workspaceId, userId, scope);
            summary = buildTruncationOnlySummary(sessionId, context, previousSummary);
            provider = "rule";
            model = "";
            fallbackReason = "shrink_failed";
        }

        long afterTokens = estimateAfterCompaction(context, summary);

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
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("up_to_sequence", effectiveUpTo);
        payload.put("summary", summary);
        payload.put("summaryHash", summaryHash);
        payload.put("contextEpoch", newEpochId);
        payload.put("keptItemIds", keptItemIds);
        payload.put("compacted_message_count", context.get("messages").size());
        payload.put("kept_recent_count", keptRecent);
        payload.put("trigger", effectiveTrigger);
        payload.put("provider", provider);
        payload.put("model", model);
        payload.put("durationMs", durationMs);
        payload.put("beforeTokens", beforeTokens);
        payload.put("afterTokens", afterTokens);
        payload.put("source", source == null ? "estimated" : source);
        if (fallbackReason != null) {
            payload.put("fallbackReason", fallbackReason);
        }
        if (usage != null) {
            // PLAN-0354 Q5-A: cost mapping happens here, inside the event that
            // carries the usage (single pricing implementation, 0343 names).
            // The pricing key is the usage model (survives a shrink_failed
            // degradation that blanks the event-level model field).
            String usageModel = usage.get("model") instanceof String s && !s.isBlank() ? s : model;
            payload.put("usage", usageCostMapper.withCost(usageModel, usage, sessionId));
        }
        // PLAN-0410 T2.3: compaction.applied is run/branch-scoped (spec §3 —
        // never a global event); correlation + derived branch ride together.
        ContextEvent applied = eventStoreService.append(
                sessionId, workspaceId, userId, "compaction.applied", payload,
                scope.runId(), scope.branchId());

        // PLAN-0341 T1.3 recovery band (I3): residual must fall below
        // recoveryBand × window, else pause auto compaction (event, no table).
        applyRecoveryBand(sessionId, workspaceId, userId, context, effectiveTrigger, scope);
        return applied;
    }

    /**
     * PLAN-0354 spec §6: post-compaction estimate = new summary + keep-recent
     * window + L1 (same chars/4 estimator as beforeTokens).
     */
    private long estimateAfterCompaction(ObjectNode context, String summary) {
        int chars = summary == null ? 0 : summary.length();
        ArrayNode messages = (ArrayNode) context.get("messages");
        if (messages != null) {
            int size = messages.size();
            int recentStart = Math.max(0, size - KEEP_RECENT_MESSAGES);
            for (int i = recentStart; i < size; i++) {
                chars += messages.get(i).path("content").asText("").length();
            }
        }
        com.fasterxml.jackson.databind.JsonNode epoch = context.get("epoch");
        if (epoch != null) {
            chars += epoch.path("l1_rendered").asText("").length();
        }
        return Math.max(1, chars / 4);
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

    /** Degradation path when shrink validation fails: keep-recent plus constraints. */
    private String buildTruncationOnlySummary(String sessionId, ObjectNode context, String previousSummary) {
        ArrayNode messages = (ArrayNode) context.get("messages");
        StringBuilder sb = new StringBuilder();
        sb.append(SummarySections.GOAL).append(" (compacted by truncation)\n");
        // PLAN-0367 decision #1 (F1): [Constraints] must survive the truncation
        // degradation (0354 I3) — same code extractor as both providers, with
        // prior constraints carried forward.
        Map<String, String> prior = SummarySections.parse(previousSummary);
        String constraints = constraintExtractor.renderSection(
                sessionId, messages, prior.get(SummarySections.CONSTRAINTS));
        if (constraints != null) {
            sb.append(constraints).append('\n');
        }
        sb.append(SummarySections.RECENT).append(' ');
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

    private void recordIneffectiveCompaction(String sessionId, String workspaceId, String userId,
                                             BranchScope scope) {
        // Consecutive ineffective counter is auxiliary (#23); recovery band is
        // the primary circuit. This event is the observability trail (V8).
        eventStoreService.append(sessionId, workspaceId, userId, "context.compaction_ineffective", Map.of(
                "reason", "shrink_validation_failed"
        ), scope.runId(), scope.branchId());
    }

    /** PLAN-0341 T1.3 I3: open the auto-compact circuit when residual stays high. */
    private void applyRecoveryBand(String sessionId, String workspaceId, String userId,
                                   ObjectNode context, String trigger, BranchScope scope) {
        long residual = estimateInputTokens(context);
        long window = resolveWindowTokens(sessionId, scope, null);
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
        ), scope.runId(), scope.branchId());
        // PLAN-0341 U4: surface the circuit to the session UI.
        try {
            sseManager.send(sessionId, "context_compaction_circuit", Map.of(
                    "type", "context_compaction_circuit",
                    "state", "open",
                    "reason", "recovery_band"));
        } catch (Exception e) {
            logger.debug("Failed to emit compaction circuit SSE: {}", e.getMessage());
        }
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
        return preflightRetryAfterOverflow(sessionId, configuredMaxInputTokens, null);
    }

    /** PLAN-0410 T2.2: preflight estimates the SAME branch path the run compacts. */
    public boolean preflightRetryAfterOverflow(String sessionId, Long configuredMaxInputTokens, String runId) {
        BranchScope scope = resolveScope(sessionId, runId, null);
        ObjectNode context = projectionService.projectUpTo(
                sessionId, eventStoreService.getLatestSequence(sessionId), scope.visibility());
        if (context == null) {
            return false;
        }
        long estimate = estimateInputTokens(context);
        long threshold = resolveWindowTokens(sessionId, scope, configuredMaxInputTokens);
        // Safety margin 10%: rule-based summarization has no LLM guarantee.
        long limit = (long) (threshold * SOFT_THRESHOLD_PCT * 1.10);
        boolean canRetry = estimate < limit;
        logger.info("[LIFECYCLE] service=cp event=context_overflow_preflight sessionId={} branchId={} estimate={} threshold={} limit={} canRetry={}",
                sessionId, scope.branchId(), estimate, threshold, limit, canRetry);
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
     * usage-reported windowTokens → conservative code default. The usage
     * lookup is branch-scoped (PLAN-0410 T2.2): a sibling Run's window never
     * sets this branch's threshold.
     */
    private long resolveWindowTokens(String sessionId, BranchScope scope, Long configuredMaxInputTokens) {
        if (configuredMaxInputTokens != null && configuredMaxInputTokens > 0) {
            return configuredMaxInputTokens;
        }
        com.fasterxml.jackson.databind.JsonNode usage = latestUsage(sessionId, scope.visibility());
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

    /**
     * Latest compaction.applied payload visible on {@code branchId}'s path
     * (PLAN-0410 T2.2: sibling summaries never feed this branch's cursor).
     */
    public com.fasterxml.jackson.databind.JsonNode latestCompaction(String sessionId, String branchId) {
        BranchScope scope = resolveScope(sessionId, null, branchId);
        return latestCompaction(sessionId, scope.visibility());
    }

    private com.fasterxml.jackson.databind.JsonNode latestCompaction(
            String sessionId, com.cc01cc.p.xihe.cp.service.BranchPathService.BranchVisibility visibility) {
        List<com.cc01cc.p.xihe.cp.context.entity.ContextEvent> events =
                eventStoreService.read(sessionId, 0L, visibility);
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

    /**
     * PLAN-0410 T2.2: max sequence visible on this branch path (0 when empty).
     * Session/global events are always visible, so this sits between the
     * global cursor and the branch's own cursor and never counts siblings.
     */
    private long latestVisibleSequence(String sessionId, BranchScope scope) {
        List<ContextEvent> events = eventStoreService.read(sessionId, 0L, scope.visibility());
        return events.isEmpty() ? 0L : events.get(events.size() - 1).getSequence();
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

    /** Latest llm_usage payload for the session's runs, or null (root path). */
    public com.fasterxml.jackson.databind.JsonNode latestUsage(String sessionId) {
        return latestUsage(sessionId, branchPathService.rootVisibility(sessionId));
    }

    /**
     * PLAN-0410 T2.2: latest llm.usage visible on {@code branchId}'s path —
     * a sibling Run's usage never drives this branch's compaction threshold.
     */
    public com.fasterxml.jackson.databind.JsonNode latestUsage(String sessionId, String branchId) {
        BranchScope scope = resolveScope(sessionId, null, branchId);
        return latestUsage(sessionId, scope.visibility());
    }

    private com.fasterxml.jackson.databind.JsonNode latestUsage(
            String sessionId, com.cc01cc.p.xihe.cp.service.BranchPathService.BranchVisibility visibility) {
        List<com.cc01cc.p.xihe.cp.context.entity.ContextEvent> events =
                eventStoreService.read(sessionId, 0L, visibility);
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
        return shouldAutoCompact(sessionId, (String) null);
    }

    /**
     * PLAN-0410 T2.2: the pre-run gate evaluates ONE branch path — cooldown
     * cursor, usage signal, circuit and projection all come from the Run's
     * branch (a null runId keeps the legacy Session-root path).
     */
    public boolean shouldAutoCompact(String sessionId, String runId) {
        BranchScope scope = resolveScope(sessionId, runId, null);
        return shouldAutoCompact(sessionId, scope);
    }

    private boolean shouldAutoCompact(String sessionId, BranchScope scope) {
        // projectUpTo (inclusive of the latest event) — the historical
        // shouldAutoCompact passed latestSeq into project(afterSequence),
        // whose exclusive-lower-bound semantics made the projection EMPTY
        // (the dead-code bug that stayed hidden while nothing called it).
        ObjectNode context = projectionService.projectUpTo(
                sessionId, eventStoreService.getLatestSequence(sessionId), scope.visibility());
        if (context == null) return false;

        // PLAN-0341 T1.3: recovery-band circuit. Open circuit pauses AUTO
        // compaction only; overflow force-compact bypasses this gate entirely.
        // Recovery criterion (#53): significant growth past the soft threshold.
        if (isCompactionCircuitOpen(sessionId, scope)) {
            if (hasSignificantGrowth(sessionId, scope, context)) {
                closeCompactionCircuit(sessionId, context, scope);
                logger.info("[LIFECYCLE] service=cp event=context_compaction_circuit_closed sessionId={} branchId={}",
                        sessionId, scope.branchId());
            } else {
                return false;
            }
        }

        // Hysteresis ①: cooldown — a compaction must be followed by at least
        // COMPACTION_COOLDOWN_EVENTS new events before the next one.
        // PLAN-0341 decision #3: overflow-triggered compaction clears the
        // cooldown gate so the next normal turn can still auto-compact.
        // PLAN-0410 T2.2: both sides of the cooldown math are branch-scoped —
        // sibling Run events must not age out this branch's cooldown.
        com.fasterxml.jackson.databind.JsonNode previous = latestCompaction(sessionId, scope.visibility());
        if (previous != null && previous.has("up_to_sequence")) {
            String previousTrigger = previous.path("trigger").asText("auto");
            if (!"overflow".equals(previousTrigger)) {
                long latestSeq = latestVisibleSequence(sessionId, scope);
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
        com.fasterxml.jackson.databind.JsonNode usage = latestUsage(sessionId, scope.visibility());
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

    /**
     * PLAN-0410 T2.2: latest non-closed compaction circuit visible on
     * {@code branchId}'s path, or null — a sibling branch's open circuit
     * never pauses this branch's auto compaction.
     */
    public com.fasterxml.jackson.databind.JsonNode latestOpenCircuit(String sessionId, String branchId) {
        BranchScope scope = resolveScope(sessionId, null, branchId);
        return latestOpenCircuit(sessionId, scope);
    }

    private com.fasterxml.jackson.databind.JsonNode latestOpenCircuit(String sessionId, BranchScope scope) {
        List<ContextEvent> events = eventStoreService.read(sessionId, 0L, scope.visibility());
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

    private boolean isCompactionCircuitOpen(String sessionId, BranchScope scope) {
        return latestOpenCircuit(sessionId, scope) != null;
    }

    /** PLAN-0341 T1.3 recovery criterion (#53): growth past the residual
     *  recorded when the circuit opened — not merely re-crossing soft. */
    private boolean hasSignificantGrowth(String sessionId, BranchScope scope, ObjectNode context) {
        var open = latestOpenCircuit(sessionId, scope);
        if (open == null) {
            return false;
        }
        long residualAtOpen = open.path("residualTokens").asLong(0);
        long current = estimateInputTokens(context);
        // Significant = current estimate grew meaningfully past the failed residual.
        return residualAtOpen > 0 && current >= (long) (residualAtOpen * 1.15);
    }

    private void closeCompactionCircuit(String sessionId, ObjectNode context, BranchScope scope) {
        eventStoreService.append(sessionId,
                context.path("workspace_id").asText(""),
                context.path("user_id").asText(""),
                "context.compaction_circuit", Map.of(
                        "state", "closed",
                        "reason", "significant_growth"
                ), scope.runId(), scope.branchId());
        try {
            sseManager.send(sessionId, "context_compaction_circuit", Map.of(
                    "type", "context_compaction_circuit",
                    "state", "closed",
                    "reason", "significant_growth"));
        } catch (Exception e) {
            logger.debug("Failed to emit compaction circuit SSE: {}", e.getMessage());
        }
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

}
