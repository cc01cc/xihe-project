package com.cc01cc.p.xihe.cp.entity;

import java.util.function.Function;

/**
 * PLAN-0410 T1.3: entity-side hook that binds a root Branch id to rows whose
 * {@code branch_id} is still empty at persist time.
 *
 * <p>V43 makes {@code messages.branch_id}/{@code chat_runs.branch_id}/
 * {@code context_projections.branch_id} NOT NULL, but hundreds of existing
 * callers persist {@code new Message(...)} / {@code new ChatRun(...)} fixtures
 * directly. Instead of touching every call site, the entities lazily resolve
 * (and create when missing) the Session root Branch inside their lifecycle
 * callback. {@link com.cc01cc.p.xihe.cp.service.BranchPathService} registers
 * the resolver at startup; a missing registration fails loudly instead of
 * falling back to a silent guess.
 */
public final class RootBranchBinder {

    private static volatile Function<String, String> rootBranchResolver;

    private RootBranchBinder() {
    }

    public static void register(Function<String, String> resolver) {
        rootBranchResolver = resolver;
    }

    /**
     * Returns the Session root Branch id, creating the root row when absent.
     *
     * @throws IllegalStateException when no resolver is registered
     * @throws RuntimeException      when the root row cannot be read or written
     */
    public static String ensureRootBranchId(String sessionId) {
        Function<String, String> resolver = rootBranchResolver;
        if (resolver == null) {
            throw new IllegalStateException(
                    "RootBranchBinder is not initialized: BranchPathService is missing");
        }
        return resolver.apply(sessionId);
    }
}
