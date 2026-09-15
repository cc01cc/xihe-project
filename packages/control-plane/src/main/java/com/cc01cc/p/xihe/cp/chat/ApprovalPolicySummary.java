package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.policy.LayeredPolicyResolver;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEngine;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.springframework.beans.factory.annotation.Autowired;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/** Builds the display-only policy metadata attached to approval events and recovery payloads. */
@Component
public class ApprovalPolicySummary {

    private static final Logger logger = LoggerFactory.getLogger(ApprovalPolicySummary.class);
    private static final Set<String> POLICY_KEYS = Set.of(
            "effect", "sourceLayer", "matchedRule", "reason", "mode", "actionClass", "shape");
    private static final Set<String> EFFECTS = Set.of("allow", "ask", "deny");
    private static final Set<String> SOURCE_LAYERS = Set.of(
            "builtin", "instance", "user", "workspace", "session", "per_call");
    private static final Set<String> SHAPES = Set.of("structured", "interpreter", "opaque");

    private final PolicyEngine policyEngine;
    private final ObjectMapper objectMapper;

    @Autowired
    public ApprovalPolicySummary(PolicyEngine policyEngine, ObjectMapper objectMapper) {
        this.policyEngine = policyEngine;
        this.objectMapper = objectMapper;
    }

    /** Source-compatible constructor for focused unit tests. */
    public ApprovalPolicySummary(PolicyEngine policyEngine) {
        this(policyEngine, new ObjectMapper());
    }

    /**
     * Evaluates once while the approval is being created. Agent approval details are a preview, not
     * an MCP request body, so the resource extractor must receive an empty body and conservatively
     * use its wildcard fallback.
     */
    public Optional<Map<String, Object>> buildAtCreation(String tool, String sessionId,
                                                         String userId, String workspaceId) {
        try {
            PolicyContext context = policyEngine.loadContext(userId, workspaceId, sessionId);
            PolicyVerdict verdict = policyEngine.evaluateVerdict(
                    context, tool, "", sessionId, null, userId, workspaceId);
            ToolFaceRegistry.Face face = policyEngine.faceOf(context, tool);
            if (verdict == null || verdict.effect() == null || verdict.sourceLayer() == null
                    || verdict.reason() == null || verdict.reason().isBlank()
                    || face == null || face.actionClass() == null || face.actionClass().isBlank()
                    || face.shape() == null) {
                throw new IllegalStateException("policy descriptor is incomplete");
            }

            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("effect", verdict.effect().name().toLowerCase(Locale.ROOT));
            summary.put("sourceLayer", verdict.sourceLayer().name().toLowerCase(Locale.ROOT));
            summary.put("matchedRule", verdict.matchedRule());
            summary.put("reason", verdict.reason());
            summary.put("mode", effectiveMode(context, verdict));
            summary.put("actionClass", face.actionClass());
            summary.put("shape", face.shape().name().toLowerCase(Locale.ROOT));
            return Optional.of(summary);
        } catch (RuntimeException e) {
            // A display descriptor must never block durable approval delivery. Do not log body,
            // details, or exception messages because they may contain credentials or arguments.
            logger.warn("[POLICY] approval_summary_failed sessionId={} userId={} workspaceId={} failureType={}",
                    sessionId, userId, workspaceId, e.getClass().getName());
            return Optional.empty();
        }
    }

    /** Reads the persisted display-only snapshot without policy evaluation or audit writes. */
    public Optional<Map<String, Object>> readStored(String serialized) {
        Optional<Map<String, Object>> parsed = parse(serialized);
        if (parsed.isEmpty()) {
            logger.debug("[POLICY] approval_summary_read_failed failureType={}",
                    serialized == null || serialized.isBlank() ? "missing" : "malformed");
        }
        return parsed;
    }

    /** Pure parser for the exact safe policy-summary shape. */
    public Optional<Map<String, Object>> parse(String serialized) {
        if (serialized == null || serialized.isBlank()) {
            return Optional.empty();
        }
        try {
            JsonNode root = objectMapper.reader()
                    .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .readTree(serialized);
            if (root == null || !root.isObject() || !keysOf(root).equals(POLICY_KEYS)) {
                return Optional.empty();
            }

            String effect = requiredLowerCase(root, "effect", EFFECTS);
            String sourceLayer = requiredLowerCase(root, "sourceLayer", SOURCE_LAYERS);
            String reason = requiredText(root, "reason");
            String actionClass = requiredText(root, "actionClass");
            String shape = requiredLowerCase(root, "shape", SHAPES);
            String matchedRule = optionalText(root, "matchedRule");
            String mode = optionalLowerCase(root, "mode");
            if (effect == null || sourceLayer == null || reason == null || actionClass == null
                    || shape == null) {
                return Optional.empty();
            }

            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("effect", effect);
            summary.put("sourceLayer", sourceLayer);
            summary.put("matchedRule", matchedRule);
            summary.put("reason", reason);
            summary.put("mode", mode);
            summary.put("actionClass", actionClass);
            summary.put("shape", shape);
            return Optional.of(summary);
        } catch (Exception e) {
            logger.debug("[POLICY] approval_summary_parse_failed failureType={}", e.getClass().getName());
            return Optional.empty();
        }
    }

    private static String effectiveMode(PolicyContext context, PolicyVerdict verdict) {
        String mode = context == null ? null : context.mode();
        if (mode == null || mode.isBlank()) {
            mode = context == null ? null : context.sessionMode();
        }
        if (mode == null || mode.isBlank()) {
            mode = verdict.mode();
        }
        return mode == null || mode.isBlank()
                ? LayeredPolicyResolver.MODE_DEFAULT : mode.toLowerCase(Locale.ROOT);
    }

    private static Set<String> keysOf(JsonNode root) {
        Set<String> keys = new HashSet<>();
        root.fieldNames().forEachRemaining(keys::add);
        return keys;
    }

    private static String requiredText(JsonNode root, String key) {
        JsonNode value = root.get(key);
        return value != null && value.isTextual() && !value.asText().isBlank() ? value.asText() : null;
    }

    private static String requiredLowerCase(JsonNode root, String key, Set<String> allowed) {
        String value = requiredText(root, key);
        if (value == null || !value.equals(value.toLowerCase(Locale.ROOT))
                || (allowed != null && !allowed.contains(value))) {
            return null;
        }
        return value;
    }

    private static String optionalText(JsonNode root, String key) {
        JsonNode value = root.get(key);
        if (value == null || value.isNull()) {
            return null;
        }
        if (!value.isTextual() || value.asText().isBlank()) {
            throw new IllegalArgumentException("invalid optional policy field");
        }
        return value.asText();
    }

    private static String optionalLowerCase(JsonNode root, String key) {
        String value = optionalText(root, key);
        if (value != null && !value.equals(value.toLowerCase(Locale.ROOT))) {
            throw new IllegalArgumentException("policy field is not lower-case");
        }
        return value;
    }
}
