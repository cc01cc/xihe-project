package com.cc01cc.p.xihe.cp.policy;

/**
 * PLAN-0622 M1.5: the limits configured for one resource. Every field is nullable and
 * {@code null} means "not configured" — the governor then never refuses on that dimension
 * (backwards compatible: an unconfigured connection behaves exactly as before).
 *
 * <p>{@code maxQueue} is a <b>fast-fail</b> ceiling, not a waiting room: the governor never
 * blocks, it refuses with 429 once the combined outstanding count reaches it (design §3: "快速
 * 失败，不无限排队"). {@code windowTokenBudget} is enforced against tokens recorded through
 * {@link ResourceGovernor#recordTokens}; with no recorded usage the window admits.</p>
 */
public record LimitSpec(Integer maxInflight, Integer maxQueue, Long windowTokenBudget, Integer windowSeconds) {

    public static final LimitSpec UNLIMITED = new LimitSpec(null, null, null, null);

    public LimitSpec {
        if (maxInflight != null && maxInflight < 1) {
            throw new IllegalArgumentException("maxInflight must be positive");
        }
        if (maxQueue != null && maxQueue < 0) {
            throw new IllegalArgumentException("maxQueue must not be negative");
        }
        if (windowTokenBudget != null && windowTokenBudget < 1) {
            throw new IllegalArgumentException("windowTokenBudget must be positive");
        }
        if (windowSeconds != null && windowSeconds < 1) {
            throw new IllegalArgumentException("windowSeconds must be positive");
        }
    }

    public boolean hasInflightCeiling() {
        return maxInflight != null;
    }

    public boolean hasQueueCeiling() {
        return maxQueue != null;
    }

    public boolean hasTokenWindow() {
        return windowTokenBudget != null && windowSeconds != null;
    }
}
