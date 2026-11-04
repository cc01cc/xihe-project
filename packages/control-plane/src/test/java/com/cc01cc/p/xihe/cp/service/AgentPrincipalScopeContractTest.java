package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
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
class AgentPrincipalScopeContractTest extends AbstractIntegrationTest {

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

        ResponseEntity<Map> personal = create(globalToken(owner),
                Map.of("name", "MyOwnAgent", "scope", "PERSONAL"));
        assertEquals(HttpStatus.CREATED, personal.getStatusCode(), String.valueOf(personal.getBody()));
        Map<String, Object> body = personal.getBody();
        assertNotNull(body);
        assertEquals("PERSONAL", body.get("scope"));
        assertEquals(owner.getId().toString(), body.get("ownerUserId"));
        assertNull(body.get("defaultModelProvider"));
        assertNull(body.get("allowedModels"));

        UUID principalId = UUID.fromString((String) body.get("principalId"));
        principals.add(principalId);
        AgentPrincipal stored = principalRepository.findById(principalId).orElseThrow();
        assertEquals("PERSONAL", stored.getScope());
        assertEquals(owner.getId(), stored.getOwnerUserId());
        // Audit must carry the tier (checklist risk #7: `agent_principal_created` details include scope).
        assertEquals("PERSONAL", objectMapper.readTree(auditDetail(principalId)).path("scope").asText());
        assertEquals(1, auditCount(owner.getId(), "agent_principal_created"));

        int principalCount = principalRepository.findAll().size();

        ResponseEntity<Map> workspaceScope = create(globalToken(owner),
                Map.of("name", "SharedAgent", "scope", "WORKSPACE"));
        assertEquals(HttpStatus.FORBIDDEN, workspaceScope.getStatusCode(),
                "a plain USER must not create WORKSPACE-scope principals: "
                        + String.valueOf(workspaceScope.getBody()));

        ResponseEntity<Map> instanceScope = create(globalToken(owner),
                Map.of("name", "InstanceAgent", "scope", "INSTANCE"));
        assertEquals(HttpStatus.FORBIDDEN, instanceScope.getStatusCode(),
                "a plain USER must not create INSTANCE-scope principals: "
                        + String.valueOf(instanceScope.getBody()));

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

        ResponseEntity<Map> withoutContext = create(globalToken(owner),
                Map.of("name", "NoContext", "scope", "WORKSPACE"));
        assertEquals(HttpStatus.CONFLICT, withoutContext.getStatusCode(),
                "WORKSPACE creation without a workspace context must fail explicitly: "
                        + String.valueOf(withoutContext.getBody()));
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", withoutContext.getBody().get("code"));

        ResponseEntity<Map> created = create(workspaceToken(owner, workspace.getId(),
                        WorkspaceRole.OWNER), Map.of("name", "TeamAgent", "scope", "WORKSPACE"));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        UUID principalId = UUID.fromString((String) created.getBody().get("principalId"));
        principals.add(principalId);
        AgentPrincipal stored = principalRepository.findById(principalId).orElseThrow();
        assertEquals("WORKSPACE", stored.getScope());
        assertNull(stored.getOwnerUserId(), "non-PERSONAL principals must not carry an owner");

        ResponseEntity<Map> instanceDenied = create(globalToken(owner),
                Map.of("name", "InstanceAgent", "scope", "INSTANCE"));
        assertEquals(HttpStatus.FORBIDDEN, instanceDenied.getStatusCode(),
                String.valueOf(instanceDenied.getBody()));

        addInstanceActionGrant(owner.getId(), "CREATE_ACCOUNT", "*");
        ResponseEntity<Map> instanceCreated = create(globalToken(owner),
                Map.of("name", "InstanceAgent", "scope", "INSTANCE"));
        assertEquals(HttpStatus.CREATED, instanceCreated.getStatusCode(),
                String.valueOf(instanceCreated.getBody()));
        UUID instancePrincipalId = UUID.fromString((String) instanceCreated.getBody().get("principalId"));
        principals.add(instancePrincipalId);
        assertEquals("INSTANCE",
                principalRepository.findById(instancePrincipalId).orElseThrow().getScope());
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

        ResponseEntity<Map> injected = create(globalToken(admin), Map.of(
                "name", "ForgedOwner",
                "scope", "PERSONAL",
                "ownerUserId", victim.toString()));
        assertEquals(HttpStatus.BAD_REQUEST, injected.getStatusCode(),
                "the frozen create body has no ownerUserId: " + String.valueOf(injected.getBody()));
        assertEquals(principalCount, principalRepository.findAll().size());

        ResponseEntity<Map> created = create(globalToken(admin),
                Map.of("name", "AdminPersonal", "scope", "PERSONAL"));
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        UUID principalId = UUID.fromString((String) created.getBody().get("principalId"));
        principals.add(principalId);
        assertEquals(admin.getId(), principalRepository.findById(principalId).orElseThrow()
                .getOwnerUserId());
        assertEquals(admin.getId().toString(), created.getBody().get("ownerUserId"));
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

        UUID bobPersonal = createPersonal(bob, "BobPrivate");
        UUID alicePersonal = createPersonal(alice, "AlicePrivate");

        ResponseEntity<Map> stolen = putCap(alice, aliceWs.getId(), bobPersonal, List.of());
        assertEquals(HttpStatus.FORBIDDEN, stolen.getStatusCode(),
                "A must not bind B's PERSONAL principal: " + String.valueOf(stolen.getBody()));
        assertEquals("AGENT_PRINCIPAL_OWNER_MISMATCH", stolen.getBody().get("code"));
        assertEquals(false, bindingRepository.existsById(
                new WorkspaceAgentId(bobPersonal, aliceWs.getId())));

        ResponseEntity<Map> editorOwn = putCap(bob, aliceWs.getId(), bobPersonal, List.of());
        assertEquals(HttpStatus.FORBIDDEN, editorOwn.getStatusCode(),
                "binding still requires MANAGE_WORKSPACE_AGENTS: "
                        + String.valueOf(editorOwn.getBody()));

        Workspace bobWs = workspaceFixture.createOwnedWorkspace("Bob ws", bob.getId().toString());
        workspaces.add(bobWs.getId());
        ResponseEntity<Map> ownBinding = putCap(bob, bobWs.getId(), bobPersonal, List.of());
        assertEquals(HttpStatus.OK, ownBinding.getStatusCode(), String.valueOf(ownBinding.getBody()));
        assertEquals(true, bindingRepository.existsById(
                new WorkspaceAgentId(bobPersonal, bobWs.getId())));

        ResponseEntity<Map> aliceOwnBinding = putCap(alice, aliceWs.getId(), alicePersonal, List.of());
        assertEquals(HttpStatus.OK, aliceOwnBinding.getStatusCode(),
                String.valueOf(aliceOwnBinding.getBody()));
    }

    // ---------------------------------------------------------------------------------------------
    // M1.1 "INSTANCE 仅 ADMIN": an INSTANCE principal may only be bound by instance administration,
    // even when the caller already holds MANAGE_WORKSPACE_AGENTS for that Workspace.
    // ---------------------------------------------------------------------------------------------

    @Test
    void instanceScopedPrincipalBindingRequiresInstanceAdmin() throws Exception {
        User owner = newUser("ws-owner2");
        User admin = newUser("instance-admin2");
        grantDefaultService.ensureUserDefault(owner);
        grantDefaultService.ensureUserDefault(admin);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Instance bind ws",
                owner.getId().toString());
        workspaces.add(workspace.getId());
        workspaceFixture.bindWorkspaceRole(workspace.getId(), admin.getId(), WorkspaceRole.EDITOR);
        addInstanceAdminTier(admin.getId());
        addInstanceActionGrant(admin.getId(), "MANAGE_WORKSPACE_AGENTS",
                workspace.getId().toString());

        UUID instancePrincipal = createInstancePrincipal(admin);

        ResponseEntity<Map> denied = putCap(owner, workspace.getId(), instancePrincipal, List.of());
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(),
                "a Workspace owner is not automatically instance administration: "
                        + String.valueOf(denied.getBody()));
        assertEquals("INSTANCE_ADMIN_REQUIRED", denied.getBody().get("code"));
        assertEquals(false, bindingRepository.existsById(
                new WorkspaceAgentId(instancePrincipal, workspace.getId())));

        ResponseEntity<Map> allowed = putCap(admin, workspace.getId(), instancePrincipal, List.of());
        assertEquals(HttpStatus.OK, allowed.getStatusCode(), String.valueOf(allowed.getBody()));
        assertEquals(true, bindingRepository.existsById(
                new WorkspaceAgentId(instancePrincipal, workspace.getId())));
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

        // No MANAGE_WORKSPACE_AGENTS: the legacy CREATE_ACCOUNT path must be gone, so this is 403.
        ResponseEntity<Map> denied = create(globalToken(plain), Map.of("name", "LegacyBody"));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(),
                "an omitted scope must not fall back to the pre-0622 CREATE_ACCOUNT path: "
                        + String.valueOf(denied.getBody()));
        assertEquals(principalCount, principalRepository.findAll().size());

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
        assertEquals("WORKSPACE", created.getBody().get("scope"));
        assertEquals("WORKSPACE", principalRepository.findById(principalId).orElseThrow().getScope());
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
        ResponseEntity<Map> response = create(globalToken(user),
                Map.of("name", name, "scope", "PERSONAL"));
        assertEquals(HttpStatus.CREATED, response.getStatusCode(), String.valueOf(response.getBody()));
        UUID principalId = UUID.fromString((String) response.getBody().get("principalId"));
        principals.add(principalId);
        return principalId;
    }

    private UUID createInstancePrincipal(User creator) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("InstanceSharedAgent");
        principal.setScope("INSTANCE");
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
