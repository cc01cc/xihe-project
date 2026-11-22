package com.cc01cc.p.xihe.cp.policy.condition;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * task-863 / spec/security/authorization.md §2.2: the <b>MVP fail-closed baseline</b> for
 * conditions.
 *
 * <p>Exactly two rules are implemented here, in this precedence:</p>
 * <ol>
 *   <li><b>unregistered key ⇒ deny</b> — a condition whose key is not in {@link ConditionKeys}
 *       makes the carrying grant row inapplicable. Unknown keys are never skipped and never
 *       treated as satisfied.</li>
 *   <li><b>missing field ⇒ not satisfied</b> — a registered condition whose field is absent from
 *       {@link ConditionContext} is not satisfied, which fails the narrowing and therefore denies.</li>
 * </ol>
 *
 * <p>Rule 1 is checked across the whole set before rule 2, so a mixed set always reports the
 * stronger failure: "this key does not exist" is a configuration error, while "the field is
 * missing" can be a legitimate runtime state.</p>
 *
 * <p><b>What this is not.</b> No operator is evaluated: a registered key whose field is present is
 * {@code satisfied} by the baseline, because the value comparisons ({@code eq} / {@code neq} /
 * {@code in} / time window) are explicitly out of MVP scope. Until those land, no condition row is
 * persisted, so this branch cannot turn a production deny into an allow — it can only deny earlier.</p>
 */
public final class ConditionBaseline {

    /** Code carried by a DENY whose condition key is not in the registry. */
    public static final String CODE_KEY_UNREGISTERED = "condition-key-unregistered";

    /** Code carried by a DENY whose registered condition has no field in the request context. */
    public static final String CODE_FIELD_MISSING = "condition-field-missing";

    private ConditionBaseline() {
    }

    /** One failed condition, with the reason code an explanation surfaces. */
    public record Failure(String key, String code) {
    }

    /** The baseline verdict: satisfied only when there is no failure at all. */
    public record Result(boolean satisfied, List<Failure> failures) {

        public Result {
            failures = failures == null ? List.of() : List.copyOf(failures);
        }

        public static Result allSatisfied() {
            return new Result(true, List.of());
        }
    }

    /**
     * Evaluates a condition set against one request context. A null or empty set is satisfied:
     * "no condition" adds no narrowing (case D — the baseline never adds a matching axis).
     */
    public static Result check(Collection<Condition> conditions, ConditionContext context) {
        if (conditions == null || conditions.isEmpty()) {
            return Result.allSatisfied();
        }
        ConditionContext fields = context == null ? ConditionContext.EMPTY : context;
        List<Failure> unregistered = new ArrayList<>();
        for (Condition condition : conditions) {
            String key = condition == null ? null : condition.key();
            if (!ConditionKeys.isRegistered(key)) {
                unregistered.add(new Failure(key, CODE_KEY_UNREGISTERED));
            }
        }
        if (!unregistered.isEmpty()) {
            return new Result(false, unregistered);
        }
        List<Failure> missing = new ArrayList<>();
        for (Condition condition : conditions) {
            String key = condition.key();
            if (!fields.has(key)) {
                missing.add(new Failure(key, CODE_FIELD_MISSING));
            }
        }
        return missing.isEmpty() ? Result.allSatisfied() : new Result(false, missing);
    }
}
