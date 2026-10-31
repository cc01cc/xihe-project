package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * PLAN-0608 C′ (M1): the ownership resolution matrix. Pure unit test so the
 * "three sources + conflict + B-narrow three states" contract is pinned without
 * a Spring context.
 */
class SessionWorkspaceResolverTest {

    private static final String TARGET = "22222222-2222-4222-8222-222222222222";
    private static final String FALLBACK = "11111111-1111-4111-8111-111111111111";

    @Test
    void pathFormWinsAndIsLabelledPath() {
        SessionWorkspaceResolver.Resolution r =
                SessionWorkspaceResolver.resolve(TARGET, null, -1, FALLBACK, "default");

        assertEquals(SessionWorkspaceResolver.Outcome.USE, r.outcome());
        assertEquals(TARGET, r.workspaceId());
        assertEquals("path", r.source());
    }

    @Test
    void headerIsUsedWhenNoPath() {
        SessionWorkspaceResolver.Resolution r =
                SessionWorkspaceResolver.resolve(null, TARGET, -1, TARGET, "header");

        assertEquals(SessionWorkspaceResolver.Outcome.USE, r.outcome());
        assertEquals(TARGET, r.workspaceId());
        assertEquals("header", r.source());
    }

    @Test
    void identicalPathAndHeaderAreNotAConflict() {
        SessionWorkspaceResolver.Resolution r =
                SessionWorkspaceResolver.resolve(TARGET, TARGET.toUpperCase(), -1, TARGET, "header");

        assertEquals(SessionWorkspaceResolver.Outcome.USE, r.outcome());
        assertEquals(TARGET, r.workspaceId());
        assertEquals("path", r.source());
    }

    @Test
    void differentPathAndHeaderIsAConflict() {
        SessionWorkspaceResolver.Resolution r =
                SessionWorkspaceResolver.resolve(TARGET, FALLBACK, -1, FALLBACK, "header");

        assertEquals(SessionWorkspaceResolver.Outcome.CONFLICT, r.outcome());
        assertNull(r.workspaceId());
    }

    @Test
    void noInputWithSeveralMemberWorkspacesRequiresExplicitChoice() {
        SessionWorkspaceResolver.Resolution r =
                SessionWorkspaceResolver.resolve(null, null, 2, FALLBACK, "default");

        assertEquals(SessionWorkspaceResolver.Outcome.REQUIRED, r.outcome());
        assertNull(r.workspaceId());
    }

    @Test
    void noInputWithASingleMemberWorkspaceKeepsTheFallback() {
        SessionWorkspaceResolver.Resolution r =
                SessionWorkspaceResolver.resolve(null, null, 1, FALLBACK, "default");

        assertEquals(SessionWorkspaceResolver.Outcome.USE, r.outcome());
        assertEquals(FALLBACK, r.workspaceId());
        assertEquals("default", r.source());
    }

    @Test
    void noInputWithoutAnyWorkspaceDefersToTheDownstream401() {
        SessionWorkspaceResolver.Resolution r =
                SessionWorkspaceResolver.resolve(null, null, 0, null, null);

        assertEquals(SessionWorkspaceResolver.Outcome.USE, r.outcome());
        assertNull(r.workspaceId());
    }

    @Test
    void explicitPathSkipsTheMemberCountQuery() {
        // -1 means "caller did not query"; the path must win regardless.
        SessionWorkspaceResolver.Resolution r =
                SessionWorkspaceResolver.resolve(TARGET, null, -1, null, null);

        assertEquals(SessionWorkspaceResolver.Outcome.USE, r.outcome());
        assertEquals(TARGET, r.workspaceId());
    }
}
