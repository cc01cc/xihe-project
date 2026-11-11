package com.cc01cc.p.xihe.cp.policy;

/**
 * Policy layers, lowest to highest priority. See PLAN-0328 spec/approval.md §4.1.
 */
public enum PolicyLayer {
    BUILTIN(0),
    INSTANCE(1),
    USER(2),
    // PLAN-0766: the shared workspace-default config layer sits between user and workspace.
    WORKSPACE_DEFAULT(3),
    WORKSPACE(4),
    SESSION(5),
    PER_CALL(6);

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
