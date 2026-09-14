package com.cc01cc.p.xihe.cp.policy;

/**
 * Policy layers, lowest to highest priority. See PLAN-0328 spec/approval.md §4.1.
 */
public enum PolicyLayer {
    BUILTIN(0),
    INSTANCE(1),
    USER(2),
    WORKSPACE(3),
    SESSION(4),
    PER_CALL(5);

    public static final String UNCLASSIFIED_ACTION = "unclassified";

    private final int rank;

    PolicyLayer(int rank) {
        this.rank = rank;
    }

    public int rank() {
        return rank;
    }

    public boolean higherThan(PolicyLayer other) {
        return rank > other.rank;
    }
}
