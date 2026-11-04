package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0651 T1.5 (A1, Lead requirement): <b>equivalence evidence</b> for the shared kernel entry.
 *
 * <p>The refactor replaced {@code AgentPrincipalService#requireUserAction}'s local
 * "read scoped grants + {@code evaluator.allows}" sequence with
 * {@link RequesterAuthority#allowsForUser}. "Pure equivalence" is only a claim until both
 * implementations run on the same request, so {@link #legacyAllows} keeps the pre-refactor sequence
 * verbatim and every case asserts the same answer — including the two dimensions a naive
 * {@code holdsActionAtom} mapping would have lost: <b>resource wildcards</b> and <b>tool shape</b>.</p>
 */
class RequesterAuthorityAllowsForUserEquivalenceTest {

    private static final UUID WORKSPACE = UUID.randomUUID();
    private static final String USER_ID = "22222222-2222-4222-8222-222222222222";
    private static final com.fasterxml.jackson.databind.ObjectMapper JSON =
            new com.fasterxml.jackson.databind.ObjectMapper();

    private final GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();
    private AuthorizationGrantRepository grants;
    private RequesterAuthority authority;

    @BeforeEach
    void setUp() {
        grants = mock(AuthorizationGrantRepository.class);
        authority = new RequesterAuthority(grants, evaluator, mock(AuthzContext.class));
    }

    /** The pre-A1 implementation, verbatim, so both sides evaluate the same request. */
    private boolean legacyAllows(PolicyRequest request, UUID workspaceId) {
        return evaluator.allows(request, List.of(evaluator.union(
                grants.findScopedGrants(GrantPrincipalPathResolver.USER,
                        UUID.fromString(request.userId()),
                        GrantSources.EVALUATION_SOURCES, workspaceId))));
    }

    private static AuthorizationGrant grant(String actionClass, String resource) {
        AuthorizationGrant grant = mock(AuthorizationGrant.class);
        String json = "[{\"actionClass\":\"" + actionClass + "\",\"resource\":\"" + resource + "\"}]";
        try {
            when(grant.getPermissions()).thenReturn(JSON.readTree(json));
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException("bad fixture json: " + json, e);
        }
        return grant;
    }

    private static PolicyRequest request(String actionClass, String resource, ToolShape shape) {
        return new PolicyRequest(actionClass.toLowerCase(), List.of(actionClass), List.of(resource),
                shape, USER_ID, null, null);
    }

    private void assertSameAsLegacy(String why, PolicyRequest request, List<AuthorizationGrant> rows) {
        when(grants.findScopedGrants(any(), any(), any(), any())).thenReturn(rows);
        boolean legacy = legacyAllows(request, WORKSPACE);
        boolean shared = authority.allowsForUser(request, WORKSPACE);
        assertEquals(legacy, shared, why + " — legacy=" + legacy + " shared=" + shared);
    }

    @Test
    void exactResourceGrantMatchesOnBothPaths() {
        String resource = "credential:" + UUID.randomUUID();
        assertSameAsLegacy("exact resource must allow on both",
                request(ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE, resource, ToolShape.OPAQUE),
                List.of(grant(ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE, resource)));
    }

    @Test
    void resourceWildcardIsCoveredOnBothPaths() {
        // The case a naive holdsActionAtom mapping would break: credential:* must authorize
        // credential:<uuid> only through LayeredPolicyResolver.matches.
        assertSameAsLegacy("credential:* wildcard",
                request(ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE, "credential:" + UUID.randomUUID(),
                        ToolShape.OPAQUE),
                List.of(grant(ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE, "credential:*")));
    }

    @Test
    void unrelatedGrantDeniesOnBothPaths() {
        assertSameAsLegacy("a grant for another atom must not authorize",
                request(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS, "*", ToolShape.OPAQUE),
                List.of(grant(ToolFaceRegistry.ACTION_CREDENTIAL_MANAGE, "credential:*")));
    }

    @Test
    void emptyGrantSetDeniesOnBothPaths() {
        assertSameAsLegacy("no grants ⇒ deny",
                request(ToolFaceRegistry.ACTION_OWN_AGENT, "*", ToolShape.OPAQUE), List.of());
    }

    @Test
    void unknownAtomInTheGrantRowFailsTheSameWayOnBothPaths() {
        List<AuthorizationGrant> rows = List.of(grant("NOT_A_REAL_ATOM", "*"));
        when(grants.findScopedGrants(any(), any(), any(), any())).thenReturn(rows);
        PolicyRequest request = request(ToolFaceRegistry.ACTION_CREATE_ACCOUNT, "*", ToolShape.OPAQUE);

        assertThrows(IllegalArgumentException.class, () -> legacyAllows(request, WORKSPACE));
        assertThrows(IllegalArgumentException.class, () -> authority.allowsForUser(request, WORKSPACE));
    }

    @Test
    void starGrantAgreesForEveryToolShape() {
        // Shape dimension: walk the whole enum instead of guessing which shapes the matcher
        // constrains; both sides must agree for each of them.
        List<AuthorizationGrant> rows = List.of(
                grant(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS, "*"));
        for (ToolShape shape : ToolShape.values()) {
            assertSameAsLegacy("shape " + shape,
                    request(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS, "*", shape), rows);
        }
    }

    @Test
    void instanceScopeIsExpressedByTheExplicitScopeArgument() {
        // The request carries a null workspace on purpose; the scope argument decides which grant
        // rows the kernel reads. Deriving the scope from the request would disagree here.
        List<AuthorizationGrant> rows = List.of(grant(ToolFaceRegistry.ACTION_CREATE_ACCOUNT, "*"));
        when(grants.findScopedGrants(any(), any(), any(), any())).thenReturn(rows);
        PolicyRequest instanceAction = request(ToolFaceRegistry.ACTION_CREATE_ACCOUNT, "*",
                ToolShape.OPAQUE);

        assertEquals(legacyAllows(instanceAction, null), authority.allowsForUser(instanceAction, null));
        assertEquals(legacyAllows(instanceAction, WORKSPACE),
                authority.allowsForUser(instanceAction, WORKSPACE));
    }
}
