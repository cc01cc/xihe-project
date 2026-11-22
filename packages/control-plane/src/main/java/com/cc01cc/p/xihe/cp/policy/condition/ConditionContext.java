package com.cc01cc.p.xihe.cp.policy.condition;

import java.util.Map;

/**
 * task-863: the context fields a condition may read (spec/security/authorization.md §2.4).
 *
 * <p>Context is <b>not</b> a matching axis: it never widens or narrows which
 * {@code (actionClass, resource)} pairs a grant covers. It is only the data source the baseline
 * presence rule looks at.</p>
 *
 * <p>Fail-closed shape: the map is immutable and may contain no null values; a field that is
 * absent, null or blank counts as <b>missing</b> (see {@link #has(String)}). A caller that cannot
 * resolve a field simply omits it — it must never pass a placeholder value.</p>
 */
public record ConditionContext(Map<String, String> fields) {

    public static final ConditionContext EMPTY = new ConditionContext(Map.of());

    public ConditionContext {
        fields = Map.copyOf(fields == null ? Map.of() : fields);
    }

    /**
     * Builds a context from the two fields the kernel can read today. Null ids are omitted, which
     * makes a condition on them fail the presence rule (deny) rather than pass on an empty string.
     */
    public static ConditionContext of(String workspaceId, String sessionId) {
        Map<String, String> fields = new java.util.HashMap<>();
        if (workspaceId != null && !workspaceId.isBlank()) {
            fields.put(ConditionKeys.WORKSPACE, workspaceId);
        }
        if (sessionId != null && !sessionId.isBlank()) {
            fields.put(ConditionKeys.SESSION, sessionId);
        }
        return new ConditionContext(fields);
    }

    /** True only when the field exists and carries a non-blank value. */
    public boolean has(String key) {
        if (key == null) {
            return false;
        }
        String value = fields.get(key);
        return value != null && !value.isBlank();
    }
}
