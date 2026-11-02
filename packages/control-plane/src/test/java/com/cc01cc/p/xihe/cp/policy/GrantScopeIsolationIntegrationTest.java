package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0610 W1a T1.6 / V11: workspace scope isolation on a real (H2) schema.
 *
 * <p>Two workspaces, one membership each. A binding in workspace A must authorize inside A and
 * must <b>not</b> authorize inside B, and the materialized {@code grants} row must carry the
 * workspace id in {@code scope_id} so the isolation is visible in SQL rather than inferred from
 * the bindings. The instance-scope half of the predicate is checked in the same class: an
 * instance row participates in every workspace request.</p>
 *
 * <p>Also the negative side of design #23: binding an instance role that owns a capability atom
 * capability atoms) must leave those atoms out of {@code grants} while {@link AuthzContext}
 * reports the corresponding authority.</p>
 */
class GrantScopeIsolationIntegrationTest extends AbstractH2Test {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private AccessRoleRepository accessRoleRepository;

    @Autowired
    private AccessRoleBindingRepository bindingRepository;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private RoleGrantMaterializer materializer;

    @Autowired
    private GrantAuthorizationService grantAuthorizationService;

    @Autowired
    private AuthzContext authzContext;

    @Test
    void workspaceBindingInADoesNotAuthorizeB() {
        Fixture fixture = fixture("isolation");
        UUID editorRoleId = accessRoleRepository.findByName(SystemAccessRoleCatalog.WS_EDITOR)
                .orElseThrow().getId();
        bindingRepository.save(new AccessRoleBinding(editorRoleId, "user", fixture.userId(),
                AccessScope.WORKSPACE, fixture.workspaceA(), fixture.userId()));
        materializer.materializeSubject("user", fixture.userId(), fixture.userId(), null);

        assertTrue(grantAuthorizationService.allowsUserOnly(
                        request("read", "notes/today.md", fixture.userId(), fixture.workspaceA())),
                "WS_EDITOR in workspace A authorizes a read inside A");
        assertFalse(grantAuthorizationService.allowsUserOnly(
                        request("read", "notes/today.md", fixture.userId(), fixture.workspaceB())),
                "the same binding must not authorize workspace B (V11)");

        List<AuthorizationGrant> roleRows = grantRepository
                .findBySubjectTypeAndSubjectIdAndSource("user", fixture.userId(),
                        GrantSources.ROLE);
        assertEquals(4, roleRows.size(), "WS_EDITOR materializes read/write/delete/exec");
        roleRows.forEach(row -> {
            assertEquals("workspace", row.getScopeType());
            assertEquals(fixture.workspaceA(), row.getScopeId(),
                    "the scope is visible in SQL, not only in the binding table");
        });
        assertTrue(grantRepository.findScopedGrants("user", fixture.userId(),
                        GrantSources.EVALUATION_SOURCES, fixture.workspaceB()).isEmpty(),
                "B sees none of A's materialized rows");
        assertEquals(4, grantRepository.findScopedGrants("user", fixture.userId(),
                GrantSources.EVALUATION_SOURCES, fixture.workspaceA()).size());
    }

    @Test
    void instanceScopeRowsParticipateInEveryWorkspaceRequest() {
        Fixture fixture = fixture("instance");
        // The tenant gate requires membership; viewer bindings keep the workspace-scope atom set
        // minimal (read only) so the instance-row count stays the subject of the assertion.
        workspaceFixture.bindWorkspaceRole(fixture.workspaceA().toString(),
                fixture.userId().toString(), WorkspaceRole.VIEWER);
        workspaceFixture.bindWorkspaceRole(fixture.workspaceB().toString(),
                fixture.userId().toString(), WorkspaceRole.VIEWER);
        UUID userRoleId = accessRoleRepository.findByName(SystemAccessRoleCatalog.USER)
                .orElseThrow().getId();
        bindingRepository.save(new AccessRoleBinding(userRoleId, "user", fixture.userId(),
                AccessScope.INSTANCE, null, fixture.userId()));
        materializer.materializeSubject("user", fixture.userId(), fixture.userId(), null);

        assertTrue(grantAuthorizationService.allowsUserOnly(
                        request("read", "notes/a.md", fixture.userId(), fixture.workspaceA())),
                "instance-scope rows always participate");
        assertTrue(grantAuthorizationService.allowsUserOnly(
                        request("write", "notes/b.md", fixture.userId(), fixture.workspaceB())),
                "and they participate in a second workspace request too");
        assertFalse(grantAuthorizationService.allowsUserOnly(
                        request("credential_use", "credential:" + UUID.randomUUID(),
                                fixture.userId(), fixture.workspaceA())),
                "the instance USER role carries no credential atom");
        // PLAN-0622 D8: the USER default set is the five registration atoms plus
        // CREATE_OWN_AGENT (an ordinary account may create its own PERSONAL agent). The count is
        // derived from the code-side role seed so the next atom does not silently re-break it.
        assertEquals(seedAtomCount(SystemAccessRoleCatalog.USER), grantRepository.findScopedGrants(
                        "user", fixture.userId(), GrantSources.EVALUATION_SOURCES, fixture.workspaceB()).stream()
                        .filter(row -> AccessScope.INSTANCE.equals(row.getScopeType()))
                        .count(),
                "one row per USER action atom, all instance-scoped");
    }

    /** All atoms of one seeded system role (the code-side catalog is the single source of truth). */
    private static long seedAtomCount(String roleName) {
        return SystemAccessRoleCatalog.roleSeeds().stream()
                .filter(seed -> roleName.equals(seed.name()))
                .findFirst()
                .orElseThrow()
                .atoms().size();
    }

    @Test
    void superAdminInstanceBindingMaterializesAllActionAtomsButNoCapabilityAtoms() {
        Fixture fixture = fixture("capability");
        // Decision #27: SUPER_ADMIN is an instance role and all action atoms are bindable in
        // the instance scope (only the 3 capability atoms are filtered out of the materialization).
        UUID superRoleId = accessRoleRepository.findByName(SystemAccessRoleCatalog.SUPER_ADMIN)
                .orElseThrow().getId();
        AccessRoleBinding binding = bindingRepository.save(new AccessRoleBinding(superRoleId, "user",
                fixture.userId(), AccessScope.INSTANCE, null, fixture.userId()));
        materializer.materializeSubject("user", fixture.userId(), fixture.userId(), null);

        List<AuthorizationGrant> rows = grantRepository
                .findBySubjectTypeAndSubjectIdAndSource("user", fixture.userId(), GrantSources.ROLE);
        assertEquals(PermissionAtomCatalog.actionAtoms().size(), rows.size(),
                "SUPER_ADMIN materializes its 15 action atoms (design #27 makes the workspace "
                        + "usage atoms instance-bindable)");
        for (AuthorizationGrant row : rows) {
            String atom = row.getPermissions().get(0).get("actionClass").asText();
            assertFalse(PermissionAtomCatalog.isCapabilityAtom(atom),
                    "capability atom reached grants: " + atom);
            assertTrue(ToolFaceRegistry.builtinActionClasses().contains(atom),
                    "every materialized atom must be evaluable: " + atom);
        }
        assertTrue(authzContext.isInstanceSuper(fixture.userId()),
                "the same binding resolves cap:instance:super at authentication time");
        assertTrue(authzContext.isInstanceAdmin(fixture.userId()));
        assertTrue(authzContext.canWorkspaceAdmin(fixture.userId(), fixture.workspaceA()),
                "SUPER_ADMIN owns workspace:admin at instance scope (every workspace)");
        assertTrue(authzContext.canWorkspaceAdmin(fixture.userId(), fixture.workspaceB()));

        bindingRepository.delete(binding);
        materializer.materializeSubject("user", fixture.userId(), fixture.userId(), null);
        assertTrue(grantRepository.findBySubjectTypeAndSubjectIdAndSource("user", fixture.userId(),
                GrantSources.ROLE).isEmpty(), "losing the binding clears the materialized rows");
        assertFalse(authzContext.isInstanceSuper(fixture.userId()),
                "the materializer invalidates the capability cache for user subjects");
    }

    @Test
    void instanceOnlyAtomsCannotBeBoundInAWorkspace() {
        Fixture fixture = fixture("mismatch");
        UUID adminRoleId = accessRoleRepository.findByName(SystemAccessRoleCatalog.ADMIN)
                .orElseThrow().getId();
        bindingRepository.save(new AccessRoleBinding(adminRoleId, "user", fixture.userId(),
                AccessScope.WORKSPACE, fixture.workspaceA(), fixture.userId()));

        com.cc01cc.p.xihe.cp.config.CpApiException failure = org.junit.jupiter.api.Assertions
                .assertThrows(com.cc01cc.p.xihe.cp.config.CpApiException.class,
                        () -> materializer.materializeSubject("user", fixture.userId(),
                                fixture.userId(), null));
        assertEquals("ROLE_SCOPE_MISMATCH", failure.getCode(),
                "V14 / decision #27: instance-only atoms (instance:admin) in a workspace binding");
        assertTrue(grantRepository.findBySubjectTypeAndSubjectIdAndSource("user", fixture.userId(),
                GrantSources.ROLE).isEmpty(), "nothing is materialized when validation fails");
    }

    // ---------------------------------------------------------------- helpers

    private record Fixture(UUID userId, UUID workspaceA, UUID workspaceB) {
    }

    private Fixture fixture(String tag) {
        User user = userRepository.save(new User("scope-" + tag + "-" + UUID.randomUUID()
                + "@test.local", "hash", "Scope " + tag));
        // No membership is seeded: each test writes exactly the binding it studies (V89: a binding
        // is the only membership fact, so a bare workspace here is a workspace with no members).
        Workspace workspaceA = workspaceFixture.createWorkspace("scope-" + tag + "-a");
        Workspace workspaceB = workspaceFixture.createWorkspace("scope-" + tag + "-b");
        return new Fixture(user.getId(), workspaceA.getId(), workspaceB.getId());
    }

    private static PolicyRequest request(String actionClass, String resource, UUID userId,
                                         UUID workspaceId) {
        return new PolicyRequest("probe_tool", List.of(actionClass), List.of(resource),
                ToolShape.STRUCTURED, userId.toString(), workspaceId.toString(), null);
    }
}



