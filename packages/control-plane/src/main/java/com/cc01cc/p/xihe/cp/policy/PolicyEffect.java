package com.cc01cc.p.xihe.cp.policy;

/**
 * Rule effect. See PLAN-0328 spec/approval.md §8.
 * `locked` rules may only carry DENY or ASK (enforced at construction).
 */
public enum PolicyEffect {
    ALLOW,
    ASK,
    DENY
}
