package com.cc01cc.p.xihe.cp.context.summary;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Primary;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0354 T1.3 / spec §2–§5: LLM summarizer with rule fallback.
 *
 * <p>Default provider is rule since PLAN-0355 M2 (2026-09-19): the quality/cost
 * gate measured 35% timeout fallback, p95 44.4s latency and constraint loss
 * under {xiaomi}/{mimo-v2.5}, so the shipped default keeps the deterministic
 * rule summary. Explicit {@code summaryProvider=llm} still enables the seam.
 * Every failure path (no credential, lease, timeout, upstream error, unusable
 * output) degrades to the rule implementation with a frozen
 * {@code fallbackReason} — never throws, never blocks a run (invariant I1).
 * Input is bounded before the hop (invariant I2) and {@code [Constraints]}
 * never reaches the LLM (invariant I3).
 */
@Service
@Primary
public class LlmSummaryProvider implements SummaryProvider {

    private static final Logger logger = LoggerFactory.getLogger(LlmSummaryProvider.class);

    static final int DEFAULT_TIMEOUT_MS = 15_000;
    static final int MIN_TIMEOUT_MS = 1_000;
    static final int MAX_TIMEOUT_MS = 60_000;
    static final int MESSAGE_MAX_CHARS = 4_000;
    static final int OUTPUT_MAX_CHARS = 100_000;
    static final int DEFAULT_PRUNE_WINDOW_CHARS = 80_000;
    static final int MIN_PRUNE_WINDOW_CHARS = 2_000;
    static final int MAX_PRUNE_WINDOW_CHARS = 2_000_000;
    /** PLAN-0354 §3: short lease TTL > summaryTimeoutMs upper bound (60s). */
    static final Duration SUMMARY_LEASE_TTL = Duration.ofMinutes(2);

    private final ConfigService configService;
    private final SessionRepository sessionRepository;
    private final ProviderCredentialLeaseService credentialLeases;
    private final RuleBasedSummaryProvider ruleProvider;
    private final ConstraintExtractor constraintExtractor;
    private final AgentSummarizeClient agentClient;
    private final ObjectMapper objectMapper;

    public LlmSummaryProvider(ConfigService configService,
                              SessionRepository sessionRepository,
                              ProviderCredentialLeaseService credentialLeases,
                              RuleBasedSummaryProvider ruleProvider,
                              ConstraintExtractor constraintExtractor,
                              AgentSummarizeClient agentClient,
                              ObjectMapper objectMapper) {
        this.configService = configService;
        this.sessionRepository = sessionRepository;
        this.credentialLeases = credentialLeases;
        this.ruleProvider = ruleProvider;
        this.constraintExtractor = constraintExtractor;
        this.agentClient = agentClient;
        this.objectMapper = objectMapper;
    }

    @Override
    public SummaryResult summarize(SummaryRequest request) {
        long started = System.currentTimeMillis();
        Session session = lookupSession(request.sessionId());
        SummarySettings settings = resolveSettings(request, session);
        if (!"llm".equals(settings.provider())) {
            return ruleDirect(request, started);
        }
        String connectionId = session == null ? null : session.getProviderConnectionId();
        if (isBlank(settings.providerId()) || isBlank(settings.model())
                || "mock".equals(settings.providerId()) || isBlank(connectionId)) {
            logger.warn("[LIFECYCLE] service=cp event=compaction_summary_fallback sessionId={} trigger={} reason=no_credential",
                    request.sessionId(), request.trigger());
            return ruleFallback(request, started, "no_credential", null);
        }
        ProviderCredentialLeaseService.IssuedLease lease;
        try {
            lease = credentialLeases.issue(
                    request.userId(), request.workspaceId(), request.sessionId(), request.runId(),
                    connectionId, settings.providerId(), settings.model(),
                    session.getConnectionRevision(), SUMMARY_LEASE_TTL);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=compaction_summary_fallback sessionId={} trigger={} reason=lease_failed error={}",
                    request.sessionId(), request.trigger(), e.getMessage());
            return ruleFallback(request, started, "lease_failed", null);
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("sessionId", request.sessionId());
        payload.put("runId", request.runId());
        payload.put("provider", settings.providerId());
        payload.put("model", settings.model());
        payload.put("credentialLease", lease.token());
        payload.put("providerConnectionId", connectionId);
        payload.put("connectionRevision", session.getConnectionRevision() == null ? 0L : session.getConnectionRevision());
        payload.put("text", buildInput(request, settings.inputBudgetChars()));
        String prior = SummarySections.withoutSection(request.previousSummary(), SummarySections.CONSTRAINTS);
        if (prior != null && !prior.isBlank()) {
            payload.put("priorSummary", truncate(prior, Math.max(1, settings.inputBudgetChars() / 2)));
        }

        AgentSummarizeClient.Result result;
        try {
            result = agentClient.summarize(payload, settings.timeoutMs());
        } catch (AgentSummarizeClient.AgentSummarizeException e) {
            logger.warn("[LIFECYCLE] service=cp event=compaction_summary_fallback sessionId={} trigger={} reason={} durationMs={}",
                    request.sessionId(), request.trigger(), e.reason(), System.currentTimeMillis() - started);
            return ruleFallback(request, started, e.reason(), null);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=compaction_summary_fallback sessionId={} trigger={} reason=agent_error error={}",
                    request.sessionId(), request.trigger(), e.getMessage());
            return ruleFallback(request, started, "agent_error", null);
        }

        Map<String, Object> usage = normalizeUsage(result.usage(), settings.modelKey(),
                System.currentTimeMillis() - started);
        if (!isUsable(result.summary())) {
            logger.warn("[LIFECYCLE] service=cp event=compaction_summary_fallback sessionId={} trigger={} reason=invalid_output durationMs={}",
                    request.sessionId(), request.trigger(), System.currentTimeMillis() - started);
            return ruleFallback(request, started, "invalid_output", usage);
        }
        String summary = withConstraints(request, result.summary());
        logger.info("[LIFECYCLE] service=cp event=compaction_summary_used sessionId={} trigger={} provider=llm model={} durationMs={} source={}",
                request.sessionId(), request.trigger(), settings.modelKey(),
                System.currentTimeMillis() - started, usage == null ? "fallback" : usage.get("source"));
        return new SummaryResult(
                summary,
                "llm",
                settings.modelKey(),
                System.currentTimeMillis() - started,
                usage == null ? "fallback" : String.valueOf(usage.get("source")),
                null,
                usage);
    }

    private SummaryResult ruleDirect(SummaryRequest request, long started) {
        SummaryResult rule = ruleProvider.summarize(request);
        return new SummaryResult(rule.summary(), "rule", "", System.currentTimeMillis() - started, "estimated", null, null);
    }

    private SummaryResult ruleFallback(SummaryRequest request, long started, String reason, Map<String, Object> usage) {
        SummaryResult rule = ruleProvider.summarize(request);
        String source = usage == null ? "estimated" : String.valueOf(usage.getOrDefault("source", "fallback"));
        return new SummaryResult(rule.summary(), "rule", "", System.currentTimeMillis() - started, source, reason, usage);
    }

    /** Append the code-extracted [Constraints] section; LLM output must not carry one. */
    private String withConstraints(SummaryRequest request, String llmSummary) {
        String cleaned = SummarySections.withoutSection(llmSummary, SummarySections.CONSTRAINTS);
        Map<String, String> prior = SummarySections.parse(request.previousSummary());
        String section = constraintExtractor.renderSection(
                request.sessionId(), (ArrayNode) request.context().get("messages"), prior.get(SummarySections.CONSTRAINTS));
        if (section == null) {
            return cleaned;
        }
        return cleaned.isBlank() ? section : cleaned + "\n" + section;
    }

    /**
     * Bound the summarizer input (spec §4, I2): per-message cap + newest-first
     * accumulation within the prune-window budget, oldest messages dropped with
     * an explicit marker.
     */
    String buildInput(SummaryRequest request, int budget) {
        ArrayNode messages = (ArrayNode) request.context().get("messages");
        List<String> blocks = new ArrayList<>();
        int used = 0;
        int omitted = 0;
        if (messages != null) {
            for (int i = messages.size() - 1; i >= 0; i--) {
                String content = messages.get(i).path("content").asText("");
                if (content.isBlank()) {
                    continue;
                }
                String role = messages.get(i).path("role").asText("");
                String block = role + ": " + content;
                if (block.length() > MESSAGE_MAX_CHARS) {
                    block = block.substring(0, MESSAGE_MAX_CHARS)
                            + "…[truncated " + (block.length() - MESSAGE_MAX_CHARS) + " chars]";
                }
                if (used + block.length() > budget) {
                    omitted = i + 1;
                    break;
                }
                blocks.add(block);
                used += block.length();
            }
        }
        Collections.reverse(blocks);
        StringBuilder sb = new StringBuilder();
        if (omitted > 0) {
            sb.append("[... ").append(omitted).append(" earlier messages omitted for summarization ...]\n");
        }
        for (String block : blocks) {
            sb.append(block).append('\n');
        }
        return sb.toString().trim();
    }

    /** Ensure the 0343-named fields exist; duration/model come from the CP side. */
    private Map<String, Object> normalizeUsage(Map<String, Object> raw, String modelKey, long durationMs) {
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        Map<String, Object> usage = new LinkedHashMap<>(raw);
        long in = number(usage.get("inputTokens"));
        long out = number(usage.get("outputTokens"));
        usage.putIfAbsent("inputTokens", in);
        usage.putIfAbsent("outputTokens", out);
        usage.putIfAbsent("totalTokens", in + out);
        usage.putIfAbsent("estimatedInputTokens", 0);
        usage.put("model", modelKey);
        usage.put("durationMs", durationMs);
        usage.putIfAbsent("source", "fallback");
        return usage;
    }

    private boolean isUsable(String summary) {
        if (summary == null || summary.isBlank() || summary.length() > OUTPUT_MAX_CHARS) {
            return false;
        }
        return java.util.regex.Pattern.compile("(?m)^\\[").matcher(summary).find();
    }

    private Session lookupSession(String sessionId) {
        try {
            Optional<Session> session = sessionRepository.findById(UUID.fromString(sessionId));
            return session.orElse(null);
        } catch (Exception e) {
            logger.debug("[LIFECYCLE] service=cp event=compaction_summary_session_lookup_failed sessionId={}", sessionId);
            return null;
        }
    }

    private SummarySettings resolveSettings(SummaryRequest request, Session session) {
        Map<String, String> domain = resolveDomainSafely(
                "context-policy", uuidOrNull(request.userId()), uuidOrNull(request.workspaceId()));
        Map<String, String> llmDomain = resolveDomainSafely(
                "llm-provider", uuidOrNull(request.userId()), uuidOrNull(request.workspaceId()));
        JsonNode defaults = parseObject(domain.get("defaults"));
        JsonNode models = parseObject(domain.get("models"));

        String providerId = session != null && !isBlank(session.getModelProvider())
                ? session.getModelProvider() : text(llmDomain.get("defaultProvider"));
        String baseModel = session != null && !isBlank(session.getModelName())
                ? session.getModelName() : text(llmDomain.get("defaultModel"));
        if (isBlank(baseModel) && !isBlank(providerId)) {
            baseModel = text(llmDomain.get(providerId + "Model"));
        }
        JsonNode modelCfg = !isBlank(baseModel) ? models.path(baseModel) : objectMapper.createObjectNode();

        // PLAN-0355 M2 (2026-09-19): gate outcome = reject → shipped default is
        // the deterministic rule summary; explicit "llm" re-enables the seam.
        // Evidence: plans/archive/20260919/PLAN-0355-XH-quality-cost-gate/evidence/gate-decision.md
        String providerMode = pick(modelCfg, defaults, "summaryProvider", "rule");
        String modelOverride = pick(modelCfg, defaults, "summaryModel", null);
        String model = !isBlank(modelOverride) ? modelOverride : baseModel;
        int timeoutMs = clampTimeout(pickInt(modelCfg, defaults, "summaryTimeoutMs", DEFAULT_TIMEOUT_MS), baseModel);
        int budget = pickInt(modelCfg, defaults, "pruneWindowChars", DEFAULT_PRUNE_WINDOW_CHARS);
        budget = Math.max(MIN_PRUNE_WINDOW_CHARS, Math.min(MAX_PRUNE_WINDOW_CHARS, budget));

        String modelKey = "";
        if (!isBlank(model)) {
            modelKey = model.contains("/") || isBlank(providerId) ? model : providerId + "/" + model;
        }
        return new SummarySettings(providerMode, providerId, model, modelKey, timeoutMs, budget);
    }

    private int clampTimeout(int value, String model) {
        if (value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
            int clamped = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, value));
            logger.warn("[LIFECYCLE] service=cp event=compaction_summary_timeout_clamped model={} requested={} applied={}",
                    model, value, clamped);
            return clamped;
        }
        return value;
    }

    /** Never let a config lookup failure break the compaction path (I1). */
    private Map<String, String> resolveDomainSafely(String domain, UUID userId, UUID workspaceId) {
        try {
            Map<String, String> entries = configService.resolveDomain(domain, userId, workspaceId);
            return entries == null ? Map.of() : entries;
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=compaction_summary_config_unavailable domain={} error={}",
                    domain, e.getMessage());
            return Map.of();
        }
    }

    private JsonNode parseObject(String raw) {
        if (raw == null || raw.isBlank()) {
            return objectMapper.createObjectNode();
        }
        try {
            JsonNode node = objectMapper.readTree(raw);
            return node.isObject() ? node : objectMapper.createObjectNode();
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=compaction_summary_config_parse_failed error={}", e.getMessage());
            return objectMapper.createObjectNode();
        }
    }

    private String pick(JsonNode modelCfg, JsonNode defaults, String key, String fallback) {
        JsonNode fromModel = modelCfg.path(key);
        if (fromModel.isTextual() && !fromModel.asText().isBlank()) {
            return fromModel.asText();
        }
        JsonNode fromDefaults = defaults.path(key);
        if (fromDefaults.isTextual() && !fromDefaults.asText().isBlank()) {
            return fromDefaults.asText();
        }
        return fallback;
    }

    private int pickInt(JsonNode modelCfg, JsonNode defaults, String key, int fallback) {
        JsonNode fromModel = modelCfg.path(key);
        if (fromModel.isNumber()) {
            return fromModel.asInt();
        }
        JsonNode fromDefaults = defaults.path(key);
        if (fromDefaults.isNumber()) {
            return fromDefaults.asInt();
        }
        if (fromDefaults.isTextual()) {
            try {
                return Integer.parseInt(fromDefaults.asText().trim());
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return fallback;
    }

    private static long number(Object value) {
        return value instanceof Number n ? n.longValue() : 0L;
    }

    private static String text(String value) {
        return value == null ? null : value.trim();
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static String truncate(String value, int max) {
        if (value.length() <= max) {
            return value;
        }
        return value.substring(0, max) + "…[truncated " + (value.length() - max) + " chars]";
    }

    private static UUID uuidOrNull(String value) {
        if (isBlank(value)) {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    record SummarySettings(String provider, String providerId, String model, String modelKey,
                           int timeoutMs, int inputBudgetChars) {
    }
}
