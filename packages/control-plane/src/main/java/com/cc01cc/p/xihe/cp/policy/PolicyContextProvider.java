package com.cc01cc.p.xihe.cp.policy;

/**
 * Supplies the persisted part of the policy context for one request (PLAN-0328 M1).
 *
 * <p>Implementations must be fail-closed: on load failure the caller treats the request as
 * "no rule configured" (default ask), never as allow (spec §4.3).</p>
 */
public interface PolicyContextProvider {

    PolicyContext load(String userId, String workspaceId, String sessionId);
}
