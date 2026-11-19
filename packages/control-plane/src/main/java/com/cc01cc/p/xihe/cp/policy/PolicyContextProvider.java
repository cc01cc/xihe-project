package com.cc01cc.p.xihe.cp.policy;

/**
 * Supplies the persisted part of the policy context for one request (PLAN-0328 M1).
 *
 * <p>Implementations must be fail-closed: on load failure the caller treats the request as
 * "no rule configured" (default ask), never as allow (spec §4.3).</p>
 */
public interface PolicyContextProvider {

    PolicyContext load(String userId, String workspaceId, String sessionId);

    /**
     * Principal-scoped variant (D-1908 prerequisite, task-107b). The default keeps every existing
     * implementation source-compatible: until grants carry a tier, the principal cannot tighten or
     * relax the verdict, so delegating to the three-argument form is the documented behaviour.
     */
    default PolicyContext load(String userId, String workspaceId, String sessionId, String principalId) {
        return load(userId, workspaceId, sessionId);
    }
}
