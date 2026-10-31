package com.cc01cc.p.xihe.cp.chat;

/**
 * PLAN-0608 C′: the single resolver for "which workspace owns this session
 * creation". Two explicit input surfaces exist (spec §I5):
 *
 * <ul>
 *   <li><b>path</b> — {@code POST /api/v1/workspaces/{wsId}/sessions}</li>
 *   <li><b>header</b> — {@code X-Workspace-Id} (resolved by
 *       {@code TenantContextInterceptor})</li>
 * </ul>
 *
 * <p>Both surfaces feed <b>one</b> result (I1: the resolver output is unique).
 * Giving both with different values is an explicit client-input conflict, not a
 * second ownership source: it is rejected with 400
 * {@code WORKSPACE_CONTEXT_CONFLICT} instead of silently picking one.
 *
 * <p>When neither surface is present the legacy fallback policy applies
 * (B-narrow, decision #3): more than one active member workspace is ambiguous
 * and fails with 409 {@code WORKSPACE_CONTEXT_REQUIRED}; exactly one workspace
 * (or zero) keeps the pre-existing behaviour (fallback / 401 downstream).
 *
 * <p>Pure and side-effect free so the three-source and conflict matrix is
 * unit-testable without a Spring context.
 */
public final class SessionWorkspaceResolver {

    public enum Outcome {
        /** Use {@link Resolution#workspaceId()}; may be null when no context exists (caller 401s). */
        USE,
        /** Path and header disagree: 400 WORKSPACE_CONTEXT_CONFLICT. */
        CONFLICT,
        /** No explicit input and more than one member workspace: 409 WORKSPACE_CONTEXT_REQUIRED. */
        REQUIRED
    }

    public record Resolution(Outcome outcome, String workspaceId, String source) {}

    private SessionWorkspaceResolver() {}

    /**
     * @param pathWorkspaceId   normalized path variable, or null when the route has none
     * @param headerWorkspaceId normalized {@code X-Workspace-Id}, or null when absent
     * @param memberWorkspaceCount active member workspaces; only read when both inputs are null
     *                             (callers pass a negative value to skip the query)
     * @param contextWorkspaceId the interceptor's resolved workspace (header/claim/fallback)
     * @param contextSource      the interceptor's source label ({@code header|claim|default})
     */
    public static Resolution resolve(String pathWorkspaceId,
                                     String headerWorkspaceId,
                                     int memberWorkspaceCount,
                                     String contextWorkspaceId,
                                     String contextSource) {
        if (pathWorkspaceId != null && headerWorkspaceId != null
                && !pathWorkspaceId.equalsIgnoreCase(headerWorkspaceId)) {
            return new Resolution(Outcome.CONFLICT, null, null);
        }
        if (pathWorkspaceId != null) {
            return new Resolution(Outcome.USE, pathWorkspaceId, "path");
        }
        if (headerWorkspaceId != null) {
            return new Resolution(Outcome.USE, headerWorkspaceId, "header");
        }
        if (memberWorkspaceCount > 1) {
            return new Resolution(Outcome.REQUIRED, null, null);
        }
        return new Resolution(Outcome.USE, contextWorkspaceId, contextSource);
    }

}

