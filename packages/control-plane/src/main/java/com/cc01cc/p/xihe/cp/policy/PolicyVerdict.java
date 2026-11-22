package com.cc01cc.p.xihe.cp.policy;

import java.util.List;

/**
 * Approval decision produced by {@link PolicyEngine} (PLAN-0407 T2.8: the ask list decides, not
 * rule layers). Carries the source layer and reason so audits and the UI can answer "why was
 * this allowed / asked" (PLAN-0328 spec §4.2 step 7); {@code matchedRule} stays null since rule
 * adjudication retired.
 *
 * @param allowedBy non-null when the outcome came from an `auto` mode rather than the ask list
 *                  (audit field `allowed_by`), e.g. {@code auto@SESSION}.
 * @param resources task-859: the request's concrete resource axis, so an ASK is bound to
 *                  {@code (action, resource)} rather than the action class alone. Empty for an
 *                  ALLOW/DENY verdict produced outside the ask path.
 */
public record PolicyVerdict(
        PolicyEffect effect,
        String matchedRule,
        PolicyLayer sourceLayer,
        String mode,
        String reason,
        String allowedBy,
        List<String> resources) {

    public PolicyVerdict {
        resources = resources == null ? List.of() : List.copyOf(resources);
    }

    public static PolicyVerdict of(PolicyEffect effect, String matchedRule, PolicyLayer layer,
                                   String mode, String reason) {
        return new PolicyVerdict(effect, matchedRule, layer, mode, reason, null, List.of());
    }

    /**
     * task-859: an APPROVAL verdict must carry the request's resource axis — the approval authority
     * is {@code (action:approve, that resource)}, so a verdict that only names the action class
     * cannot express the decision it is asking for.
     */
    public static PolicyVerdict of(PolicyEffect effect, String matchedRule, PolicyLayer layer,
                                   String mode, String reason, List<String> resources) {
        return new PolicyVerdict(effect, matchedRule, layer, mode, reason, null, resources);
    }

    public PolicyVerdict allowedByMode(String bypassOrigin) {
        return new PolicyVerdict(PolicyEffect.ALLOW, matchedRule, sourceLayer, mode, reason,
                bypassOrigin, resources);
    }
}
