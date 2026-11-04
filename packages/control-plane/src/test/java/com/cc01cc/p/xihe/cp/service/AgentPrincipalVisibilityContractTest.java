package com.cc01cc.p.xihe.cp.service;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;

import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
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
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0622 M1.2 red-first contract test: visibility of the three tiers, the {@code source}
 * projection of {@code GET /workspaces/{ws}/agents}, and the disable route.
 *
 * <p>Written before the implementation on purpose (checklist G2): every assertion below fails on the
 * M1.1 baseline because the route, the {@code source} field or the disable authorization do not
 * exist yet.</p>
 */
class AgentPrincipalVisibilityContractTest extends AbstractIntegrationTest {


    @Autowired
    private AgentPrincipalService agentPrincipalService;
    @Autowired
    private GrantDefaultService grantDefaultService;
    @Autowired
    private WorkspaceFixture workspaceFixture;
    @Autowired
    private com.cc01cc.p.xihe.cp.repository.UserRepository userRepository;
    @Autowired
    private com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository principalRepository;
    @Autowired
    private com.cc01cc.p.xihe.cp.repository.WorkspaceRepository workspaceRepository;
    @Autowired
    private ObjectMapper objectMapper;
    @Autowired
    private JdbcTemplate jdbcTemplate;
    @Autowired
    private com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository bindingRepository;
    @Autowired
    private com.cc01cc.p.xihe.cp.repository.AccessRoleRepository accessRoleRepository;
    @Autowired
    private com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository roleBindingRepository;

    private final List<UUID> seededRoleBindingIds = new ArrayList<>();

    private final List<UUID> users = new ArrayList<>();
    private final List<UUID> workspaces = new ArrayList<>();
    private final List<UUID> principals = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        for (UUID principalId : principals) {
            // Bindings first: fk_workspace_agents_principal would otherwise block the delete.
            bindingRepository.deleteAll(bindingRepository.findByIdPrincipalId(principalId));
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
        for (UUID userId : users) {
            jdbcTemplate.update("DELETE FROM audit_logs WHERE user_id = CAST(? AS UUID)",
                    userId.toString());
            userRepository.deleteById(userId);
        }
        users.clear();
    }

    // -----------------------------------------------------------------------------------------
    // O5: GET /agent-principals?scope=PERSONAL only ever returns the caller's own principals.
    // -----------------------------------------------------------------------------------------

    @Test
    void personalListOnlyReturnsTheCallersOwnPrincipals() {
        User alice = newUser("list-alice");
        User bob = newUser("list-bob");
        grantDefaultService.ensureUserDefault(alice);
        grantDefaultService.ensureUserDefault(bob);
        UUID alicePersonal = createPersonal(alice, "AlicePrivate");
        UUID bobPersonal = createPersonal(bob, "BobPrivate");

        ResponseEntity<Map> response = exchange(HttpMethod.GET,
                "/api/v1/agent-principals?scope=PERSONAL", globalToken(alice), null);
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        List<Map<String, Object>> principals = (List<Map<String, Object>>) response.getBody().get("principals");
        assertNotNull(principals);
        List<String> ids = principals.stream().map(item -> String.valueOf(item.get("principalId"))).toList();
        assertTrue(ids.contains(alicePersonal.toString()), ids.toString());
        assertFalse(ids.contains(bobPersonal.toString()), "another user's PERSONAL principal leaked: " + ids);
        // The response never carries someone else's template or name.
        assertTrue(principals.stream().noneMatch(item -> "BobPrivate".equals(item.get("name"))));
    }

    // -----------------------------------------------------------------------------------------
    // M1.2: GET /workspaces/{ws}/agents merges the three tiers and labels each row with `source`.
    // -----------------------------------------------------------------------------------------

    @Test
    void workspaceAgentsMergeThreeSourcesWithSourceAndSnapshot() {
        User owner = newUser("merge-owner");
        grantDefaultService.ensureUserDefault(owner);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Merge ws", owner.getId().toString());
        workspaces.add(workspace.getId());

        UUID workspaceScoped = createWithScope(workspaceToken(owner, workspace.getId(), WorkspaceRole.OWNER),
                "WorkspaceScoped", "WORKSPACE");
        UUID personalScoped = createPersonal(owner, "OwnerPersonal");
        UUID instanceScoped = createInstancePrincipal(owner);
        // The three bindable ones are actually bound to the workspace. INSTANCE binding is instance
        // administration only (M1.1), so a seeded admin performs that one binding.
        bindViaApi(owner, workspace.getId(), workspaceScoped);
        bindViaApi(owner, workspace.getId(), personalScoped);
        User admin = newUser("merge-admin");
        grantDefaultService.ensureUserDefault(admin);
        makeInstanceAdmin(admin);
        workspaceFixture.bindWorkspaceRole(workspace.getId(), admin.getId(), WorkspaceRole.OWNER);
        bindViaApi(admin, workspace.getId(), instanceScoped);

        ResponseEntity<Map> response = exchange(HttpMethod.GET,
                "/api/v1/workspaces/" + workspace.getId() + "/agents",
                workspaceToken(owner, workspace.getId(), WorkspaceRole.OWNER), null);
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        List<Map<String, Object>> agents = (List<Map<String, Object>>) response.getBody().get("agents");
        assertNotNull(agents, "the response must be the frozen {agents:[...]} envelope");
        assertEquals(3, agents.size(), agents.toString());
        assertEquals("workspace", sourceOf(agents, workspaceScoped));
        assertEquals("personal", sourceOf(agents, personalScoped));
        assertEquals("instance", sourceOf(agents, instanceScoped));
        // `permissionsSnapshot` replaces the pre-0622 `permissions` field name.
        assertTrue(agents.stream().allMatch(item -> item.containsKey("permissionsSnapshot")),
                agents.toString());
        assertTrue(agents.stream().noneMatch(item -> item.containsKey("permissions")));
    }

    // -----------------------------------------------------------------------------------------
    // M1.2: disable answers 204 and leaves an `agent_principal_disabled` audit trail.
    // -----------------------------------------------------------------------------------------

    @Test
    void disableAnswersNoContentAndWritesAudit() {
        User owner = newUser("disable-owner");
        grantDefaultService.ensureUserDefault(owner);
        UUID personal = createPersonal(owner, "DisableMe");

        ResponseEntity<Map> response = exchange(HttpMethod.POST,
                "/api/v1/agent-principals/" + personal + "/disable", globalToken(owner), null);
        assertEquals(HttpStatus.NO_CONTENT, response.getStatusCode(), String.valueOf(response.getBody()));
        assertNotNull(principalRepository.findById(personal).orElseThrow().getDisabledAt());
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_disabled' "
                        + "AND CAST(resource_id AS VARCHAR) = ?", Integer.class, personal.toString()));
    }

    // -----------------------------------------------------------------------------------------
    // D27: the list must carry `disabled`, or a successful disable is invisible in the UI (S3).
    // -----------------------------------------------------------------------------------------

    @Test
    void aDisabledPrincipalIsReportedInTheListAndAnActiveOneIsNot() {
        User owner = newUser("d27-owner");
        grantDefaultService.ensureUserDefault(owner);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("D27 ws", owner.getId().toString());
        workspaces.add(workspace.getId());
        UUID disabled = createPersonal(owner, "D27Disabled");
        UUID active = createPersonal(owner, "D27Active");
        // 2026-11-04 裁定：列表只含「绑定了这里 ∪ 在这里持有角色绑定」的主体。
        bindViaApi(owner, workspace.getId(), disabled);
        bindViaApi(owner, workspace.getId(), active);

        assertEquals(HttpStatus.NO_CONTENT, exchange(HttpMethod.POST,
                "/api/v1/agent-principals/" + disabled + "/disable", globalToken(owner), null).getStatusCode());

        List<Map<String, Object>> agents = listAgents(owner, workspace);
        assertTrue(disabledOf(agents, disabled), "D27: the disabled flag must reach the list projection");
        assertFalse(disabledOf(agents, active));
        // 2026-11-04 裁定：列表只含有 reach 的主体，所以这里的行既有绑定又要如实报 disabled。
        assertTrue(boundOf(agents, disabled), "an entry only exists because it is bound; flags stay honest");
    }

    // -----------------------------------------------------------------------------------------
    // O6: disable needs the tier's authority — a stranger cannot disable somebody else's agent.
    // -----------------------------------------------------------------------------------------

    @Test
    void disableRequiresTheTierAuthority() {
        User owner = newUser("disable-authority-owner");
        User stranger = newUser("disable-authority-stranger");
        grantDefaultService.ensureUserDefault(owner);
        grantDefaultService.ensureUserDefault(stranger);
        UUID personal = createPersonal(owner, "OwnerOnly");

        ResponseEntity<Map> denied = exchange(HttpMethod.POST,
                "/api/v1/agent-principals/" + personal + "/disable", globalToken(stranger), null);
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(), String.valueOf(denied.getBody()));
        assertNull(principalRepository.findById(personal).orElseThrow().getDisabledAt(),
                "a denied disable must not touch the row");
    }

    // -----------------------------------------------------------------------------------------
    // V15: disabling takes effect on the NEXT submission of an EXISTING session, not only for new
    // sessions. The chat path resolves the cap through `resolveSessionCap`, which is the same gate
    // `ChatSubmissionService` uses for every submission, so asserting it here proves the second
    // submission fails without rebuilding the whole run fixture.
    // -----------------------------------------------------------------------------------------

    @Test
    void disabledPrincipalBlocksTheNextSubmissionOfAnExistingSession() {
        User owner = newUser("v15-owner");
        grantDefaultService.ensureUserDefault(owner);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("V15 ws", owner.getId().toString());
        workspaces.add(workspace.getId());
        UUID personal = createPersonal(owner, "V15Agent");
        bindViaApi(owner, workspace.getId(), personal);

        // Before disabling the binding resolves (this is what the first submission already used).
        assertNotNull(agentPrincipalService.resolveSessionCap(
                personal.toString(), workspace.getId().toString()));

        exchange(HttpMethod.POST, "/api/v1/agent-principals/" + personal + "/disable",
                globalToken(owner), null);

        var failure = assertThrows(com.cc01cc.p.xihe.cp.config.CpApiException.class,
                () -> agentPrincipalService.resolveSessionCap(
                        personal.toString(), workspace.getId().toString()));
        assertEquals(HttpStatus.CONFLICT, failure.getStatus());
        assertEquals("AGENT_PRINCIPAL_DISABLED", failure.getCode());
    }

    // -----------------------------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------------------------

    // -----------------------------------------------------------------------------------------
    // 2026-11-04 裁定（PLAN-0629「角色绑定替代 scope」）：workspace agent 列表 = 「绑定了这里」∪
    // 「在这里持有 workspace 角色绑定」。legacy scope 查询已删除，所以**未绑定、也没有角色绑定**的
    // PERSONAL/INSTANCE 主体不再出现（原断言"union of three sources / unbound 也可见"是旧契约）。
    // 规则断言：未绑定 ⇒ 不出现；绑定后 ⇒ 以它自己的 source 出现且 bound=true。
    // -----------------------------------------------------------------------------------------

    @Test
    void anUnboundPersonalPrincipalIsNotListedAndABoundOneIs() {
        User owner = newUser("unbound-owner");
        grantDefaultService.ensureUserDefault(owner);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Unbound ws", owner.getId().toString());
        workspaces.add(workspace.getId());
        UUID personal = createPersonal(owner, "UnboundPersonal");

        List<Map<String, Object>> unbound = listAgents(owner, workspace);
        assertFalse(listed(unbound, personal),
                "reach is a role/binding, not the legacy scope column: an unbound PERSONAL principal "
                        + "must not be listed here: " + unbound);

        bindViaApi(owner, workspace.getId(), personal);
        List<Map<String, Object>> agents = listAgents(owner, workspace);

        assertEquals("personal", sourceOf(agents, personal),
                "source describes what the principal IS, not that it is bound");
        assertTrue(boundOf(agents, personal), "D26: a bound row reports bound=true");
        assertTrue(agents.stream().allMatch(item -> item.containsKey("permissionsSnapshot")), agents.toString());
    }

    @Test
    void anUnboundInstancePrincipalIsNotListedAndABoundOneIs() {
        User owner = newUser("unbound-instance-owner");
        grantDefaultService.ensureUserDefault(owner);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Unbound inst ws", owner.getId().toString());
        workspaces.add(workspace.getId());
        UUID instance = createInstancePrincipal(owner);

        assertFalse(listed(listAgents(owner, workspace), instance),
                "an INSTANCE principal that holds no reach here must not be listed (role/binding is the reach)");

        // INSTANCE 主体的 cap 绑定只允许实例管理员；用 workspace 作用域角色绑定表达"在这里有 reach"。
        bindViaWorkspaceRole(owner, workspace.getId(), instance);
        List<Map<String, Object>> agents = listAgents(owner, workspace);

        assertEquals("instance", sourceOf(agents, instance));
        assertFalse(boundOf(agents, instance),
                "`bound` means an explicit cap binding exists; a role-only reach stays false");
    }

    @Test
    void anotherUsersPersonalPrincipalIsNotListed() {
        User alice = newUser("o5-alice");
        User bob = newUser("o5-bob");
        grantDefaultService.ensureUserDefault(alice);
        grantDefaultService.ensureUserDefault(bob);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("O5 ws", alice.getId().toString());
        workspaces.add(workspace.getId());
        UUID bobPersonal = createPersonal(bob, "BobPrivate");

        List<Map<String, Object>> agents = listAgents(alice, workspace);

        assertTrue(agents.stream().noneMatch(item -> bobPersonal.toString()
                        .equals(String.valueOf(item.get("principalId")))),
                "O5: another account's PERSONAL principal must never leak into the list: " + agents);
    }

    @Test
    void aBoundPersonalPrincipalKeepsThePersonalSourceAndAppearsOnce() {
        User owner = newUser("both-owner");
        grantDefaultService.ensureUserDefault(owner);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Both ws", owner.getId().toString());
        workspaces.add(workspace.getId());
        UUID personal = createPersonal(owner, "BoundPersonal");
        bindViaApi(owner, workspace.getId(), personal);

        List<Map<String, Object>> agents = listAgents(owner, workspace);

        long rows = agents.stream().filter(item -> personal.toString()
                .equals(String.valueOf(item.get("principalId")))).count();
        assertEquals(1, rows, "deduplicated by principal id: " + agents);
        assertEquals("personal", sourceOf(agents, personal), "source describes what it is, not that it is bound");
        assertTrue(boundOf(agents, personal), "D26: a bound row reports bound=true");
    }

    @Test
    void theListIsOrderedBySourceThenName() {
        User owner = newUser("order-owner");
        grantDefaultService.ensureUserDefault(owner);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Order ws", owner.getId().toString());
        workspaces.add(workspace.getId());
        UUID workspaceScoped = createWithScope(
                workspaceToken(owner, workspace.getId(), WorkspaceRole.OWNER), "ZWorkspace", "WORKSPACE");
        bindViaApi(owner, workspace.getId(), workspaceScoped);
        // 2026-11-04 裁定：source 仍描述主体类型，但只有"在这里有 reach"的主体才进列表。
        bindViaApi(owner, workspace.getId(), createPersonal(owner, "APersonal"));
        bindViaWorkspaceRole(owner, workspace.getId(), createInstancePrincipal(owner));

        List<String> sources = listAgents(owner, workspace).stream()
                .map(item -> String.valueOf(item.get("source"))).toList();

        assertEquals(List.of("workspace", "personal", "instance"), sources, "stable source order");
    }

    private List<Map<String, Object>> listAgents(User caller, Workspace workspace) {
        ResponseEntity<Map> response = exchange(HttpMethod.GET,
                "/api/v1/workspaces/" + workspace.getId() + "/agents",
                workspaceToken(caller, workspace.getId(), WorkspaceRole.OWNER), null);
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        List<Map<String, Object>> agents = (List<Map<String, Object>>) response.getBody().get("agents");
        assertNotNull(agents, "the response must be the frozen {agents:[...]} envelope");
        return agents;
    }

    /** Seeds a real instance ADMIN tier binding (capability authority reads bindings, not grants). */
    private void makeInstanceAdmin(User user) {
        var adminRole = accessRoleRepository.findByName("ADMIN")
                .orElseThrow(() -> new IllegalStateException("ADMIN role missing (V87)"));
        var binding = roleBindingRepository.save(new com.cc01cc.p.xihe.cp.entity.AccessRoleBinding(
                adminRole.getId(), "user", user.getId(), AccessScope.INSTANCE, null, user.getId()));
        seededRoleBindingIds.add(binding.getId());
    }

    private User newUser(String label) {
        User user = userRepository.saveAndFlush(new User(
                "plan0622-" + label + "-" + UUID.randomUUID() + "@test.com", "hash", label));
        users.add(user.getId());
        return user;
    }

    private boolean listed(List<Map<String, Object>> agents, UUID principalId) {
        return agents.stream().anyMatch(item -> principalId.toString()
                .equals(String.valueOf(item.get("principalId"))));
    }

    private boolean disabledOf(List<Map<String, Object>> agents, UUID principalId) {
        return agents.stream()
                .filter(item -> principalId.toString().equals(String.valueOf(item.get("principalId"))))
                .map(item -> Boolean.TRUE.equals(item.get("disabled")))
                .findFirst()
                .orElseThrow(() -> new AssertionError("principal not listed: " + principalId));
    }

    private boolean boundOf(List<Map<String, Object>> agents, UUID principalId) {
        return agents.stream()
                .filter(item -> principalId.toString().equals(String.valueOf(item.get("principalId"))))
                .map(item -> Boolean.TRUE.equals(item.get("bound")))
                .findFirst()
                .orElseThrow(() -> new AssertionError("principal not listed: " + principalId));
    }

    private String sourceOf(List<Map<String, Object>> agents, UUID principalId) {
        return agents.stream()
                .filter(item -> principalId.toString().equals(String.valueOf(item.get("principalId"))))
                .map(item -> String.valueOf(item.get("source")))
                .findFirst()
                .orElseThrow(() -> new AssertionError("principal not listed: " + principalId));
    }

    private UUID createPersonal(User user, String name) {
        return createWithScope(globalToken(user), name, "PERSONAL");
    }

    private UUID createWithScope(String token, String name, String scope) {
        ResponseEntity<Map> response = exchange(HttpMethod.POST, "/api/v1/agent-principals", token,
                Map.of("name", name, "scope", scope));
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
        principal.setCreatedByUserId(creator.getId().toString());
        UUID principalId = principalRepository.saveAndFlush(principal).getId();
        principals.add(principalId);
        return principalId;
    }

    private void bindViaApi(User actor, UUID workspaceId, UUID principalId) {
        ResponseEntity<Map> response = exchange(HttpMethod.PUT,
                "/api/v1/workspaces/" + workspaceId + "/agents/" + principalId,
                workspaceToken(actor, workspaceId, WorkspaceRole.OWNER),
                Map.of("permissions", List.of()));
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
    }

    /** INSTANCE 主体不能走 cap 绑定（只有实例管理员可以），用 workspace 作用域角色绑定表达 reach。 */
    private void bindViaWorkspaceRole(User actor, UUID workspaceId, UUID principalId) {
        var role = accessRoleRepository.findByName(SystemAccessRoleCatalog.WS_VIEWER)
                .orElseThrow(() -> new IllegalStateException("WS_VIEWER role missing (V87)"));
        var binding = roleBindingRepository.save(new com.cc01cc.p.xihe.cp.entity.AccessRoleBinding(
                role.getId(), "agent_principal", principalId, AccessScope.WORKSPACE, workspaceId,
                actor.getId()));
        seededRoleBindingIds.add(binding.getId());
    }

    private String globalToken(User user) {
        return TestDataFactory.createGlobalToken(user.getId().toString(), user.getEmail(), "USER", 0);
    }

    private String workspaceToken(User user, UUID workspaceId, WorkspaceRole role) {
        return TestDataFactory.createWorkspaceToken(user.getId().toString(), user.getEmail(),
                role.name(), workspaceId.toString(), 0);
    }

    private ResponseEntity<Map> exchange(HttpMethod method, String path, String token, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(url(path), method, new HttpEntity<>(body, headers), Map.class);
    }
}
