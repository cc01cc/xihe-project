package com.cc01cc.p.xihe.cp.policy;

/**
 * Verdict produced by {@link LayeredPolicyResolver}. Carries the effective layer and matched rule
 * so audits and the UI can answer "why was this allowed / blocked" (PLAN-0328 spec §4.2 step 7).
 *
 * @param allowedBy non-null when the outcome came from a `bypass` mode rather than rules
 *                  (audit field `allowed_by`, decision #32), e.g. {@code bypass@SESSION}.
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
