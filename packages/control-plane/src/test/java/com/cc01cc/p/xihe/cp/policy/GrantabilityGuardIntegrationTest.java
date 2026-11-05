package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0673 M1 acceptance (V1.1–V1.4, V4.1, T1.5): the grant-side subset guard against real
 * materialized grants. The guard is called from the service layer ({@code RoleAdminService.create/
 * update}, {@code BindingAdminService.replace}); these tests exercise the guard itself with the
 * same repositories/materializer the production write paths use, and pin the two-layer judgement:
 * role <b>definitions</b> are any-scope, <b>bindings</b> are target-scope (instance ⊇ workspace).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class GrantabilityGuardIntegrationTest extends AbstractIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private GrantabilityGuard guard;
    @Autowired private JdbcTemplate jdbcTemplate;

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    // V1.1 — role definition: atoms ⊆ caller held in ANY scope; over-subset ⇒ 403 + atom named.
    @Test
    void roleDefinitionJudgementIsAnyScopeAndNamesTheExceedingAtom() {
        User owner = newUser("guard-def");
        Workspace workspaceA = workspaceFixture.createOwnedWorkspace("guard-def-a", owner.getId().toString());
        actAs(owner);

        // WS_OWNER holds read/write/delete/exec (+ workspace N-atoms) somewhere ⇒ definition passes.
        guard.assertGrantable(Set.of("read", "write"), null);

        // `network` is not in WS_OWNER's set anywhere ⇒ rejected with the atom named.
        CpApiException denied = assertThrows(CpApiException.class,
                () -> guard.assertGrantable(Set.of("read", "network"), null));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatus());
        assertEquals("PRIVILEGE_ESCALATION", denied.getCode());
        assertTrue(denied.getMessage().contains("network"), denied.getMessage());
        assertTrue(jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs WHERE action ="
                        + " 'role_grant_guard_allowed' AND user_id = ?", Integer.class, owner.getId()) >= 1,
                "allowed guard decisions are audited");
        assertTrue(jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs WHERE action ="
                        + " 'role_grant_guard_denied' AND user_id = ?", Integer.class, owner.getId()) >= 1,
                "denied guard decisions are audited in an independent transaction");
        assertTrue(workspaceA != null);
    }

    // V1.2 — cross-workspace binding: the same atoms are fine in A, rejected in B (write not held in B).
    @Test
    void crossWorkspaceBindingIsRejectedAtTheTargetScope() {
        User owner = newUser("guard-cross");
        Workspace workspaceA = workspaceFixture.createOwnedWorkspace("guard-cross-a", owner.getId().toString());
        Workspace workspaceB = workspaceFixture.createWorkspace("guard-cross-b");
        actAs(owner);

        guard.assertGrantable(Set.of("read", "write"), AccessScope.workspace(workspaceA.getId()));

        CpApiException denied = assertThrows(CpApiException.class,
                () -> guard.assertGrantable(Set.of("read", "write"),
                        AccessScope.workspace(workspaceB.getId())));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatus());
        assertEquals("PRIVILEGE_ESCALATION", denied.getCode());
        assertTrue(denied.getMessage().contains("write"), "the missing atom is named: " + denied.getMessage());
    }

    // V1.3 — instance ⊇ workspace: an instance holder can bind in any workspace.
    @Test
    void instanceHolderMayBindInAnyWorkspace() {
        User holder = newUser("guard-instance");
        Workspace workspaceB = workspaceFixture.createWorkspace("guard-instance-b");
        bindInstanceRole(holder.getId(), SystemAccessRoleCatalog.USER);
        actAs(holder);

        guard.assertGrantable(Set.of("read", "write"),
                AccessScope.workspace(workspaceB.getId()));
    }

    // V1.4 — workspace ⊉ instance: a workspace holder cannot bind at instance scope.
    @Test
    void workspaceHolderMayNotBindAtInstanceScope() {
        User owner = newUser("guard-ws-only");
        workspaceFixture.createOwnedWorkspace("guard-ws-only-a", owner.getId().toString());
        actAs(owner);

        CpApiException denied = assertThrows(CpApiException.class,
                () -> guard.assertGrantable(Set.of("write"), AccessScope.instance()));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatus());
        assertEquals("PRIVILEGE_ESCALATION", denied.getCode());
        assertTrue(denied.getMessage().contains("write"), denied.getMessage());
    }

    // V4.1 — the subset gate answers 403 (grantor lacks the atom); the target-cap gate stays 409
    // (BL-287, asserted by AgentPrincipalRoleBindingContractTest#bindingAtomsOutsideTheCapIsRefused…).
    @Test
    void subsetDenialIsForbiddenNotConflict() {
        User plain = newUser("guard-plain");
        actAs(plain);
        CpApiException denied = assertThrows(CpApiException.class,
                () -> guard.assertGrantable(Set.of("read"), AccessScope.instance()));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatus());
        assertEquals("PRIVILEGE_ESCALATION", denied.getCode());
    }

    private void actAs(User user) {
        TenantContext.setUserId(user.getId().toString());
    }

    private void bindInstanceRole(UUID userId, String roleName) {
        UUID roleId = accessRoleRepository.findByName(roleName).orElseThrow().getId();
        bindingRepository.save(new AccessRoleBinding(roleId, "user", userId,
                AccessScope.INSTANCE, null, userId));
        materializer.materializeSubject("user", userId, userId, null);
    }

    private User newUser(String prefix) {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        return userRepository.saveAndFlush(new User(
                prefix + "-" + suffix + "@test.local", "hash", prefix, prefix + suffix));
    }
}
