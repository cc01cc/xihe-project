package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.GrantPresetBinding;
import com.cc01cc.p.xihe.cp.entity.GrantPresetAtom;
import com.cc01cc.p.xihe.cp.repository.GrantPresetBindingRepository;
import com.cc01cc.p.xihe.cp.repository.GrantPresetAtomRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0610 W1a T1.15 / round-2 P1-4: capability atoms become authorities at authentication time.
 *
 * <p>Pins the three rules of the contract: instance-scope {@code instance:super}/{@code
 * instance:admin} become global authorities ({@code cap:<atom>}), {@code workspace:admin} is a
 * per-workspace service-level question and never a global authority, and a workspace-scoped
 * instance capability cannot elevate (defensive negative for a corrupt row).</p>
 */
class AuthzContextTest {

    private static final UUID USER_ID = UUID.randomUUID();
    private static final UUID SUPER_ROLE = UUID.randomUUID();
    private static final UUID ADMIN_ROLE = UUID.randomUUID();
    private static final UUID WS_OWNER_ROLE = UUID.randomUUID();
    private static final UUID WORKSPACE_A = UUID.randomUUID();
    private static final UUID WORKSPACE_B = UUID.randomUUID();

    private GrantPresetBindingRepository bindingRepository;
    private GrantPresetAtomRepository permissionRepository;

    @BeforeEach
    void setUp() {
        bindingRepository = mock(GrantPresetBindingRepository.class);
        permissionRepository = mock(GrantPresetAtomRepository.class);
    }

    private AuthzContext context(long ttlMs) {
        return new AuthzContext(bindingRepository, permissionRepository, ttlMs);
    }

    private void stub(List<GrantPresetBinding> bindings, GrantPresetAtom... permissions) {
        when(bindingRepository.findBySubjectTypeAndSubjectId("user", USER_ID)).thenReturn(bindings);
        when(permissionRepository.findByIdRoleIdIn(anyCollection())).thenReturn(List.of(permissions));
    }

    private static GrantPresetAtom capability(UUID roleId, String atom) {
        return new GrantPresetAtom(roleId, atom, "*");
    }

    private static GrantPresetAtom action(UUID roleId, String atom) {
        return new GrantPresetAtom(roleId, atom, "*");
    }

    @Test
    void instanceScopeCapabilitiesBecomeGlobalAuthorities() {
        stub(List.of(new GrantPresetBinding(SUPER_ROLE, "user", USER_ID, "instance", null, null)),
                capability(SUPER_ROLE, PermissionAtomCatalog.CAP_INSTANCE_SUPER),
                capability(SUPER_ROLE, PermissionAtomCatalog.CAP_INSTANCE_ADMIN),
                action(SUPER_ROLE, ToolFaceRegistry.ACTION_READ));

        AuthzContext authz = context(60_000);
        assertTrue(authz.isInstanceSuper(USER_ID));
        assertTrue(authz.isInstanceAdmin(USER_ID));
        assertTrue(authz.authoritiesFor(USER_ID).contains("cap:instance:super"));
        assertTrue(authz.authoritiesFor(USER_ID).contains("cap:instance:admin"));
        assertFalse(authz.authoritiesFor(USER_ID).contains("cap:workspace:admin"),
                "workspace:admin is never a global authority (P1-4)");
        assertFalse(authz.authoritiesFor(USER_ID).contains("cap:read"),
                "action atoms are not authorities; they stay in grants");
    }

    @Test
    void workspaceAdminBoundAtInstanceScopeCoversEveryWorkspace() {
        stub(List.of(new GrantPresetBinding(WS_OWNER_ROLE, "user", USER_ID, "instance", null, null)),
                capability(WS_OWNER_ROLE, PermissionAtomCatalog.CAP_WORKSPACE_ADMIN),
                action(WS_OWNER_ROLE, ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS));

        AuthzContext authz = context(60_000);
        assertTrue(authz.canWorkspaceAdmin(USER_ID, WORKSPACE_A));
        assertTrue(authz.canWorkspaceAdmin(USER_ID, WORKSPACE_B));
        assertTrue(authz.authoritiesFor(USER_ID).isEmpty(),
                "scope_class=both at instance scope stays a service-level answer, not an authority");
        assertFalse(authz.isInstanceAdmin(USER_ID),
                "workspace:admin at instance scope must not become instance admin");
    }

    @Test
    void workspaceScopeCapabilityOnlyCoversThatWorkspace() {
        stub(List.of(new GrantPresetBinding(WS_OWNER_ROLE, "user", USER_ID, "workspace",
                        WORKSPACE_A, null)),
                capability(WS_OWNER_ROLE, PermissionAtomCatalog.CAP_WORKSPACE_ADMIN));

        AuthzContext authz = context(60_000);
        assertTrue(authz.canWorkspaceAdmin(USER_ID, WORKSPACE_A));
        assertFalse(authz.canWorkspaceAdmin(USER_ID, WORKSPACE_B),
                "a workspace-scoped capability cannot reach another workspace");
        assertTrue(authz.authoritiesFor(USER_ID).isEmpty());
    }

    @Test
    void corruptWorkspaceScopedInstanceCapabilityDoesNotElevate() {
        stub(List.of(new GrantPresetBinding(ADMIN_ROLE, "user", USER_ID, "workspace",
                        WORKSPACE_A, null)),
                capability(ADMIN_ROLE, PermissionAtomCatalog.CAP_INSTANCE_ADMIN));

        AuthzContext authz = context(60_000);
        assertFalse(authz.isInstanceAdmin(USER_ID),
                "an instance capability granted from a workspace binding is ignored (fail-closed)");
        assertTrue(authz.authoritiesFor(USER_ID).isEmpty());
    }

    @Test
    void cachedSnapshotIsReusedAndInvalidatedOnChange() {
        stub(List.of(new GrantPresetBinding(SUPER_ROLE, "user", USER_ID, "instance", null, null)),
                capability(SUPER_ROLE, PermissionAtomCatalog.CAP_INSTANCE_ADMIN));

        AuthzContext authz = context(60_000);
        assertTrue(authz.isInstanceAdmin(USER_ID));
        assertTrue(authz.isInstanceAdmin(USER_ID));
        verify(bindingRepository, times(1)).findBySubjectTypeAndSubjectId("user", USER_ID);

        authz.invalidate(USER_ID);
        assertTrue(authz.isInstanceAdmin(USER_ID));
        verify(bindingRepository, times(2)).findBySubjectTypeAndSubjectId("user", USER_ID);
    }

    @Test
    void zeroTtlAlwaysReResolves() {
        stub(List.of(new GrantPresetBinding(SUPER_ROLE, "user", USER_ID, "instance", null, null)),
                capability(SUPER_ROLE, PermissionAtomCatalog.CAP_INSTANCE_ADMIN));

        AuthzContext authz = context(0);
        assertTrue(authz.isInstanceAdmin(USER_ID));
        assertTrue(authz.isInstanceAdmin(USER_ID));
        verify(bindingRepository, times(2)).findBySubjectTypeAndSubjectId("user", USER_ID);
    }

    @Test
    void subjectWithoutBindingsHasNoCapabilities() {
        when(bindingRepository.findBySubjectTypeAndSubjectId("user", USER_ID)).thenReturn(List.of());

        AuthzContext authz = context(60_000);
        assertFalse(authz.isInstanceAdmin(USER_ID));
        assertFalse(authz.canWorkspaceAdmin(USER_ID, WORKSPACE_A));
        assertTrue(authz.authoritiesFor(USER_ID).isEmpty());
    }
}
