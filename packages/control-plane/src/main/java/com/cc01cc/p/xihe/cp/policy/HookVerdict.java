package com.cc01cc.p.xihe.cp.policy;

import java.util.Locale;
import java.util.Set;

/**
 * PLAN-0625 M2 (D25-08/16): an advisor's verdict — strictly advisory input to the gate.
 *
 * <p>Three values, fixed by ruling (the two-value draft in the design notes was a typo):
 * {@code allow}, {@code ask}, {@code deny}. Even {@code deny} is only PRESENTED — the policy
 * gate remains the sole executor of a rejection (D25-16: no auto-deny configuration exists).
 * Uncertainty (timeout, unwired dependency) must be reported as {@code ask} (D25-08).
 */
public record HookVerdict(String decision, String reason) {

    public static final String ALLOW = "allow";
    public static final String ASK = "ask";
    public static final String DENY = "deny";
    private static final Set<String> DECISIONS = Set.of(ALLOW, ASK, DENY);

    public HookVerdict {
        if (decision == null || !DECISIONS.contains(decision.toLowerCase(Locale.ROOT))) {
            throw new IllegalArgumentException("decision must be one of allow|ask|deny (got: " + decision + ")");
        }
        decision = decision.toLowerCase(Locale.ROOT);
        if (reason == null) {
            reason = "";
        }
    }

    public static HookVerdict allow(String reason) {
        return new HookVerdict(ALLOW, reason);
    }

    public static HookVerdict ask(String reason) {
        return new HookVerdict(ASK, reason);
    }

    public static HookVerdict deny(String reason) {
        return new HookVerdict(DENY, reason);
    }
}
