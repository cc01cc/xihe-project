package com.cc01cc.p.xihe.cp.policy;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * Layered policy resolver: "select the layer per domain first, then evaluate" — no cross-layer
 * merge (PLAN-0328 decision #37, spec §4.2).
 *
 * <p>Per domain ({@code actionClass}):</p>
 * <ol>
 *   <li>effective layer = highest layer that configures the domain (has at least one matching
 *       rule); locked rules from INSTANCE always participate;</li>
 *   <li>evaluate that layer's rules: any DENY match wins; ALLOW only when every requested
 *       resource is covered by an ALLOW rule; otherwise ASK (default when nothing matches).</li>
 * </ol>
 *
 * <p>Multi-domain: any DENY → DENY; else any ASK → ASK; else ALLOW.</p>
 *
 * <p>Modes: {@code plan} denies mutating domains (write / delete / exec) before any mode handling;
 * {@code bypass} turns ASK into ALLOW <em>after</em> DENY (decision #32) and records
 * {@code allowedBy}; {@code managed} considers only the INSTANCE layer.</p>
 */
public class LayeredPolicyResolver {

    public static final String MODE_DEFAULT = "default";
    public static final String MODE_BYPASS = "bypass";
    public static final String MODE_MANAGED = "managed";
    public static final String MODE_ACCEPT_EDITS = "accept-edits";
    public static final String MODE_PLAN = "plan";

    /** One layer's ruleset. */
    public record LayerInput(PolicyLayer layer, List<PolicyRule> rules) {
        public LayerInput {
            rules = List.copyOf(rules == null ? List.of() : rules);
        }
    }

    public PolicyVerdict resolve(PolicyRequest request, List<LayerInput> layers, String mode, PolicyLayer modeLayer) {
        String effectiveMode = mode == null ? MODE_DEFAULT : mode;
        PolicyLayer resolvedModeLayer = modeLayer == null ? PolicyLayer.BUILTIN : modeLayer;

        // plan mode denies mutating domains before any mode handling (bypass included)
        if (MODE_PLAN.equals(effectiveMode) && deniesMutations(request)) {
            return PolicyVerdict.of(PolicyEffect.DENY, null, resolvedModeLayer, effectiveMode,
                    "plan mode denies mutations");
        }

        List<LayerInput> effectiveLayers = MODE_MANAGED.equals(effectiveMode)
                ? layers.stream().filter(l -> l.layer() == PolicyLayer.INSTANCE).toList()
                : layers;

        PolicyVerdict combined = null;
        for (String actionClass : request.actionClasses()) {
            PolicyVerdict domain = evaluateDomain(actionClass, request, effectiveLayers);
            combined = combined == null ? domain : combine(combined, domain);
        }
        PolicyVerdict verdict = combined == null
                ? PolicyVerdict.of(PolicyEffect.ASK, null, PolicyLayer.BUILTIN, effectiveMode, "no rules matched")
                : combined;

        if (verdict.effect() == PolicyEffect.ASK && MODE_BYPASS.equals(effectiveMode)) {
            return verdict.allowedByMode(MODE_BYPASS + "@" + resolvedModeLayer.name());
        }
        if (verdict.effect() == PolicyEffect.ASK && MODE_ACCEPT_EDITS.equals(effectiveMode)
                && isAcceptEditsDomain(request)) {
            return verdict.allowedByMode(MODE_ACCEPT_EDITS + "@" + resolvedModeLayer.name());
        }
        return verdict;
    }

    private static boolean isAcceptEditsDomain(PolicyRequest request) {
        return request.actionClasses().stream().allMatch(ToolFaceRegistry.ACTION_WRITE::equals);
    }

    /** plan mode: any mutating domain makes the request mutating (read/network evaluate normally). */
    private static boolean deniesMutations(PolicyRequest request) {
        return request.actionClasses().stream().anyMatch(LayeredPolicyResolver::isMutatingDomain);
    }

    private static boolean isMutatingDomain(String actionClass) {
        return ToolFaceRegistry.ACTION_WRITE.equals(actionClass)
                || ToolFaceRegistry.ACTION_DELETE.equals(actionClass)
                || ToolFaceRegistry.ACTION_EXEC.equals(actionClass);
    }

    private PolicyVerdict evaluateDomain(String actionClass, PolicyRequest request, List<LayerInput> layers) {
        List<PolicyRule> selected = new ArrayList<>();
        PolicyLayer effectiveLayer = null;

        // Effective layer = the *highest-ranked* layer that configures this domain (spec §4.2 step 1).
        for (LayerInput input : layers) {
            List<PolicyRule> matchingDomain = input.rules().stream()
                    .filter(rule -> coversActionClass(rule, actionClass))
                    .toList();
            if (!matchingDomain.isEmpty()
                    && (effectiveLayer == null || input.layer().higherThan(effectiveLayer))) {
                effectiveLayer = input.layer();
                selected = new ArrayList<>(matchingDomain);
            }
        }

        final List<PolicyRule> domainRules = selected;

        // Locked rules are set by INSTANCE only and always participate (decision #39).
        for (LayerInput input : layers) {
            if (input.layer() != PolicyLayer.INSTANCE) {
                continue;
            }
            input.rules().stream()
                    .filter(PolicyRule::locked)
                    .filter(rule -> coversActionClass(rule, actionClass))
                    .filter(rule -> !domainRules.contains(rule))
                    .forEach(domainRules::add);
        }

        if (effectiveLayer == null) {
            effectiveLayer = PolicyLayer.BUILTIN;
        }
        if (domainRules.isEmpty()) {
            return PolicyVerdict.of(PolicyEffect.ASK, null, effectiveLayer, null, "no rule for domain " + actionClass);
        }

        Optional<PolicyRule> deny = best(domainRules, request, PolicyEffect.DENY);
        if (deny.isPresent()) {
            PolicyRule rule = deny.get();
            return PolicyVerdict.of(PolicyEffect.DENY, describe(rule), effectiveLayer, null,
                    "denied by " + describe(rule) + " (" + actionClass + ")");
        }

        if (coversAllResources(domainRules, request)) {
            Optional<PolicyRule> allow = best(domainRules, request, PolicyEffect.ALLOW);
            return PolicyVerdict.of(PolicyEffect.ALLOW, allow.map(LayeredPolicyResolver::describe).orElse(null),
                    effectiveLayer, null, "allowed by " + actionClass + " rules");
        }

        Optional<PolicyRule> ask = best(domainRules, request, PolicyEffect.ASK);
        return PolicyVerdict.of(PolicyEffect.ASK, ask.map(LayeredPolicyResolver::describe).orElse(null),
                effectiveLayer, null, "requires approval for domain " + actionClass
                        + (ask.isPresent() ? "" : " (default ask)"));
    }

    private static boolean coversActionClass(PolicyRule rule, String actionClass) {
        return "*".equals(rule.actionClass()) || rule.actionClass().equals(actionClass);
    }

    /** Best match for one effect: specificity desc, then priority desc, then last inserted. */
    private static Optional<PolicyRule> best(List<PolicyRule> rules, PolicyRequest request, PolicyEffect effect) {
        return rules.stream()
                .filter(rule -> rule.effect() == effect)
                .filter(rule -> matchesAnyResource(rule, request))
                .max(Comparator.comparingInt(PolicyRule::specificity)
                        .thenComparingInt(PolicyRule::priority)
                        .thenComparingLong(PolicyRule::seq));
    }

    private static boolean matchesAnyResource(PolicyRule rule, PolicyRequest request) {
        return request.resources().stream()
                .anyMatch(resource -> matches(rule.resource(), resource, request.shape()));
    }

    /** ALLOW requires every requested resource to be covered by a matching ALLOW rule. */
    private static boolean coversAllResources(List<PolicyRule> rules, PolicyRequest request) {
        List<PolicyRule> allows = rules.stream().filter(rule -> rule.effect() == PolicyEffect.ALLOW).toList();
        if (allows.isEmpty()) {
            return false;
        }
        return request.resources().stream().allMatch(resource ->
                allows.stream().anyMatch(rule -> matches(rule.resource(), resource, request.shape())));
    }

    /** Path-style matching: {@code *} does not cross {@code /}, {@code **} does. */
    static boolean matches(String pattern, String value) {
        return matches(pattern, value, ToolShape.STRUCTURED);
    }

    /**
     * Shape-aware matching (spec §8.1): structured tools treat resources as paths ({@code *} does not
     * cross {@code /}), while interpreter/opaque tools treat them as free text (command strings), where
     * {@code *} must be able to match arguments containing {@code /} (e.g. {@code rm -rf *}).
     */
    static boolean matches(String pattern, String value, ToolShape shape) {
        if (pattern == null || value == null) {
            return false;
        }
        if ("*".equals(pattern)) {
            return true;
        }
        String normalizedPattern = pattern.replace('\\', '/');
        String normalizedValue = value.replace('\\', '/');
        if (!normalizedPattern.contains("*")) {
            return normalizedPattern.equals(normalizedValue);
        }
        boolean pathSemantics = shape == ToolShape.STRUCTURED;
        return normalizedValue.matches(toRegex(normalizedPattern, pathSemantics));
    }

    /**
     * Glob → regex. Under path semantics a single {@code *} does not cross path separators and
     * {@code **} does; under free-text semantics both match anything.
     */
    private static String toRegex(String pattern, boolean pathSemantics) {
        StringBuilder regex = new StringBuilder();
        for (int i = 0; i < pattern.length(); i++) {
            char c = pattern.charAt(i);
            if (c == '*') {
                boolean doubleStar = i + 1 < pattern.length() && pattern.charAt(i + 1) == '*';
                if (doubleStar) {
                    i++;
                }
                regex.append(doubleStar || !pathSemantics ? ".*" : "[^/]*");
            } else if ("\\.[]{}()+-^$|?".indexOf(c) >= 0) {
                regex.append('\\').append(c);
            } else {
                regex.append(c);
            }
        }
        return regex.toString();
    }

    private static PolicyVerdict combine(PolicyVerdict left, PolicyVerdict right) {
        if (left.effect() == PolicyEffect.DENY || right.effect() == PolicyEffect.DENY) {
            return left.effect() == PolicyEffect.DENY ? left : right;
        }
        if (left.effect() == PolicyEffect.ASK || right.effect() == PolicyEffect.ASK) {
            return left.effect() == PolicyEffect.ASK ? left : right;
        }
        return left;
    }

    static String describe(PolicyRule rule) {
        return "{ " + rule.actionClass() + ", \"" + rule.resource() + "\", " + rule.effect().name().toLowerCase()
                + (rule.locked() ? ", locked" : "") + " }";
    }
}
