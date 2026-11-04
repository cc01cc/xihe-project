package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0651 regression: a {@code null} workspace id in a {@link PolicyRequest} means
 * <b>instance-scope evaluation</b> (how the instance-only atoms N1/N10 are asked), not an error.
 *
 * <p>The first implementation passed the null straight into {@code UUID.fromString}, throwing an
 * {@link NullPointerException} that escaped {@code allowsUserOnly}'s {@code IllegalArgumentException}
 * handler and surfaced as an HTTP 500 on {@code GET /sessions/{id}/participants} (the participant
 * view capability is computed for every reader, member or not). Fail-closed + WARN is the fix; this
 * test pins it.</p>
 */
class GrantAuthorizationServiceNullWorkspaceTest {

    private static final String USER_ID = "11111111-1111-4111-8111-111111111111";

    private GrantAuthorizationService service(AuthorizationGrantRepository grants) {
        return new GrantAuthorizationService(grants,
                mock(AgentPrincipalRepository.class),
                mock(WorkspaceAgentRepository.class),
                mock(GrantPrincipalPathResolver.class),
                new GrantIntersectionEvaluator(),
                mock(WorkspaceRepository.class),
                mock(com.cc01cc.p.xihe.cp.policy.WorkspaceMembershipService.class));
    }

    private PolicyRequest instanceScopeRequest() {
        return new PolicyRequest("manage_session_participants_instance",
                List.of(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS), List.of("*"),
                ToolShape.OPAQUE, USER_ID, null, "session-1");
    }

    @Test
    void nullWorkspaceIsInstanceScopeAndDoesNotThrow() {
        AuthorizationGrantRepository grants = mock(AuthorizationGrantRepository.class);
        when(grants.findScopedGrants(any(), any(), any(), any())).thenReturn(List.of());
        GrantAuthorizationService service = service(grants);

        // Pre-fix this threw NullPointerException (escaped the catch) ⇒ HTTP 500.
        boolean allowed = assertDoesNotThrow(() -> service.allowsUserOnly(instanceScopeRequest()));
        // No materialized atom ⇒ fail closed.
        assertFalse(allowed);
    }

    @Test
    void blankOrMalformedWorkspaceStillFailsClosed() {
        AuthorizationGrantRepository grants = mock(AuthorizationGrantRepository.class);
        when(grants.findScopedGrants(any(), any(), any(), any())).thenReturn(List.of());
        GrantAuthorizationService service = service(grants);

        PolicyRequest malformed = new PolicyRequest("manage_session_participants_instance",
                List.of(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS), List.of("*"),
                ToolShape.OPAQUE, USER_ID, "not-a-uuid", "session-1");
        assertFalse(assertDoesNotThrow(() -> service.allowsUserOnly(malformed)));
    }

    @Test
    void nullRequestStillRefused() {
        AuthorizationGrantRepository grants = mock(AuthorizationGrantRepository.class);
        assertFalse(service(grants).allowsUserOnly(null));
    }

    @Test
    void workspaceScopedRequestStillRequiresMembership() {
        AuthorizationGrantRepository grants = mock(AuthorizationGrantRepository.class);
        when(grants.findScopedGrants(any(), any(), any(), any())).thenReturn(List.of());
        WorkspaceRepository workspaces = mock(WorkspaceRepository.class);
        when(workspaces.findByIdAndDeletedAtIsNull(any())).thenReturn(Optional.empty());
        WorkspaceMembershipService memberships = mock(WorkspaceMembershipService.class);
        GrantAuthorizationService service = new GrantAuthorizationService(grants,
                mock(AgentPrincipalRepository.class),
                mock(WorkspaceAgentRepository.class),
                mock(GrantPrincipalPathResolver.class),
                new GrantIntersectionEvaluator(),
                workspaces,
                memberships);

        PolicyRequest workspaceScoped = new PolicyRequest("manage_session_participants",
                List.of(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS), List.of("*"),
                ToolShape.OPAQUE, USER_ID, UUID.randomUUID().toString(), "session-1");
        assertFalse(assertDoesNotThrow(() -> service.allowsUserOnly(workspaceScoped)));
    }
}
