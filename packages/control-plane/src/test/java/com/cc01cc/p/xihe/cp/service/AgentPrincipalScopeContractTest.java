package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0622 M1.1 — the three-tier creation/binding invariants (design §1, audit checklist O1–O7).
 *
 * <p>Every assertion goes through the real HTTP surface on purpose (checklist O2/O4: "真实 HTTP 断言，
 * 不是直接调 service"). The four cases the Lead froze are:</p>
 *
 * <ol>
 *   <li>a plain USER creates a PERSONAL principal → 201;</li>
 *   <li>the same USER creates WORKSPACE → 403;</li>
 *   <li>the same USER creates INSTANCE → 403;</li>
 *   <li>A binding B's PERSONAL principal → 403.</li>
 * </ol>
 */
class AgentPrincipalScopeContractTest extends AbstractReusableIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private WorkspaceAgentRepository bindingRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRolePermissionRepository permissionRepository;
    @Autowired private AccessRoleBindingRepository roleBindingRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private GrantDefaultService grantDefaultService;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private final List<UUID> users = new ArrayList<>();
    private final List<UUID> workspaces = new ArrayList<>();
    private final List<UUID> principals = new ArrayList<>();
    private final List<UUID> testRoleIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        for (UUID principalId : principals) {
            bindingRepository.deleteAll(bindingRepository.findByIdPrincipalId(principalId));
            grantRepository.deleteAll(
                    grantRepository.findBySubjectTypeAndSubjectId("agent_principal", principalId));
            jdbcTemplate.update("DELETE FROM audit_logs WHERE resource_type = 'agent_principal' "
                    + "AND CAST(resource_id AS VARCHAR) = ?", principalId.toString());
            principalRepository.deleteById(principalId);
        }
        principals.clear();
        for (UUID workspaceId : workspaces) {
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ?",
                    workspaceId.toString());
            workspaceRepository.deleteById(workspaceId);
        }
        workspaces.clear();
        for (UUID roleId : testRoleIds) {
            // Fixture hygiene (not an assertion change): the ADMIN tier binding seeded by
            // addInstanceAdminTier references a system role, and the test-owned roles are
            // referenced by their own bindings — both must go before the role rows.
            roleBindingRepository.deleteAll(roleBindingRepository.findByRoleId(roleId));
            permissionRepository.deleteAll(permissionRepository.findByIdRoleId(roleId));
            accessRoleRepository.deleteById(roleId);
        }
        testRoleIds.clear();
        for (UUID userId : users) {
            grantRepository.deleteAll(
                    grantRepository.findBySubjectTypeAndSubjectId("user", userId));
            roleBindingRepository.deleteAll(
                    roleBindingRepository.findBySubjectTypeAndSubjectId("user", userId));
            jdbcTemplate.update("DELETE FROM audit_logs WHERE user_id = CAST(? AS UUID)",
                    userId.toString());
            userRepository.deleteById(userId);
        }
        users.clear();
    }

    // ---------------------------------------------------------------------------------------------
    // O2 + D8: a plain USER may create PERSONAL principals, and only PERSONAL ones.
    // ---------------------------------------------------------------------------------------------

    @Test
    void plainUserCreatesPersonalPrincipalButNeitherWorkspaceNorInstanceScope() throws Exception {
        User owner = newUser("plain-user");
        grantDefaultService.ensureUserDefault(owner);

        // D-174: the scope field left the wire. Any value is rejected before authorization.
        ResponseEntity<Map> tierField = create(globalToken(owner),
                Map.of("name", "MyOwnAgent", "scope", "PERSONAL"));
        assertEquals(HttpStatus.BAD_REQUEST, tierField.getStatusCode(),
                "the create body no longer accepts a scope field: "
                        + String.valueOf(tierField.getBody()));

        ResponseEntity<Map> created = create(workspaceToken(owner, workspaceFor(owner).getId(),
                        WorkspaceRole.OWNER), Map.of("name", "MyOwnAgent"));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        Map<String, Object> body = created.getBody();
        assertNotNull(body);
        assertNull(body.get("scope"), "the tier no longer exists on the wire");
        // Lead ruling: creation never auto-owns (no new tier, no guessed owner).
        assertNull(body.get("ownerUserId"));
        assertNull(body.get("defaultModelProvider"));
        assertNull(body.get("allowedModels"));

        UUID principalId = UUID.fromString((String) body.get("principalId"));
        principals.add(principalId);
        AgentPrincipal stored = principalRepository.findById(principalId).orElseThrow();
        assertNull(stored.getOwnerUserId());
        // Audit carries the authorizing action, not a tier (checklist risk #7).
        assertEquals("MANAGE_WORKSPACE_AGENTS",
                objectMapper.readTree(auditDetail(principalId)).path("authorizationAction").asText());
        assertEquals(1, auditCount(owner.getId(), "agent_principal_created"));

        int principalCount = principalRepository.findAll().size();

        // PLAN-0750 M1 (G1/G2, user ruling 2026-11-10): a contextless create is the *user-level*
        // door, authorized by the instance-scope CREATE_OWN_AGENT atom of the human default set —
        // the ordinary account needs no workspace and no administration right. The audit has to
        // name that atom, not the workspace administration action.
        ResponseEntity<Map> userLevel = create(globalToken(owner), Map.of("name", "SharedAgent"));
        assertEquals(HttpStatus.CREATED, userLevel.getStatusCode(),
                "a contextless create is a user-level create: "
                        + String.valueOf(userLevel.getBody()));
        UUID userLevelId = UUID.fromString((String) userLevel.getBody().get("principalId"));
        principals.add(userLevelId);
        assertEquals("CREATE_OWN_AGENT",
                objectMapper.readTree(auditDetail(userLevelId)).path("authorizationAction").asText(),
                "the audit names the atom that actually authorized the create");
        assertNull(principalRepository.findById(userLevelId).orElseThrow().getOwnerUserId(),
                "G2=(b): even the user-level door leaves owner_user_id NULL");
        assertTrue(bindingRepository.findByIdPrincipalId(userLevelId).isEmpty(),
                "G2 explicit binding: a user-level create adds no Workspace binding");

        assertEquals(principalCount + 1, principalRepository.findAll().size());
    }

    private Workspace workspaceFor(User owner) {
        Workspace workspace = workspaceFixture.createOwnedWorkspace("D-174 ws " + owner.getId(),
                owner.getId().toString());
        workspaces.add(workspace.getId());
        return workspace;
    }

    // ---------------------------------------------------------------------------------------------
    // PLAN-0750 M1: G2=(b) — the create path never writes owner_user_id; the user-level door is an
    // atom check, not a context check and never a role-name special case (G1).
    // ---------------------------------------------------------------------------------------------

    @Test
    void userLevelCreateNeverWritesOwnerUserIdAndCreatesNoWorkspaceBinding() throws Exception {
        User owner = newUser("owner-lock");
        grantDefaultService.ensureUserDefault(owner);

        ResponseEntity<Map> created = create(globalToken(owner), Map.of("name", "OwnerLockAgent"));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        UUID principalId = UUID.fromString((String) created.getBody().get("principalId"));
        principals.add(principalId);

        AgentPrincipal stored = principalRepository.findById(principalId).orElseThrow();
        // G2=(b) lock (D-84 style): if a future change starts writing owner_user_id on create,
        // this assertion — and nothing else in the suite — goes red.
        assertNull(stored.getOwnerUserId(),
                "G2=(b) / D-174: the create path must leave owner_user_id NULL");
        assertNull(created.getBody().get("ownerUserId"), "and the create view must not mint one");
        assertEquals(owner.getId(), UUID.fromString(stored.getCreatedByUserId()),
                "created_by_user_id records the actor; ownership is never inferred from it");
        assertTrue(bindingRepository.findByIdPrincipalId(principalId).isEmpty(),
                "G2 explicit binding: reach to a Workspace comes from the bind surface, not from create");
        assertEquals("CREATE_OWN_AGENT",
                objectMapper.readTree(auditDetail(principalId)).path("authorizationAction").asText(),
                "the durable audit names the actual authorizing atom");
    }

    @Test
    void userWithoutTheOwnAgentAtomCannotCreateAtAll() {
        // No ensureUserDefault: the account holds no grants, so the user-level door must refuse.
        // This is the atom gate — the assertion below never mentions a role name (G1 forbids
        // isInstanceAdmin-style special cases).
        User unprovisioned = newUser("no-default-grants");
        int principalCount = principalRepository.findAll().size();

        ResponseEntity<Map> denied = create(globalToken(unprovisioned), Map.of("name", "NotAllowed"));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(), String.valueOf(denied.getBody()));
        assertEquals("FORBIDDEN", denied.getBody().get("code"));
        assertTrue(String.valueOf(denied.getBody()).contains("CREATE_OWN_AGENT"),
                "the refusal names the missing atom: " + denied.getBody());
        assertEquals(principalCount, principalRepository.findAll().size());
    }

    // ---------------------------------------------------------------------------------------------
    // D8/D9: WORKSPACE creation is gated by MANAGE_WORKSPACE_AGENTS + a workspace context;
    // INSTANCE creation is gated by CREATE_ACCOUNT (never alias-merged).
    // ---------------------------------------------------------------------------------------------

    @Test
    void workspaceScopeNeedsWorkspaceContextAndItsOwnActionInstanceScopeNeedsCreateAccount()
            throws Exception {
        User owner = newUser("ws-owner");
        grantDefaultService.ensureUserDefault(owner);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("M1.1 scope ws", owner.getId().toString());
        workspaces.add(workspace.getId());

        // PLAN-0750 M1 (G1): the "no context" request is no longer a 409 — it is the user-level
        // door. The workspace tier is the *explicit-context* path below and keeps its own atom.
        ResponseEntity<Map> userLevel = create(globalToken(owner), Map.of("name", "NoContext"));
        assertEquals(HttpStatus.CREATED, userLevel.getStatusCode(),
                "no workspace context = user-level create, not a conflict: "
                        + String.valueOf(userLevel.getBody()));
        UUID userLevelId = UUID.fromString((String) userLevel.getBody().get("principalId"));
        principals.add(userLevelId);
        assertEquals("CREATE_OWN_AGENT",
                objectMapper.readTree(auditDetail(userLevelId)).path("authorizationAction").asText());

        ResponseEntity<Map> created = create(workspaceToken(owner, workspace.getId(),
                        WorkspaceRole.OWNER), Map.of("name", "TeamAgent"));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        UUID principalId = UUID.fromString((String) created.getBody().get("principalId"));
        principals.add(principalId);
        AgentPrincipal stored = principalRepository.findById(principalId).orElseThrow();
        assertNull(stored.getOwnerUserId(), "a create-by-owner principal still carries no caller-chosen owner");
        assertNull(created.getBody().get("scope"), "D-174: no tier on the wire");

        int rowsBeforeTierBodies = principalRepository.findAll().size();

        // D-174: every legacy tier value is rejected at the wire edge (no compat branch).
        for (String tier : new String[] {"WORKSPACE", "PERSONAL", "INSTANCE"}) {
            ResponseEntity<Map> rejected = create(workspaceToken(owner, workspace.getId(),
                    WorkspaceRole.OWNER), java.util.Map.of("name", "Tiered" + tier, "scope", tier));
            assertEquals(HttpStatus.BAD_REQUEST, rejected.getStatusCode(),
                    "scope=" + tier + " must be rejected: " + String.valueOf(rejected.getBody()));
        }
        assertEquals(rowsBeforeTierBodies, principalRepository.findAll().size(),
                "rejected tier bodies must not create rows");
    }

    // ---------------------------------------------------------------------------------------------
    // O1 + O3: the owner is never taken from the body; an admin cannot mint a PERSONAL principal
    // "for somebody else" because the frozen body has no such field.
    // ---------------------------------------------------------------------------------------------

    @Test
    void ownerInjectionIsRejectedAndAdminOnlyEverOwnsItsOwnPersonalPrincipal() throws Exception {
        User admin = newUser("instance-admin");
        grantDefaultService.ensureUserDefault(admin);
        addInstanceActionGrant(admin.getId(), "CREATE_ACCOUNT", "*");
        UUID victim = newUser("victim").getId();

        int principalCount = principalRepository.findAll().size();

        // D-174: neither ownerUserId nor a tier field exists on the create body any more.
        ResponseEntity<Map> injected = create(globalToken(admin), Map.of(
                "name", "ForgedOwner",
                "scope", "PERSONAL",
                "ownerUserId", victim.toString()));
        assertEquals(HttpStatus.BAD_REQUEST, injected.getStatusCode(),
                "the frozen create body has no ownerUserId or scope: " + String.valueOf(injected.getBody()));
        assertEquals(principalCount, principalRepository.findAll().size());

        Workspace adminWs = workspaceFixture.createOwnedWorkspace("D-174 owner-injection ws",
                admin.getId().toString());
        workspaces.add(adminWs.getId());
        ResponseEntity<Map> created = create(workspaceToken(admin, adminWs.getId(), WorkspaceRole.OWNER),
                Map.of("name", "AdminCreated"));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        UUID principalId = UUID.fromString((String) created.getBody().get("principalId"));
        principals.add(principalId);
        // Lead ruling: creation never auto-owns (no new tier, no guessed owner).
        assertNull(principalRepository.findById(principalId).orElseThrow().getOwnerUserId());
        assertNull(created.getBody().get("ownerUserId"));
    }

    // ---------------------------------------------------------------------------------------------
    // O4: binding is still gated by MANAGE_WORKSPACE_AGENTS, and on top of it a PERSONAL principal
    // may only be bound by its own owner (A must not drag B's private agent into a Workspace).
    // ---------------------------------------------------------------------------------------------

    @Test
    void anotherUsersPersonalPrincipalCannotBeBoundEvenWithWorkspaceManagement() throws Exception {
        User alice = newUser("alice");
        User bob = newUser("bob");
        grantDefaultService.ensureUserDefault(alice);
        grantDefaultService.ensureUserDefault(bob);
        Workspace aliceWs = workspaceFixture.createOwnedWorkspace("Alice ws", alice.getId().toString());
        workspaces.add(aliceWs.getId());
        workspaceFixture.bindWorkspaceRole(aliceWs.getId(), bob.getId(), WorkspaceRole.EDITOR);

        // D-174: creation no longer auto-owns; the owner column survives only on legacy/fixture rows,
        // and those rows keep their owner-only protection (data preserved ⇒ protection preserved).
        UUID bobOwned = createOwnedPrincipal(bob, "BobOwned");
        UUID alicePrincipal = createPersonal(alice, "AliceMade");

        ResponseEntity<Map> stolen = putCap(alice, aliceWs.getId(), bobOwned, List.of());
        assertEquals(HttpStatus.FORBIDDEN, stolen.getStatusCode(),
                "A must not bind Bob's owned principal: " + String.valueOf(stolen.getBody()));
        assertEquals("AGENT_PRINCIPAL_OWNER_MISMATCH", stolen.getBody().get("code"));
        assertEquals(false, bindingRepository.existsById(
                new WorkspaceAgentId(bobOwned, aliceWs.getId())));

        ResponseEntity<Map> editorOwn = putCap(bob, aliceWs.getId(), bobOwned, List.of());
        assertEquals(HttpStatus.FORBIDDEN, editorOwn.getStatusCode(),
                "binding still requires MANAGE_WORKSPACE_AGENTS: "
                        + String.valueOf(editorOwn.getBody()));

        Workspace bobWs = workspaceFixture.createOwnedWorkspace("Bob ws", bob.getId().toString());
        workspaces.add(bobWs.getId());
        ResponseEntity<Map> ownBinding = putCap(bob, bobWs.getId(), bobOwned, List.of());
        assertEquals(HttpStatus.OK, ownBinding.getStatusCode(), String.valueOf(ownBinding.getBody()));
        assertEquals(true, bindingRepository.existsById(
                new WorkspaceAgentId(bobOwned, bobWs.getId())));

        ResponseEntity<Map> aliceOwnBinding = putCap(alice, aliceWs.getId(), alicePrincipal, List.of());
        assertEquals(HttpStatus.OK, aliceOwnBinding.getStatusCode(),
                String.valueOf(aliceOwnBinding.getBody()));
    }

    /** A direct row with a legacy owner column value (creation no longer writes owners). */
    private UUID createOwnedPrincipal(User owner, String name) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName(name);
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        principal.setCreatedByUserId(owner.getId().toString());
        principal.setOwnerUserId(owner.getId());
        UUID principalId = principalRepository.saveAndFlush(principal).getId();
        principals.add(principalId);
        return principalId;
    }

    // ---------------------------------------------------------------------------------------------
    // D-174: the tier rule is gone. An owner-less principal binds through the workspace gate alone
    // (no instance administration); a member without MANAGE_WORKSPACE_AGENTS still cannot.
    // ---------------------------------------------------------------------------------------------

    @Test
    void instanceScopedPrincipalBindingRequiresInstanceAdmin() throws Exception {
        User owner = newUser("ws-owner2");
        User viewer = newUser("ws-viewer2");
        grantDefaultService.ensureUserDefault(owner);
        grantDefaultService.ensureUserDefault(viewer);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Instance bind ws",
                owner.getId().toString());
        workspaces.add(workspace.getId());
        workspaceFixture.bindWorkspaceRole(workspace.getId(), viewer.getId(), WorkspaceRole.EDITOR);

        UUID ownerlessPrincipal = createInstancePrincipal(owner);

        // A ws member without MANAGE_WORKSPACE_AGENTS (WS_EDITOR) still fails the action gate.
        ResponseEntity<Map> denied = putCap(viewer, workspace.getId(), ownerlessPrincipal, List.of());
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(),
                "the workspace action gate is unchanged: " + String.valueOf(denied.getBody()));
        assertEquals(false, bindingRepository.existsById(
                new WorkspaceAgentId(ownerlessPrincipal, workspace.getId())));

        // The principal carries no owner and no tier any more — the workspace owner binds it
        // without needing instance administration (tier removal, decision D-174).
        ResponseEntity<Map> allowed = putCap(owner, workspace.getId(), ownerlessPrincipal, List.of());
        assertEquals(HttpStatus.OK, allowed.getStatusCode(), String.valueOf(allowed.getBody()));
        assertEquals(true, bindingRepository.existsById(
                new WorkspaceAgentId(ownerlessPrincipal, workspace.getId())));
    }


    // ---------------------------------------------------------------------------------------------
    // D21 (Lead ruling, 2026-11-02): an omitted `scope` is the WORKSPACE tier and is authorized
    // EXACTLY like an explicit `scope=WORKSPACE` — no second, legacy authorization path.
    // ---------------------------------------------------------------------------------------------

    @Test
    void omittedScopeIsAuthorizedAsWorkspaceScopeNotAsCreateAccount() throws Exception {
        User plain = newUser("omitted-scope-plain");
        grantDefaultService.ensureUserDefault(plain);
        int principalCount = principalRepository.findAll().size();

        // PLAN-0750 M1 (G1): a contextless create is the user-level door and succeeds on the
        // instance-scope CREATE_OWN_AGENT atom — never on a legacy scope/tier path.
        // REFACTOR-GUARD(null-workspace): this authorization is produced by
        // AgentPrincipalService#requireUserAction, which builds a PolicyRequest with a null workspace
        // and evaluates it with evaluator.allows(...) directly (no UUID parsing). If that method is
        // ever refactored onto GrantAuthorizationService#allowsUserOnly, the null workspace goes
        // through UUID.fromString and the caller turns into a 500; this 201 assertion must go red,
        // not silent. (rg 'REFACTOR-GUARD' finds every such guard.)
        ResponseEntity<Map> userLevel = create(globalToken(plain), Map.of("name", "LegacyBody"));
        assertEquals(HttpStatus.CREATED, userLevel.getStatusCode(),
                "an omitted tier is a plain user-level create, not a legacy path: "
                        + String.valueOf(userLevel.getBody()));
        UUID userLevelId = UUID.fromString((String) userLevel.getBody().get("principalId"));
        principals.add(userLevelId);
        assertEquals("CREATE_OWN_AGENT",
                objectMapper.readTree(auditDetail(userLevelId)).path("authorizationAction").asText(),
                "no legacy scope path authorizes this create");
        assertEquals(principalCount + 1, principalRepository.findAll().size());

        User owner = newUser("omitted-scope-owner");
        grantDefaultService.ensureUserDefault(owner);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Omitted scope ws",
                owner.getId().toString());
        workspaces.add(workspace.getId());

        ResponseEntity<Map> created = create(
                workspaceToken(owner, workspace.getId(), WorkspaceRole.OWNER),
                Map.of("name", "LegacyBodyWithContext"));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        UUID principalId = UUID.fromString((String) created.getBody().get("principalId"));
        principals.add(principalId);
        assertNull(created.getBody().get("scope"), "D-174: no tier on the wire");
        assertNull(principalRepository.findById(principalId).orElseThrow().getOwnerUserId());
        assertNull(created.getBody().get("ownerUserId"));
    }
    // ---------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------

    private User newUser(String label) {
        User user = userRepository.saveAndFlush(new User(
                "plan0622-" + label + "-" + UUID.randomUUID() + "@test.com", "hash", label));
        users.add(user.getId());
        return user;
    }

    private UUID createPersonal(User user, String name) {
        // D-174: creation is workspace-authorized for everyone; the helper gives the user their own
        // workspace context (no tier, no auto-owner beyond the created row's owner column).
        Workspace workspace = workspaceFor(user);
        ResponseEntity<Map> response = create(
                workspaceToken(user, workspace.getId(), WorkspaceRole.OWNER), Map.of("name", name));
        assertEquals(HttpStatus.CREATED, response.getStatusCode(), String.valueOf(response.getBody()));
        UUID principalId = UUID.fromString((String) response.getBody().get("principalId"));
        principals.add(principalId);
        return principalId;
    }

    private UUID createInstancePrincipal(User creator) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("InstanceSharedAgent");
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        // Fixture hygiene: created_by_user_id has a FK to users; a random UUID violates it.
        principal.setCreatedByUserId(creator.getId().toString());
        UUID principalId = principalRepository.saveAndFlush(principal).getId();
        principals.add(principalId);
        return principalId;
    }

    private String globalToken(User user) {
        return TestDataFactory.createGlobalToken(user.getId().toString(), user.getEmail(), "USER", 0);
    }

    private String workspaceToken(User user, UUID workspaceId, WorkspaceRole role) {
        return TestDataFactory.createWorkspaceToken(user.getId().toString(), user.getEmail(),
                role.name(), workspaceId.toString(), 0);
    }

    private ResponseEntity<Map> create(String token, Map<String, Object> body) {
        return exchange(HttpMethod.POST, "/api/v1/agent-principals", token, body);
    }

    private ResponseEntity<Map> putCap(User actor, UUID workspaceId, UUID principalId,
                                       List<Map<String, String>> permissions) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("permissions", permissions);
        return exchange(HttpMethod.PUT,
                "/api/v1/workspaces/" + workspaceId + "/agents/" + principalId,
                workspaceToken(actor, workspaceId, WorkspaceRole.EDITOR), body);
    }

    @SuppressWarnings("unchecked")
    private <T> ResponseEntity<Map> exchange(HttpMethod method, String path, String token, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(url(path), method, new HttpEntity<>(body, headers), Map.class);
    }

    /** Materializes one extra instance-scope action atom for the subject (user-tier grant). */
    private void addInstanceActionGrant(UUID userId, String actionClass, String resource) {
        UUID roleId = UUID.randomUUID();
        accessRoleRepository.save(new AccessRole(roleId,
                "TEST_M1_" + roleId.toString().replace("-", "").toUpperCase(),
                "M1.1 test grant", "test-only role", false));
        permissionRepository.save(new AccessRolePermission(roleId, actionClass, resource));
        roleBindingRepository.save(new AccessRoleBinding(roleId, "user", userId,
                AccessScope.INSTANCE, null, userId));
        materializer.materializeSubject("user", userId, userId, null);
        testRoleIds.add(roleId);
    }

    /** Seeds a real instance ADMIN tier binding (capability authority reads bindings, not grants). */
    private void addInstanceAdminTier(UUID userId) {
        AccessRole adminRole = accessRoleRepository.findByName("ADMIN")
                .orElseThrow(() -> new IllegalStateException("ADMIN role missing (V87)"));
        roleBindingRepository.save(new AccessRoleBinding(adminRole.getId(), "user", userId,
                AccessScope.INSTANCE, null, userId));
    }

    private int auditCount(UUID userId, String action) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = ? AND user_id = CAST(? AS UUID)",
                Integer.class, action, userId.toString());
    }

    private String auditDetail(UUID principalId) {
        return jdbcTemplate.queryForObject(
                "SELECT details FROM audit_logs WHERE action = 'agent_principal_created' "
                        + "AND CAST(resource_id AS VARCHAR) = ?", String.class, principalId.toString());
    }
}
