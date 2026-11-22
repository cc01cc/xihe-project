package com.cc01cc.p.xihe.cp.policy.condition;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * task-863: conditions attached <b>per grant row</b>, kept separate from the grant's permission
 * atoms (spec/security/authorization.md §2.2: conditions and grants are two data sets; changing a
 * condition never requires re-issuing a grant).
 *
 * <p>Row identity is the grant id, so an atom that covers a pair but whose row carries a failing
 * condition simply does not hold the pair — union semantics are preserved: another row that holds
 * the same atom without a condition still authorizes. A {@code null} grant id has no conditions
 * (bare atom sets built by tests carry no row identity).</p>
 *
 * <p>{@link #none()} is the inert gate: an empty map means no condition is consulted, so callers
 * that do not have conditions behave exactly as before task-863.</p>
 */
public record ConditionGate(ConditionContext context, Map<String, List<Condition>> byGrantId) {

    private static final ConditionGate NONE = new ConditionGate(ConditionContext.EMPTY, Map.of());

    public ConditionGate {
        context = context == null ? ConditionContext.EMPTY : context;
        Map<String, List<Condition>> copy = new LinkedHashMap<>();
        if (byGrantId != null) {
            byGrantId.forEach((grantId, conditions) -> {
                if (grantId != null && conditions != null && !conditions.isEmpty()) {
                    copy.put(grantId, List.copyOf(conditions));
                }
            });
        }
        byGrantId = Map.copyOf(copy);
    }

    public static ConditionGate none() {
        return NONE;
    }

    public boolean isInert() {
        return byGrantId.isEmpty();
    }

    public List<Condition> forGrant(String grantId) {
        if (grantId == null) {
            return List.of();
        }
        return byGrantId.getOrDefault(grantId, List.of());
    }

    /** The baseline verdict for one row; an unconditioned row is satisfied without consulting the context. */
    public ConditionBaseline.Result check(String grantId) {
        return ConditionBaseline.check(forGrant(grantId), context);
    }
}
