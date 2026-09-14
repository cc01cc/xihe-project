package com.cc01cc.p.xihe.cp.policy;

import java.util.Objects;

/**
 * One authorization rule: {actionClass, resource, effect}. See PLAN-0328 spec/approval.md §8.
 *
 * <p>{@code resource} supports three specificity tiers — exact, prefix (trailing {@code *}) and
 * glob. {@code seq} preserves insertion order so that same-priority ties resolve to the
 * last-matched rule (see {@link LayeredPolicyResolver}).</p>
 *
 * <p>{@code locked} rules (only settable from the INSTANCE layer, per decision #39) participate in
 * evaluation regardless of layer selection and may only be DENY or ASK.</p>
 */
public record PolicyRule(
        String actionClass,
        String resource,
        PolicyEffect effect,
        int priority,
        boolean locked,
        long seq) {

    public PolicyRule {
        Objects.requireNonNull(actionClass, "actionClass");
        Objects.requireNonNull(resource, "resource");
        Objects.requireNonNull(effect, "effect");
        if (locked && effect == PolicyEffect.ALLOW) {
            throw new IllegalArgumentException("locked rules may only be DENY or ASK");
        }
    }

    public static PolicyRule of(String actionClass, String resource, PolicyEffect effect) {
        return new PolicyRule(actionClass, resource, effect, 0, false, 0L);
    }

    public static PolicyRule of(String actionClass, String resource, PolicyEffect effect, int priority, long seq) {
        return new PolicyRule(actionClass, resource, effect, priority, false, seq);
    }

    /** Specificity tier: 2 = exact, 1 = prefix, 0 = glob (containing {@code *} in the middle). */
    public int specificity() {
        if (!resource.contains("*")) {
            return 2;
        }
        if (resource.endsWith("*") && resource.indexOf('*') == resource.length() - 1) {
            return 1;
        }
        return 0;
    }
}
