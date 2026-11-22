package com.cc01cc.p.xihe.cp.policy.condition;

import java.util.Set;

/**
 * task-863 / DEV-037 §4.1, spec/security/authorization.md §2.2: the <b>one</b> registry of
 * condition keys.
 *
 * <p>A condition key names the request-context field the condition reads (spec §2.4: workspace /
 * org unit / session are context, not a matching axis). Before task-863 every key was free text
 * and an unknown key could be ignored — which is fail-<i>open</i>. The registry makes the set
 * closed: a key that is not listed here is {@code unregistered}, and the baseline gate denies the
 * carrying grant row instead of skipping the condition.</p>
 *
 * <p><b>MVP scope (this card).</b> The registry only lists fields the kernel can actually read from
 * a request today: {@link #WORKSPACE} and {@link #SESSION}. Org-unit visibility is deliberately
 * <b>not</b> a condition key: spec §2.1/§2.2 keep the org tree in the visibility guard, and
 * {@code in_subtree} is not part of the operator set. Registering a name here is a promise that
 * the evaluation path can answer it; a name with no reader would turn every condition on it into a
 * permanent deny.</p>
 *
 * <p>Matching is exact: a key with stray whitespace or different case is <b>not</b> registered
 * (a typo must fail closed, not be normalized into a valid key).</p>
 */
public final class ConditionKeys {

    /** Request context field: the workspace the request resolves to. */
    public static final String WORKSPACE = "workspace";

    /** Request context field: the session container the request belongs to. */
    public static final String SESSION = "session";

    private static final Set<String> REGISTERED = Set.of(WORKSPACE, SESSION);

    private ConditionKeys() {
    }

    /** The closed key set, for documentation and negative tests. */
    public static Set<String> registered() {
        return REGISTERED;
    }

    /** Unknown, null and blank keys are all unregistered — the caller must deny, never skip. */
    public static boolean isRegistered(String key) {
        return key != null && REGISTERED.contains(key);
    }
}
