package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0651 M3 T3.3 + D-165 (Lead ruling 2026-11-05): A13 reuses N9
 * {@code MANAGE_WORKSPACE_POLICY}, evaluated at <b>instance scope</b>.
 *
 * <p>The scope boundary is the whole point of the reuse: N9 is {@code scope_class=both}, so a
 * WS_OWNER's workspace-scoped N9 row must NOT satisfy the instance-scope query — otherwise A14's
 * workspace permission would leak into the instance tool-face face. This test runs against real
 * materialized grants (the same rows the production evaluation reads), not a mocked authority.</p>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ToolFaceAdminAtomScopeIntegrationTest extends AbstractReusableIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private RequesterAuthority requesterAuthority;

    @Test
    void workspaceScopedN9DoesNotAuthorizeTheInstanceFace() {
        User owner = newUser("toolface-scope-owner");
        Workspace workspace = workspaceFixture.createOwnedWorkspace("n9-scope", owner.getId().toString());

        // The fixture materializes the WS_OWNER binding: N9 exists as a workspace-scoped grant.
        assertTrue(requesterAuthority.holdsActionAtom(owner.getId(),
                        ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY, workspace.getId()),
                "WS_OWNER holds N9 inside its workspace");
        assertFalse(requesterAuthority.holdsActionAtom(owner.getId(),
                        ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY, null),
                "instance-scope evaluation must not see the workspace-scoped N9 row (A14 must not leak)");
    }

    @Test
    void adminInstanceN9AuthorizesTheInstanceFaceAndRoleAdministrationAfterV125() {
        User admin = newUser("toolface-scope-admin");
        UUID adminRoleId = accessRoleRepository.findByName(SystemAccessRoleCatalog.ADMIN)
                .orElseThrow().getId();
        bindingRepository.save(new AccessRoleBinding(adminRoleId, "user", admin.getId(),
                AccessScope.INSTANCE, null, admin.getId()));
        materializer.materializeSubject("user", admin.getId(), admin.getId(), null);

        assertTrue(requesterAuthority.holdsActionAtom(admin.getId(),
                        ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_POLICY, null),
                "ADMIN's instance N9 row authorizes the instance tool-face face (matrix S1)");
        // D-168 (user ruling 2026-11-05, migration V125): ADMIN now administers roles/bindings, so
        // MANAGE_ROLES is part of its materialized instance set. The delegation bound is enforced
        // by the subset guard (PLAN-0673 M1), not by absence of the atom — see
        // GrantabilityGuardIntegrationTest for the escalation counter-proofs.
        assertTrue(requesterAuthority.holdsActionAtom(admin.getId(),
                        ToolFaceRegistry.ACTION_MANAGE_ROLES, null),
                "ADMIN holds MANAGE_ROLES since V125 (D-168): role/binding administration is in scope");
        assertFalse(requesterAuthority.holdsActionAtom(admin.getId(),
                        ToolFaceRegistry.ACTION_GRANT_ANY_ATOM, null),
                "GRANT_ANY_ATOM stays SUPER_ADMIN-only (D-166): ADMIN must not hold the bypass");
    }

    private User newUser(String prefix) {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        return userRepository.saveAndFlush(new User(
                prefix + "-" + suffix + "@test.local", "hash", prefix, prefix + suffix));
    }
}
