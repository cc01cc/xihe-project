package com.cc01cc.p.xihe.cp.policy;

/**
 * PLAN-0625 M2 (D25-10/15): a hook advisor — the seam every advice source implements.
 *
 * <p>The gate asks the {@link HookAdvisorRegistry} for the advisors subscribed to an action class;
 * the registry returns beans implementing this interface. The built-in guard is the first
 * implementation (kind {@code guard}); future plugins implement the same interface and appear
 * automatically (Spring injects {@code List<HookAdvisor>}). No plugin loading mechanism is built
 * here — the shape stays open, per the YAGNI ruling.
 */
public interface HookAdvisor {

    /** Stable advisor identity; matched against the principal row's {@code hooks.advisors[].kind}. */
    String kind();

    /**
     * Evaluate one invocation. Implementations must be fail-closed: any uncertainty (timeout,
     * unwired dependency, unparseable output) is reported as {@code ask} (D25-08), never as
     * {@code allow}.
     */
    HookVerdict advise(HookInvocation invocation);
}
