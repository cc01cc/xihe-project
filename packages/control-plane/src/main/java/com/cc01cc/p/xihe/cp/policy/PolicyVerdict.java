package com.cc01cc.p.xihe.cp.policy;

/**
 * Approval decision produced by {@link PolicyEngine} (PLAN-0407 T2.8: the ask list decides, not
 * rule layers). Carries the source layer and reason so audits and the UI can answer "why was
 * this allowed / asked" (PLAN-0328 spec §4.2 step 7); {@code matchedRule} stays null since rule
 * adjudication retired.
 *
 * @param allowedBy non-null when the outcome came from an `auto` mode rather than the ask list
 *                  (audit field `allowed_by`), e.g. {@code auto@SESSION}.
 */
public record PolicyVerdict(
        PolicyEffect effect,
        String matchedRule,
        PolicyLayer sourceLayer,
        String mode,
        String reason,
        String allowedBy) {

    public static PolicyVerdict of(PolicyEffect effect, String matchedRule, PolicyLayer layer,
                                   String mode, String reason) {
        return new PolicyVerdict(effect, matchedRule, layer, mode, reason, null);
    }

    public PolicyVerdict allowedByMode(String bypassOrigin) {
        return new PolicyVerdict(PolicyEffect.ALLOW, matchedRule, sourceLayer, mode, reason, bypassOrigin);
    }
}
