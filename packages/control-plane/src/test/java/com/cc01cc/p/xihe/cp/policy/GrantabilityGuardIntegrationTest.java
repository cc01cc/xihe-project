package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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
    @Autowired private AccessRolePermissionRepository accessRolePermissionRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private GrantabilityGuard guard;
    @Autowired private RequesterAuthority requesterAuthority;
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

    // V2.2/V2.4 (D-166) — the bypass atom skips the subset AND the audit records WHAT was skipped.
    @Test
    void grantAnyAtomBypassesTheSubsetAndAuditsTheSkippedAtoms() {
        User bypassHolder = newUser("guard-bypass");
        createInstanceRole("BYPASS_ONLY", List.of(ToolFaceRegistry.ACTION_GRANT_ANY_ATOM));
        bindInstanceRole(bypassHolder.getId(), "BYPASS_ONLY");
        actAs(bypassHolder);

        assertTrue(requesterAuthority.holdsActionAtom(bypassHolder.getId(),
                ToolFaceRegistry.ACTION_GRANT_ANY_ATOM, null), "the holder carries the bypass atom");
        // `write` is NOT held by this caller, yet the bypass lets the definition through.
        guard.assertGrantable(Set.of("write"), null);
        String detail = jdbcTemplate.queryForObject("SELECT details FROM audit_logs WHERE action ="
                + " 'role_grant_guard_bypassed' AND user_id = ? ORDER BY created_at DESC LIMIT 1",
                String.class, bypassHolder.getId());
        assertTrue(detail != null && detail.contains("bypass=true") && detail.contains("skipped=[write]"),
                "the bypass audit names exactly what was skipped: " + detail);
    }

    // V2.1/V2.3 + V3.1/V3.2 (D-166/D-168) — ADMIN holds MANAGE_ROLES, not the bypass atom.
    @Test
    void adminDelegatesWithinItsSubsetButCannotGrantTheBypassAtom() {
        User admin = newUser("guard-admin");
        bindInstanceRole(admin.getId(), SystemAccessRoleCatalog.ADMIN);
        actAs(admin);

        RequesterAuthority authority = requesterAuthority;
        assertTrue(authority.holdsActionAtom(admin.getId(),
                ToolFaceRegistry.ACTION_MANAGE_ROLES, null), "ADMIN holds MANAGE_ROLES since V125");
        assertFalse(authority.holdsActionAtom(admin.getId(),
                ToolFaceRegistry.ACTION_GRANT_ANY_ATOM, null), "ADMIN must not hold the bypass atom");

        guard.assertGrantable(Set.of("read"), null);
        CpApiException denied = assertThrows(CpApiException.class,
                () -> guard.assertGrantable(Set.of(ToolFaceRegistry.ACTION_GRANT_ANY_ATOM), null));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatus());
        assertEquals("PRIVILEGE_ESCALATION", denied.getCode());
        assertTrue(denied.getMessage().contains("GRANT_ANY_ATOM"), denied.getMessage());
    }

    // V2.2 — SUPER_ADMIN (V125 default holder) goes through the bypass branch, and even an
    // "all atoms held" request leaves an audit row (skipped=[] is still a bypass decision).
    @Test
    void superAdminGoesThroughTheBypassBranchAndItIsAudited() {
        User superAdmin = newUser("guard-super");
        bindInstanceRole(superAdmin.getId(), SystemAccessRoleCatalog.SUPER_ADMIN);
        actAs(superAdmin);

        assertTrue(requesterAuthority.holdsActionAtom(superAdmin.getId(),
                ToolFaceRegistry.ACTION_GRANT_ANY_ATOM, null), "SUPER_ADMIN holds the bypass atom");
        guard.assertGrantable(Set.of("read", "write"), null);
        Integer bypassed = jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs"
                + " WHERE action = 'role_grant_guard_bypassed' AND user_id = ?", Integer.class,
                superAdmin.getId());
        assertTrue(bypassed != null && bypassed >= 1, "the SUPER_ADMIN bypass is audited");
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

    private void createInstanceRole(String name, List<String> atoms) {
        AccessRole role = accessRoleRepository.saveAndFlush(new AccessRole(
                UUID.randomUUID(), name, name, null, false));
        for (String atom : atoms) {
            accessRolePermissionRepository.saveAndFlush(new AccessRolePermission(
                    role.getId(), atom, PermissionAtomCatalog.atom(atom).canonicalResource()));
        }
    }

    private User newUser(String prefix) {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        return userRepository.saveAndFlush(new User(
                prefix + "-" + suffix + "@test.local", "hash", prefix, prefix + suffix));
    }
}
