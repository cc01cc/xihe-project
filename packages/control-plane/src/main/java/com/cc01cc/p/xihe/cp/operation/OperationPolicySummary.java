package com.cc01cc.p.xihe.cp.operation;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.cc01cc.p.xihe.cp.policy.LayeredPolicyResolver;
import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;

import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Safe policy verdict snapshot attached to a dispatch ledger item (PLAN-0328 T1.15, spec
 * ui-ux §3.5): "why was this call allowed / blocked" without ever persisting raw inputs.
 *
 * <p>The stored shape is exactly {@link #POLICY_KEYS} — camelCase keys, lower-case enum words,
 * nullable {@code matchedRule} / {@code mode} / {@code allowedBy}. It never carries arguments,
 * MCP or rewritten bodies, or free-form exception text; the descriptor fields come from the
 * {@link PolicyVerdict} and the tool face resolved for the same evaluation.</p>
 *
 * <p>Static utility: the write path (MCP dispatch) and the read path (OperationViews projection)
 * must share one exact parser, and the projection is a static controller helper.</p>
 */
public final class OperationPolicySummary {

    /** The exact safe key set; any extra key makes a stored snapshot unreadable. */
    public static final Set<String> POLICY_KEYS = Set.of(
            "effect", "sourceLayer", "matchedRule", "reason", "mode", "allowedBy",
            "actionClass", "shape", "reused");

    /** V19 snapshots predate `reused`; it stays an optional known key so legacy rows still parse. */
    private static final Set<String> LEGACY_KEYS = Set.of(
            "effect", "sourceLayer", "matchedRule", "reason", "mode", "allowedBy",
            "actionClass", "shape");

    private static final Set<String> EFFECTS = Set.of("allow", "ask", "deny");
    private static final Set<String> SOURCE_LAYERS = Set.of(
            "builtin", "instance", "user", "workspace", "session", "per_call");
    private static final Set<String> SHAPES = Set.of("structured", "interpreter", "opaque");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private OperationPolicySummary() {}

    /**
     * Builds the persisted JSON snapshot from the final verdict of one MCP dispatch. Returns empty
     * on an incomplete descriptor and never throws, so a missing snapshot cannot block dispatch.
     */
    public static Optional<String> buildSnapshot(PolicyVerdict verdict, ToolFaceRegistry.Face face,
                                                 PolicyContext context) {
        return buildSnapshot(verdict, face, context, null);
    }

    /**
     * Same snapshot with the T1.7 reuse annotation: {@code true} when the dispatch reused an exact
     * session grant, {@code null} when reuse is not applicable (never fabricated).
     */
    public static Optional<String> buildSnapshot(PolicyVerdict verdict, ToolFaceRegistry.Face face,
                                                 PolicyContext context, Boolean reused) {
        if (verdict == null || verdict.effect() == null || verdict.sourceLayer() == null
                || verdict.reason() == null || verdict.reason().isBlank()
                || face == null || face.actionClass() == null || face.actionClass().isBlank()
                || face.shape() == null) {
            return Optional.empty();
        }
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("effect", verdict.effect().name().toLowerCase(Locale.ROOT));
        summary.put("sourceLayer", verdict.sourceLayer().name().toLowerCase(Locale.ROOT));
        summary.put("matchedRule", verdict.matchedRule());
        summary.put("reason", verdict.reason());
        summary.put("mode", effectiveMode(context, verdict));
        summary.put("allowedBy", lowercaseOrNull(verdict.allowedBy()));
        summary.put("actionClass", face.actionClass());
        summary.put("shape", face.shape().name().toLowerCase(Locale.ROOT));
        summary.put("reused", reused);
        try {
            return Optional.of(MAPPER.writeValueAsString(summary));
        } catch (Exception e) {
            return Optional.empty();
        }
    }

    /**
     * Parses a stored snapshot into the exact safe projection used by the operation views.
     * Absent, legacy (null) and malformed snapshots are omitted, never guessed.
     */
    public static Optional<Map<String, Object>> parse(String serialized) {
        if (serialized == null || serialized.isBlank()) {
            return Optional.empty();
        }
        try {
            JsonNode root = MAPPER.reader()
                    .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .readTree(serialized);
            if (root == null || !root.isObject()) {
                return Optional.empty();
            }
            Set<String> keys = keysOf(root);
            if (!keys.equals(POLICY_KEYS) && !keys.equals(LEGACY_KEYS)) {
                return Optional.empty();
            }

            String effect = requiredLowerCase(root, "effect", EFFECTS);
            String sourceLayer = requiredLowerCase(root, "sourceLayer", SOURCE_LAYERS);
            String reason = requiredText(root, "reason");
            String actionClass = requiredText(root, "actionClass");
            String shape = requiredLowerCase(root, "shape", SHAPES);
            String matchedRule = optionalText(root, "matchedRule");
            String mode = optionalLowerCase(root, "mode");
            String allowedBy = optionalLowerCase(root, "allowedBy");
            Boolean reused = optionalBoolean(root, "reused");
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
            summary.put("allowedBy", allowedBy);
            summary.put("actionClass", actionClass);
            summary.put("shape", shape);
            summary.put("reused", reused);
            return Optional.of(summary);
        } catch (Exception e) {
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

    private static String lowercaseOrNull(String value) {
        return value == null || value.isBlank() ? null : value.toLowerCase(Locale.ROOT);
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

    /** `reused` is nullable; any non-boolean value makes the snapshot unreadable. */
    private static Boolean optionalBoolean(JsonNode root, String key) {
        JsonNode value = root.get(key);
        if (value == null || value.isNull()) {
            return null;
        }
        if (!value.isBoolean()) {
            throw new IllegalArgumentException("policy field is not a boolean");
        }
        return value.asBoolean();
    }
}
