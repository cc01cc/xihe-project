package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
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
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0673 M1 — role definition updates must not escalate through an existing binding's scope.
 *
 * <p>The defect: {@code RoleAdminService.update} used an any-scope definition judgement and then
 * {@code RoleGrantMaterializer} re-materialised <b>every</b> holder in that holder's own binding
 * scope, so an atom the author held only in workspace A could be added to a role bound in workspace
 * B (or at instance scope). Capability atoms are worse: {@code AuthzContext} reads them straight
 * from {@code role_permissions}, so no materialised grant ever stands in the way.</p>
 *
 * <p>Every denial here is also a <b>zero-write</b> assertion: a 403 must leave
 * {@code role_permissions} untouched, because the gates run before {@code replaceAtoms}.</p>
 */
class RoleUpdateScopeEscalationTest extends AbstractReusableIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRolePermissionRepository accessRolePermissionRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private RoleAdminService roleAdmin;
    @Autowired private JdbcTemplate jdbcTemplate;

    // ① cross-workspace: the author holds the atom in A only, the role is bound in A AND B.
    @Test
    void addedAtomIsRejectedWhenTheAuthorHoldsItOnlyInAWorkspaceButTheRoleIsBoundInB() {
        User author = newUser("esc-a");
        User holder = newUser("esc-h1");
        Workspace workspaceA = workspaceFixture.createOwnedWorkspace("esc-a-ws", author.getId().toString());
        Workspace workspaceB = workspaceFixture.createWorkspace("esc-b-ws");
        AccessRole role = newRole("ESC_AB", List.of(ToolFaceRegistry.ACTION_READ));
        bind(role.getId(), holder.getId(), AccessScope.workspace(workspaceA.getId()), workspaceA.getId());
        bind(role.getId(), holder.getId(), AccessScope.workspace(workspaceB.getId()), workspaceB.getId());
        int permissionsBefore = permissionsOf(role.getId());

        actAs(author);
        // USE_WORKSPACE_RUNTIME is in WS_OWNER's default set, so the author holds it in A — and
        // only in A: workspace B belongs to nobody here.
        CpApiException denied = assertThrows(CpApiException.class, () -> roleAdmin.update(role.getId(),
                new RoleAdminViews.RoleUpdate(null, null, null, List.of(
                        ToolFaceRegistry.ACTION_READ, ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME))));

        assertEquals(HttpStatus.FORBIDDEN, denied.getStatus());
        assertEquals("PRIVILEGE_ESCALATION", denied.getCode());
        assertTrue(denied.getMessage().contains("USE_WORKSPACE_RUNTIME"), denied.getMessage());
        assertEquals(permissionsBefore, permissionsOf(role.getId()),
                "a rejected update must write nothing (zero partial write)");
        assertTrue(workspaceA != null && workspaceB != null);
    }

    // ① positive control: the author owns BOTH workspaces, so the same update goes through and the
    // holder in B really gains the atom (proves the gate is not simply "deny everything").
    @Test
    void addedAtomIsAllowedWhenTheAuthorHoldsItInEveryBindingScope() {
        User author = newUser("esc-a2");
        User holder = newUser("esc-h2");
        Workspace workspaceA = workspaceFixture.createOwnedWorkspace("esc-a2-ws", author.getId().toString());
        Workspace workspaceB = workspaceFixture.createOwnedWorkspace("esc-b2-ws", author.getId().toString());
        AccessRole role = newRole("ESC_AB_OK", List.of(ToolFaceRegistry.ACTION_READ));
        bind(role.getId(), holder.getId(), AccessScope.workspace(workspaceA.getId()), workspaceA.getId());
        bind(role.getId(), holder.getId(), AccessScope.workspace(workspaceB.getId()), workspaceB.getId());

        actAs(author);
        roleAdmin.update(role.getId(), new RoleAdminViews.RoleUpdate(null, null, null, List.of(
                ToolFaceRegistry.ACTION_READ, ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME)));

        assertTrue(grantRows(holder.getId(), workspaceB.getId()).contains(
                        ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME),
                "the holder in workspace B must gain the atom once the author holds it in both scopes");
        assertTrue(workspaceA != null);
    }

    // ② workspace → instance: the role is bound at instance scope, the author holds the atom only
    // inside one workspace. Materialising it at instance scope would widen it to every workspace.
    @Test
    void addedAtomInAnInstanceBindingIsRejectedWhenTheAuthorHoldsItOnlyInAWorkspace() {
        User author = newUser("esc-i");
        User holder = newUser("esc-h3");
        workspaceFixture.createOwnedWorkspace("esc-i-ws", author.getId().toString());
        AccessRole role = newRole("ESC_INST", List.of(ToolFaceRegistry.ACTION_READ));
        bind(role.getId(), holder.getId(), AccessScope.instance(), null);
        int permissionsBefore = permissionsOf(role.getId());

        actAs(author);
        CpApiException denied = assertThrows(CpApiException.class, () -> roleAdmin.update(role.getId(),
                new RoleAdminViews.RoleUpdate(null, null, null, List.of(
                        ToolFaceRegistry.ACTION_READ, ToolFaceRegistry.ACTION_USE_WORKSPACE_RUNTIME))));

        assertEquals(HttpStatus.FORBIDDEN, denied.getStatus());
        assertEquals("PRIVILEGE_ESCALATION", denied.getCode());
        assertEquals(permissionsBefore, permissionsOf(role.getId()),
                "a rejected update must write nothing (zero partial write)");
    }

    // ③ capability counter-example: AuthzContext reads capability atoms straight from
    // role_permissions (instance binding ⇒ workspaceAdminAll), so the projection — not a
    // materialised grant — is what the subset gate has to consult.
    @Test
    void capabilityIsRejectedWithoutTheInstanceCapabilityAndAllowedWithIt() {
        User workspaceOnly = newUser("esc-c1");
        User instanceHolder = newUser("esc-c2");
        workspaceFixture.createOwnedWorkspace("esc-c1-ws", workspaceOnly.getId().toString());
        // workspaceOnly holds workspace:admin in its own workspace only.
        AccessRole wsCap = newRole("ESC_CAP_WS", List.of(PermissionAtomCatalog.CAP_WORKSPACE_ADMIN));
        bind(wsCap.getId(), workspaceOnly.getId(), AccessScope.instance(), null);
        AccessRole instanceCap = newRole("ESC_CAP_INST", List.of(PermissionAtomCatalog.CAP_WORKSPACE_ADMIN));
        bind(instanceCap.getId(), instanceHolder.getId(), AccessScope.instance(), null);

        AccessRole target = newRole("ESC_CAP_TARGET", List.of(ToolFaceRegistry.ACTION_READ));
        User victim = newUser("esc-c3");
        bind(target.getId(), victim.getId(), AccessScope.instance(), null);
        int permissionsBefore = permissionsOf(target.getId());

        // The cap role above is bound at INSTANCE scope for both users, so flip the first one to a
        // workspace binding to model "holds workspace:admin only in workspace A".
        rebindToWorkspace(wsCap.getId(), workspaceOnly.getId());

        actAs(workspaceOnly);
        CpApiException denied = assertThrows(CpApiException.class, () -> roleAdmin.update(target.getId(),
                new RoleAdminViews.RoleUpdate(null, null, null, List.of(
                        ToolFaceRegistry.ACTION_READ, PermissionAtomCatalog.CAP_WORKSPACE_ADMIN))));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatus());
        assertEquals("PRIVILEGE_ESCALATION", denied.getCode());
        assertEquals(permissionsBefore, permissionsOf(target.getId()),
                "a rejected capability escalation must write nothing");

        actAs(instanceHolder);
        roleAdmin.update(target.getId(), new RoleAdminViews.RoleUpdate(null, null, null, List.of(
                ToolFaceRegistry.ACTION_READ, PermissionAtomCatalog.CAP_WORKSPACE_ADMIN)));
        assertTrue(permissionsOf(target.getId()) > permissionsBefore,
                "holding the capability at instance scope is the positive control");
    }

    // ④ reduce-right: only ADDED atoms are checked, so removing one never trips the gate even for
    // an author who holds nothing at all.
    @Test
    void reduceRightNeverTripsTheSubsetGate() {
        User author = newUser("esc-r");
        User holder = newUser("esc-h4");
        AccessRole role = newRole("ESC_REDUCE", List.of(
                ToolFaceRegistry.ACTION_READ, ToolFaceRegistry.ACTION_WRITE));
        bind(role.getId(), holder.getId(), AccessScope.instance(), null);

        actAs(author);
        roleAdmin.update(role.getId(), new RoleAdminViews.RoleUpdate(null, null, null,
                List.of(ToolFaceRegistry.ACTION_READ)));

        assertEquals(List.of(ToolFaceRegistry.ACTION_READ), atomsOf(role.getId()),
                "a reduce-right edit applies even though the author holds none of the atoms");
    }

    // ⑤ display-only edits never reach the atom branch at all.
    @Test
    void displayOnlyEditNeverTripsTheSubsetGate() {
        User author = newUser("esc-d");
        User holder = newUser("esc-h5");
        AccessRole role = newRole("ESC_DISPLAY", List.of(ToolFaceRegistry.ACTION_READ));
        bind(role.getId(), holder.getId(), AccessScope.instance(), null);

        actAs(author);
        roleAdmin.update(role.getId(),
                new RoleAdminViews.RoleUpdate(null, "Renamed", null, null));

        assertEquals("Renamed", accessRoleRepository.findById(role.getId()).orElseThrow().getDisplayName());
        assertEquals(List.of(ToolFaceRegistry.ACTION_READ), atomsOf(role.getId()),
                "a display-only edit leaves the atoms untouched");
    }

    // ------------------------------------------------------------------ fixtures

    private User newUser(String prefix) {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        return userRepository.saveAndFlush(new User(
                prefix + "-" + suffix + "@test.local", "hash", prefix, prefix + suffix));
    }

    private void actAs(User user) {
        TenantContext.setUserId(user.getId().toString());
    }

    private AccessRole newRole(String name, List<String> atoms) {
        AccessRole role = accessRoleRepository.saveAndFlush(new AccessRole(
                UUID.randomUUID(), name, name, null, false));
        for (String atom : atoms) {
            PermissionAtomCatalog.Atom ref = PermissionAtomCatalog.atom(atom);
            accessRolePermissionRepository.saveAndFlush(
                    new AccessRolePermission(role.getId(), ref.name(), ref.canonicalResource()));
        }
        return role;
    }

    private void bind(UUID roleId, UUID subjectId, AccessScope scope, UUID workspaceId) {
        bindingRepository.saveAndFlush(new AccessRoleBinding(roleId, "user", subjectId,
                scope.type(), scope.id(), subjectId));
        materializer.materializeSubject("user", subjectId, subjectId,
                workspaceId == null ? null : workspaceId.toString());
    }

    /** Moves an instance-scoped user binding into one workspace (fixture reshaping only). */
    private void rebindToWorkspace(UUID roleId, UUID subjectId) {
        AccessRoleBinding instance = bindingRepository.findAll().stream()
                .filter(row -> roleId.equals(row.getRoleId()) && subjectId.equals(row.getSubjectId()))
                .filter(row -> AccessScope.INSTANCE.equals(row.getScopeType()))
                .findFirst().orElseThrow();
        bindingRepository.delete(instance);
        bindingRepository.flush();
        Workspace workspace = workspaceFixture.createOwnedWorkspace(
                "esc-cap-" + UUID.randomUUID().toString().substring(0, 6), subjectId.toString());
        bind(roleId, subjectId, AccessScope.workspace(workspace.getId()), workspace.getId());
    }

    private int permissionsOf(UUID roleId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM role_permissions WHERE role_id = ?", Integer.class, roleId);
    }

    private List<String> atomsOf(UUID roleId) {
        return jdbcTemplate.queryForList(
                "SELECT action_class FROM role_permissions WHERE role_id = ? ORDER BY action_class",
                String.class, roleId);
    }

    private List<String> grantRows(UUID subjectId, UUID workspaceId) {
        return jdbcTemplate.queryForList(
                "SELECT permissions->0->>'actionClass' FROM grants WHERE subject_type = 'user'"
                        + " AND subject_id = ? AND scope_type = 'workspace' AND scope_id = ?",
                String.class, subjectId, workspaceId);
    }
}
