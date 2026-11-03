package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0625 task-86: one-shot dependency-graph fixtures for {@link AgentPrincipalService} tests.
 *
 * <p>Background: the preset-guard refusal test (task-83/F) hand-stacked a four-layer mock graph
 * (userExists → workspaceMember → MANAGE atom → empty grants) discovered one gate at a time.
 * That graph is identical for every test that must drive the service past its authorization
 * gates, so it lives here once.</p>
 *
 * <p>Naming follows the existing {@code chat.ChatBindingTestSupport} precedent — support classes
 * sit in the same package as their consumers, no new directory tier.</p>
 */
public final class AgentPrincipalTestSupport {

    private AgentPrincipalTestSupport() {
    }

    /** The live dependency graph plus a convenience constructor for the service under test. */
    public record Env(
            AgentPrincipalRepository principals,
            com.cc01cc.p.xihe.cp.auth.AuthService authService,
            WorkspaceService workspaceService,
            AuthorizationGrantRepository grants,
            GrantIntersectionEvaluator evaluator) {

        public AgentPrincipalService service() {
            return new AgentPrincipalService(principals, grants, authService, workspaceService,
                    mock(com.cc01cc.p.xihe.cp.policy.GrantDefaultService.class),
                    mock(WorkspaceAgentRepository.class), evaluator,
                    mock(com.cc01cc.p.xihe.cp.audit.AuditLogger.class),
                    new ObjectMapper(), mock(AgentTemplateService.class),
                    mock(com.cc01cc.p.xihe.cp.policy.AuthzContext.class),
                    // PLAN-0629: role bindings are the permission source, not the scope field.
                    mock(com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository.class),
                    mock(com.cc01cc.p.xihe.cp.repository.AccessRoleRepository.class),
                    mock(com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository.class),
                    mock(com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer.class));
        }
    }

    /**
     * Every gate up to the feature under test passes: the actor is an active user, a workspace
     * member, and holds the {@code MANAGE_WORKSPACE_AGENTS} atom.
     */
    public static Env workspaceManager() {
        Env env = baseEnv();
        when(env.evaluator().union(any())).thenReturn(Set.of(
                new GrantIntersectionEvaluator.PermissionAtom("MANAGE_WORKSPACE_AGENTS", "*")));
        return env;
    }

    /**
     * A plain member: {@code requireWorkspaceAgentManagement} stops here, so tests can assert
     * management-gate behavior without the manage atom leaking in.
     */
    public static Env workspaceMember() {
        Env env = baseEnv();
        when(env.evaluator().union(any())).thenReturn(Set.of());
        return env;
    }

    private static Env baseEnv() {
        AgentPrincipalRepository principals = mock(AgentPrincipalRepository.class);
        com.cc01cc.p.xihe.cp.auth.AuthService authService =
                mock(com.cc01cc.p.xihe.cp.auth.AuthService.class);
        when(authService.userExists(any())).thenReturn(true);
        WorkspaceService workspaceService = mock(WorkspaceService.class);
        when(workspaceService.isWorkspaceMember(any(), any())).thenReturn(true);
        AuthorizationGrantRepository grants = mock(AuthorizationGrantRepository.class);
        when(grants.findBySubjectTypeAndSubjectId(any(), any())).thenReturn(List.of());
        return new Env(principals, authService, workspaceService, grants,
                mock(GrantIntersectionEvaluator.class));
    }

    /** A user-created principal — every write path stays open. */
    public static AgentPrincipal activeUserPrincipal() {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setId(UUID.randomUUID());
        principal.setOrigin(AgentPrincipal.ORIGIN_USER);
        return principal;
    }

    /** The builtin guard preset — the target of the cap-immutability refusal. */
    public static AgentPrincipal presetGuard() {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setId(UUID.randomUUID());
        principal.setOrigin(AgentPrincipal.ORIGIN_SYSTEM_PRESET);
        principal.setPresetId("00000000-0000-4000-8000-0000000000a2");
        return principal;
    }
}
