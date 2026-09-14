package com.cc01cc.p.xihe.cp.policy;

/**
 * Built-in-only context: no persisted layers or faces. Used where identity is unavailable
 * (legacy callers) and as the default in unit tests (PLAN-0328 M1).
 */
public class BuiltinPolicyContextProvider implements PolicyContextProvider {

    @Override
    public PolicyContext load(String userId, String workspaceId, String sessionId) {
        return PolicyContext.EMPTY;
    }
}
