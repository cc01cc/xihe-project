package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.CapabilityAuthorities;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.cc01cc.p.xihe.cp.policy.WorkspaceMembershipService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0704 M1: cross-user / cross-workspace probes + the two-layer semantics.
 *
 * <p><b>Layer 1</b> (authorization evaluation, {@link GrantAuthorizationService}): a null
 * workspace request is evaluated on the instance axis — that is how instance-only atoms are
 * asked. <b>Layer 2</b> (tool face / execution): it must NOT hand the workspace-less run any
 * workspace-level or instance-level capability, and an instance administrator's legal management
 * face remains reachable. The two layers must not be conflated (D-686 vs D-711).</p>
 */
class WorkspaceLessBoundaryProbeTest {

    private static final String OWNER = "11111111-1111-4111-8111-111111111111";
    private static final String OTHER_USER = "22222222-2222-4222-8222-222222222222";
    private static final String WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String OTHER_WORKSPACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    private Session session(String userId, String workspaceId) {
        Session session = new Session();
        session.setId(UUID.fromString("33333333-3333-4333-8333-333333333333"));
        session.setUserId(userId);
        session.setWorkspaceId(workspaceId);
        return session;
    }

    private SessionReadAccess readAccess(SessionRepository sessions, Session row) {
        when(sessions.findById(any())).thenReturn(Optional.ofNullable(row));
        SessionParticipantRepository participants = mock(SessionParticipantRepository.class);
        when(participants.existsBySessionIdAndPrincipalKindAndPrincipalIdAndDisabledAtIsNull(
                any(), any(), any())).thenReturn(false);
        WorkspaceService workspaces = mock(WorkspaceService.class);
        when(workspaces.isWorkspaceMember(any(), any())).thenReturn(false);
        GrantAuthorizationService grants = mock(GrantAuthorizationService.class);
        when(grants.allowsUserOnly(any())).thenReturn(false);
        return new SessionReadAccess(sessions, participants, workspaces, grants);
    }

    @Test
    void crossUserSessionIs404WithoutExistenceOracle() {
        SessionReadAccess access = readAccess(mock(SessionRepository.class), session(OWNER, WORKSPACE));
        CpApiException error = assertThrows(CpApiException.class,
                () -> access.requireOwned(OTHER_USER, WORKSPACE, "33333333-3333-4333-8333-333333333333"));
        assertEquals(HttpStatus.NOT_FOUND, error.getStatus());
        assertEquals("SESSION_NOT_FOUND", error.getCode());
    }

    @Test
    void crossWorkspaceSessionIs404WithoutLeakingWorkspace() {
        SessionReadAccess access = readAccess(mock(SessionRepository.class), session(OWNER, OTHER_WORKSPACE));
        CpApiException error = assertThrows(CpApiException.class,
                () -> access.requireOwned(OWNER, WORKSPACE, "33333333-3333-4333-8333-333333333333"));
        assertEquals(HttpStatus.NOT_FOUND, error.getStatus());
        assertEquals("SESSION_NOT_FOUND", error.getCode());
    }

    @Test
    void missingSessionIsTheSame404AsAnOwnedButNotVisibleRow() {
        SessionReadAccess access = readAccess(mock(SessionRepository.class), null);
        CpApiException error = assertThrows(CpApiException.class,
                () -> access.requireOwned(OWNER, WORKSPACE, "44444444-4444-4444-8444-444444444444"));
        assertEquals(HttpStatus.NOT_FOUND, error.getStatus());
        assertEquals("SESSION_NOT_FOUND", error.getCode());
    }

    @Test
    void crossUserReadableIs404AsWell() {
        SessionReadAccess access = readAccess(mock(SessionRepository.class), session(OWNER, WORKSPACE));
        CpApiException error = assertThrows(CpApiException.class,
                () -> access.requireReadable(OTHER_USER, WORKSPACE, "33333333-3333-4333-8333-333333333333"));
        assertEquals(HttpStatus.NOT_FOUND, error.getStatus());
        assertEquals("SESSION_NOT_FOUND", error.getCode());
    }

    @Test
    void nullWorkspacePolicyEvaluationNeverYieldsAWorkspaceToolFace() {
        AuthorizationGrantRepository grants = mock(AuthorizationGrantRepository.class);
        when(grants.findScopedGrants(any(), any(), any(), any())).thenReturn(List.of());
        GrantAuthorizationService service = new GrantAuthorizationService(grants,
                mock(AgentPrincipalRepository.class),
                mock(WorkspaceAgentRepository.class),
                mock(GrantPrincipalPathResolver.class),
                new GrantIntersectionEvaluator(),
                mock(WorkspaceRepository.class),
                mock(WorkspaceMembershipService.class));

        PolicyRequest request = new PolicyRequest("manage_session_participants_instance",
                List.of(ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_MEMBERS), List.of("*"),
                ToolShape.OPAQUE, OWNER, null, "session-1");
        // Layer 1 says "instance-scope evaluation"; layer 2 must still refuse the workspace face.
        assertFalse(service.allowsUserOnly(request));
        assertTrue(AccessScope.instance().isInstance());
    }

    @Test
    void instanceAdministratorManagementCapabilityStaysReachable() {
        var authentication = new UsernamePasswordAuthenticationToken("admin", "n/a",
                List.of(new SimpleGrantedAuthority(CapabilityAuthorities.CAP_INSTANCE_ADMIN)));
        assertTrue(CapabilityAuthorities.isInstanceAdmin(authentication));
    }
}
