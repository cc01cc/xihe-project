package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.RequesterAuthority;
import com.cc01cc.p.xihe.cp.policy.RoleAdminService;
import com.cc01cc.p.xihe.cp.policy.RoleAdminViews;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0673 V4.2 (①②) — the BL-287 cap write gate and the runtime boundary around it.
 *
 * <p>The M1 evidence recorded two gaps that the existing suites cannot express:</p>
 *
 * <ol>
 *   <li>{@code RoleAdminService.update} re-checks {@code assertWithinCap}/{@code assertAgentBindable}
 *       for <b>already bound</b> agent roles, but nothing exercised it: editing a role that an agent
 *       already holds must answer {@code 409 ROLE_BINDING_EXCEEDS_CAP} (and name the atom) instead of
 *       silently widening a binding whose effective set the cap keeps clipped;</li>
 *   <li>{@code GRANT_ANY_ATOM} must not bypass the cap or the agent-forbidden atom gate. The bypass
 *       lives inside the <b>grant-side</b> guard ({@code RoleBindingService} orders forbidden → cap →
 *       guard precisely so this holds) and there was no explicit test for it.</li>
 * </ol>
 *
 * <p>Every refusal is also a zero-write assertion: the three tables ({@code role_permissions},
 * {@code role_bindings}, {@code grants}) keep their row counts and the agent's effective cap is
 * unchanged. Counter-example: deleting the {@code assertWithinCap} calls (or reordering them behind
 * the guard's bypass) turns these tests red — the refusal disappears or the atom lands in the role /
 * in the principal's grants.</p>
 */
class AgentCapWriteGateBoundaryTest extends AbstractIntegrationTest {

    private static final String READ = ToolFaceRegistry.ACTION_READ;
    private static final String WRITE = ToolFaceRegistry.ACTION_WRITE;
    private static final String CREATE_SCHEDULED_TASK = ToolFaceRegistry.ACTION_CREATE_SCHEDULED_TASK;
    private static final String CAP_READ_ONLY = "[{\"actionClass\":\"read\",\"resource\":\"*\"}]";

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRolePermissionRepository permissionRepository;
    @Autowired private AccessRoleBindingRepository bindingRepository;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private AgentPrincipalRoleBindingService agentRoleBindings;
    @Autowired private GrantDefaultService grantDefaultService;
    @Autowired private RoleAdminService roleAdmin;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private RequesterAuthority requesterAuthority;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private Workspace workspace;
    private AgentPrincipal principal;

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    // ── ① an already bound agent role cannot be widened past the cap ─────────

    /**
     * The BL-287 write gate on the <b>update</b> path: the role is already bound to the agent in this
     * workspace with a read-only cap, so adding {@code write} must refuse with 409 naming the atom —
     * not commit and leave the binding silently clipped by the intersection.
     */
    @Test
    void updatingARoleAlreadyBoundToAnAgentAnswersCap409AndWritesNothing() {
        User owner = fixture();
        UUID roleId = createRole(READ);
        bindRoleToPrincipal(roleId, owner.getId(), workspace.getId());
        long permissionsBefore = permissionsOf(roleId);
        long bindingsBefore = bindingsOfRole(roleId);
        long grantsBefore = grantsOfPrincipal(principal.getId());

        actAs(owner);
        CpApiException denied = assertThrows(CpApiException.class, () -> roleAdmin.update(roleId,
                new RoleAdminViews.RoleUpdate(null, null, null, List.of(READ, WRITE))));

        assertEquals(HttpStatus.CONFLICT, denied.getStatus(), denied.getMessage());
        assertEquals("ROLE_BINDING_EXCEEDS_CAP", denied.getCode(), denied.getMessage());
        assertTrue(denied.getMessage().contains(WRITE),
                "the refusal names the atom outside the cap: " + denied.getMessage());

        assertEquals(permissionsBefore, permissionsOf(roleId), "role_permissions untouched");
        assertEquals(List.of(READ), atomsOf(roleId));
        assertEquals(bindingsBefore, bindingsOfRole(roleId), "role_bindings untouched");
        assertEquals(grantsBefore, grantsOfPrincipal(principal.getId()), "grants untouched");
        assertFalse(String.valueOf(agentPrincipalService.resolveCapFor(principal.getId(),
                        workspace.getId())).contains(WRITE),
                "the agent's effective cap keeps clipping write");
    }

    /**
     * Being bound at <b>instance</b> scope has no workspace cap by construction (the cap is a
     * per-workspace value), so the gate must not fire there — the positive control that keeps the
     * 409 above from being a blanket refusal of every agent-bound role edit.
     */
    @Test
    void anInstanceScopedAgentBindingHasNoCapToExceed() {
        User owner = fixture();
        UUID roleId = createRole(READ);
        bindRoleToPrincipal(roleId, owner.getId(), null);

        actAs(owner);
        roleAdmin.update(roleId,
                new RoleAdminViews.RoleUpdate(null, null, null, List.of(READ, WRITE)));

        assertEquals(List.of(READ, WRITE), atomsOf(roleId),
                "without a workspace cap the same edit applies (cap is per workspace, not per principal)");
    }

    // ── ② GRANT_ANY_ATOM does not bypass the cap ────────────────────────────

    /**
     * A SUPER_ADMIN (the only default holder of {@code GRANT_ANY_ATOM}) binding an over-cap role to an
     * agent still answers {@code 409 ROLE_BINDING_EXCEEDS_CAP}: the ordering forbidden → cap → guard
     * means the bypass branch can only ever skip the grant-side subset, never the target-side ceiling.
     */
    @Test
    void grantAnyAtomDoesNotBypassTheCapOnAnAgentRoleBinding() {
        User superAdmin = newUser("caproot");
        bindInstanceSystemRole(superAdmin.getId(), SystemAccessRoleCatalog.SUPER_ADMIN);
        User owner = fixture();
        UUID overCapRole = createRole(CREATE_SCHEDULED_TASK);
        long bindingsBefore = bindingsOfRole(overCapRole);
        long grantsBefore = grantsOfPrincipal(principal.getId());

        assertTrue(requesterAuthority.holdsActionAtom(superAdmin.getId(),
                        ToolFaceRegistry.ACTION_GRANT_ANY_ATOM, null),
                "fixture precondition: the caller really carries the grant-side bypass atom");

        CpApiException denied = assertThrows(CpApiException.class,
                () -> bindRoleToPrincipal(overCapRole, superAdmin.getId(), workspace.getId()));
        assertEquals(HttpStatus.CONFLICT, denied.getStatus(), denied.getMessage());
        assertEquals("ROLE_BINDING_EXCEEDS_CAP", denied.getCode(), denied.getMessage());
        assertTrue(denied.getMessage().contains(CREATE_SCHEDULED_TASK),
                "the refusal names the atom outside the cap: " + denied.getMessage());
        assertEquals(bindingsBefore, bindingsOfRole(overCapRole), "no binding row was written");
        assertEquals(grantsBefore, grantsOfPrincipal(principal.getId()), "no grant row was written");

        // Same bypass holder, same API, in-cap role: the path works — and the grant-side bypass really
        // was taken (audited), so the refusal above is the cap, not a broken bind surface.
        UUID inCapRole = createRole(READ);
        bindRoleToPrincipal(inCapRole, superAdmin.getId(), workspace.getId());
        assertEquals(1, bindingsOfRole(inCapRole), "the in-cap binding is written");
        Integer bypassed = jdbcTemplate.queryForObject("SELECT count(*) FROM audit_logs"
                        + " WHERE action = 'role_grant_guard_bypassed' AND user_id = ?",
                Integer.class, superAdmin.getId());
        assertTrue(bypassed != null && bypassed >= 1,
                "the SUPER_ADMIN bind went through the audited bypass branch");
    }

    /**
     * The same claim on the other write path: SUPER_ADMIN editing an already bound agent role past the
     * cap is refused with 409 (the bypass branch runs first inside the guard, then the cap recheck
     * still answers).
     */
    @Test
    void grantAnyAtomDoesNotBypassTheCapWhenUpdatingAnAlreadyBoundAgentRole() {
        User superAdmin = newUser("caprootupd");
        bindInstanceSystemRole(superAdmin.getId(), SystemAccessRoleCatalog.SUPER_ADMIN);
        User owner = fixture();
        UUID roleId = createRole(READ);
        bindRoleToPrincipal(roleId, owner.getId(), workspace.getId());
        long permissionsBefore = permissionsOf(roleId);

        assertTrue(requesterAuthority.holdsActionAtom(superAdmin.getId(),
                        ToolFaceRegistry.ACTION_GRANT_ANY_ATOM, null),
                "fixture precondition: the caller really carries the grant-side bypass atom");

        actAs(superAdmin);
        CpApiException denied = assertThrows(CpApiException.class, () -> roleAdmin.update(roleId,
                new RoleAdminViews.RoleUpdate(null, null, null, List.of(READ, WRITE))));

        assertEquals(HttpStatus.CONFLICT, denied.getStatus(), denied.getMessage());
        assertEquals("ROLE_BINDING_EXCEEDS_CAP", denied.getCode(), denied.getMessage());
        assertEquals(permissionsBefore, permissionsOf(roleId), "role_permissions untouched");
        assertEquals(List.of(READ), atomsOf(roleId));
    }

    // ── ② GRANT_ANY_ATOM does not bypass the agent-forbidden atom gate ──────

    /**
     * The forbidden-atom gate is a hard 403 on the <b>create</b> path ({@code
     * AgentPrincipalService#validateGrantableRoles}): even a SUPER_ADMIN may not hand an administrator
     * role to an agent principal, and the refusal happens before any row is written.
     */
    @Test
    void grantAnyAtomDoesNotBypassTheForbiddenAtomGateOnAgentPrincipalCreation() {
        User superAdmin = newUser("caprootcreate");
        bindInstanceSystemRole(superAdmin.getId(), SystemAccessRoleCatalog.SUPER_ADMIN);
        UUID adminRoleId = accessRoleRepository.findByName(SystemAccessRoleCatalog.ADMIN)
                .orElseThrow().getId();
        long principalsBefore = principalRepository.count();

        assertTrue(requesterAuthority.holdsActionAtom(superAdmin.getId(),
                        ToolFaceRegistry.ACTION_GRANT_ANY_ATOM, null),
                "fixture precondition: the caller really carries the grant-side bypass atom");

        CpApiException denied = assertThrows(CpApiException.class, () -> agentPrincipalService
                .createPrincipal(superAdmin.getId().toString(), "ForbiddenAgent", null,
                        emptyTemplateSnapshot(), null, null, null, null,
                        AgentPrincipal.ORIGIN_USER, null, List.of(adminRoleId)));

        assertEquals(HttpStatus.FORBIDDEN, denied.getStatus(), denied.getMessage());
        assertEquals("ROLE_NOT_GRANTABLE", denied.getCode(), denied.getMessage());
        assertEquals(principalsBefore, principalRepository.count(),
                "a refused creation writes no principal row");
    }

    // ── fixtures ────────────────────────────────────────────────────────────

    /**
     * A workspace owner (WS_OWNER ⇒ holds read/write/manage-workspace-agents there) plus an agent
     * principal bound to the workspace with a read-only cap.
     */
    private User fixture() {
        User owner = newUser("capgate");
        grantDefaultService.ensureUserDefault(owner);
        workspace = workspaceFixture.createOwnedWorkspace("CapGate ws", owner.getId().toString());
        principal = agentPrincipalService.createPrincipal(owner.getId().toString(),
                "CapGateAgent", null, emptyTemplateSnapshot());
        agentPrincipalService.setWorkspaceCap(owner.getId().toString(), workspace.getId(),
                principal.getId(), json(CAP_READ_ONLY));
        return owner;
    }

    private User newUser(String prefix) {
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        return userRepository.saveAndFlush(new User(
                prefix + "-" + suffix + "@test.local", "hash", prefix, prefix + suffix));
    }

    private void actAs(User user) {
        TenantContext.setUserId(user.getId().toString());
    }

    private UUID createRole(String... atoms) {
        String name = "CAPGATE_" + UUID.randomUUID().toString().replace("-", "")
                .substring(0, 8).toUpperCase();
        AccessRole role = accessRoleRepository.saveAndFlush(new AccessRole(
                UUID.randomUUID(), name, name, null, false));
        for (String atom : atoms) {
            permissionRepository.saveAndFlush(new AccessRolePermission(
                    role.getId(), atom, PermissionAtomCatalog.atom(atom).canonicalResource()));
        }
        return role.getId();
    }

    private void bindRoleToPrincipal(UUID roleId, UUID actorId, UUID authWorkspaceId) {
        // The grant-side guard answers from the request subject, exactly like the HTTP entry point.
        actAs(userRepository.findById(actorId).orElseThrow());
        agentRoleBindings.bind(principal.getId(), roleId, actorId, authWorkspaceId,
                authWorkspaceId == null, id -> true, null);
    }

    private void bindInstanceSystemRole(UUID userId, String roleName) {
        UUID roleId = accessRoleRepository.findByName(roleName).orElseThrow().getId();
        bindingRepository.saveAndFlush(new AccessRoleBinding(roleId, "user", userId,
                AccessScope.INSTANCE, null, userId));
        materializer.materializeSubject("user", userId, userId, null);
    }

    private long permissionsOf(UUID roleId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM role_permissions WHERE role_id = ?", Long.class, roleId);
    }

    private List<String> atomsOf(UUID roleId) {
        return jdbcTemplate.queryForList(
                "SELECT action_class FROM role_permissions WHERE role_id = ? ORDER BY action_class",
                String.class, roleId);
    }

    private long bindingsOfRole(UUID roleId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM role_bindings WHERE role_id = ?", Long.class, roleId);
    }

    private long grantsOfPrincipal(UUID principalId) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM grants"
                + " WHERE subject_type = 'agent_principal' AND subject_id = ?", Long.class, principalId);
    }

    private JsonNode json(String value) {
        try {
            return objectMapper.readTree(value);
        } catch (com.fasterxml.jackson.core.JsonProcessingException cause) {
            throw new IllegalStateException(value, cause);
        }
    }

    /** The creation snapshot the service accepts: an object whose {@code permissions} is an array. */
    private ObjectNode emptyTemplateSnapshot() {
        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        return snapshot;
    }
}
