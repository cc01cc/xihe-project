package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.service.SessionReadService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * D-1865 requirement 2, decision-layer half: admitting a cross-principal chain must not lift the
 * leaf above an ancestor's frozen cap.
 *
 * <p>{@link GrantAuthorizationService#allows} builds the ceiling as
 * <em>leaf grants &cup; leaf Workspace binding cap &cap; every Session snapshot on the path</em>
 * ({@code GrantIntersectionEvaluator.allows} refuses when ANY set in the path lacks the atom). This
 * class pins that the relaxation changes the PATH and never the INTERSECTION: the delegated leaf
 * holds {@code network} in all three of its own layers and is still denied, while the same leaf on
 * a path without that ancestor is allowed.</p>
 *
 * <p>It complements {@code CrossPrincipalDelegationCapIntegrationTest} (real rows, real DB) with a
 * wiring-level proof that does not depend on the context-reuse bucketing gate.</p>
 */
class CrossPrincipalCapIntersectionTest {

    private static final String READ = ToolFaceRegistry.ACTION_READ;
    private static final String WRITE = ToolFaceRegistry.ACTION_WRITE;
    private static final String NETWORK = ToolFaceRegistry.ACTION_NETWORK;
    private static final UUID USER_ID = UUID.fromString("55555555-5555-4555-8555-555555555555");
    private static final UUID WORKSPACE_ID = UUID.fromString("66666666-6666-4666-8666-666666666666");
    private static final UUID LEAF = UUID.fromString("77777777-7777-4777-8777-777777777777");
    private static final UUID ANCESTOR = UUID.fromString("88888888-8888-4888-8888-888888888888");

    private final ObjectMapper objectMapper = new ObjectMapper();

    /** Everything the leaf owns carries network; only {@code ancestorCap} may refuse it. */
    private GrantAuthorizationService serviceWith(boolean withAncestor, ArrayNode ancestorCap) {
        AuthorizationGrantRepository grants = mock(AuthorizationGrantRepository.class);
        when(grants.findScopedGrants(eq(GrantPrincipalPathResolver.AGENT_PRINCIPAL), eq(LEAF),
                any(), any())).thenReturn(List.of(grant(atoms(READ, WRITE, NETWORK))));

        AgentPrincipalRepository principals = mock(AgentPrincipalRepository.class);
        AgentPrincipal leaf = new AgentPrincipal();
        leaf.setId(LEAF);
        when(principals.findById(LEAF)).thenReturn(Optional.of(leaf));

        WorkspaceAgentRepository bindings = mock(WorkspaceAgentRepository.class);
        when(bindings.findById(any())).thenReturn(
                Optional.of(new WorkspaceAgent(LEAF.toString(), WORKSPACE_ID.toString(),
                        atoms(READ, WRITE, NETWORK))));

        WorkspaceRepository workspaces = mock(WorkspaceRepository.class);
        Workspace workspace = new Workspace();
        workspace.setId(WORKSPACE_ID);
        when(workspaces.findByIdAndDeletedAtIsNull(WORKSPACE_ID)).thenReturn(Optional.of(workspace));

        List<SessionReadService.SessionPathView> path = new java.util.ArrayList<>();
        if (withAncestor) {
            path.add(session(UUID.randomUUID(), ANCESTOR, ancestorCap));
        }
        path.add(session(UUID.randomUUID(), LEAF, atoms(READ, WRITE, NETWORK)));
        GrantPrincipalPathResolver resolver = mock(GrantPrincipalPathResolver.class);
        when(resolver.resolveAgent(USER_ID.toString(), WORKSPACE_ID.toString(), "session-leaf"))
                .thenReturn(new GrantPrincipalPathResolver.AgentPath(LEAF, List.copyOf(path)));

        return new GrantAuthorizationService(grants, principals, bindings, resolver,
                new GrantIntersectionEvaluator(), workspaces, mock(WorkspaceMembershipService.class));
    }

    @Test
    void theAncestorSnapshotCeilingSurvivesThePrincipalEqualityRelaxation() {
        GrantAuthorizationService chained = serviceWith(true, atoms(READ, WRITE));

        assertTrue(chained.allows(request(READ)), "every layer carries read, so read is allowed");
        assertTrue(chained.allows(request(WRITE)), "every layer carries write, so write is allowed");
        assertFalse(chained.allows(request(NETWORK)),
                "D-1865 requirement 2: the delegated leaf holds network in its own grants, its own "
                        + "Workspace binding cap and its own Session snapshot, and is still refused "
                        + "by the ANCESTOR snapshot - admitting the chain does not raise its ceiling");
    }

    /** Non-vacuity: the denial above is the ancestor deciding, not a missing leaf layer. */
    @Test
    void withoutTheAncestorTheVerySameLeafIsAllowedTheWiderAtom() {
        GrantAuthorizationService alone = serviceWith(false, null);
        assertTrue(alone.allows(request(NETWORK)),
                "the leaf's own three layers all carry network, so the chain layer is what refused it");
    }

    /** A malformed chain (the clauses resolveAgent still fails closed on) must deny, not allow. */
    @Test
    void aRejectedCrossPrincipalPathStillFailsClosedToDeny() {
        GrantPrincipalPathResolver resolver = mock(GrantPrincipalPathResolver.class);
        when(resolver.resolveAgent(any(), any(), any()))
                .thenThrow(new IllegalArgumentException("Session principal path is invalid"));
        AuthorizationGrantRepository grants = mock(AuthorizationGrantRepository.class);
        GrantAuthorizationService service = new GrantAuthorizationService(grants,
                mock(AgentPrincipalRepository.class), mock(WorkspaceAgentRepository.class), resolver,
                new GrantIntersectionEvaluator(), mock(WorkspaceRepository.class),
                mock(WorkspaceMembershipService.class));

        assertFalse(service.allows(request(NETWORK)),
                "cross-user / cross-workspace / broken-lineage chains keep denying after the fix");
    }

    private static PolicyRequest request(String actionClass) {
        return new PolicyRequest("write_file", List.of(actionClass), List.of("src/main.java"),
                ToolShape.STRUCTURED, USER_ID.toString(), WORKSPACE_ID.toString(), "session-leaf");
    }

    private static SessionReadService.SessionPathView session(UUID id, UUID principalId,
                                                              ArrayNode cap) {
        return new SessionReadService.SessionPathView(id, USER_ID.toString(), WORKSPACE_ID.toString(),
                principalId.toString(), null, null, null, null, cap);
    }

    private static AuthorizationGrant grant(ArrayNode permissions) {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSubjectType(GrantPrincipalPathResolver.AGENT_PRINCIPAL);
        grant.setSource(GrantSources.ROLE);
        grant.setPermissions(permissions);
        return grant;
    }

    private ArrayNode atoms(String... actionClasses) {
        ArrayNode permissions = objectMapper.createArrayNode();
        for (String actionClass : actionClasses) {
            ObjectNode atom = objectMapper.createObjectNode();
            atom.put("actionClass", actionClass);
            atom.put("resource", "*");
            permissions.add(atom);
        }
        return permissions;
    }
}
