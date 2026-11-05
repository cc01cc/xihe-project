package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.policy.GrantPrincipalPathResolver;
import com.cc01cc.p.xihe.cp.policy.PermissionAtomCatalog;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0629 task-12 (user ruling 2026-11-04 option A): an agent principal's permission is a
 * <b>role binding</b>. The ruling is only worth anything if binding actually changes behaviour
 * immediately, so this class asserts the two states plus the guard rails around them:
 *
 * <ol>
 *   <li>bind &rarr; effective <b>now</b> (the workspace's atoms appear as {@code source='role'});</li>
 *   <li>unbind &rarr; gone <b>now</b> (and the row disappears from the workspace list);</li>
 *   <li>an instance-administrator role cannot be bound to an agent principal at all;</li>
 *   <li>an unknown role id is refused with the same stable code (no existence leak);</li>
 *   <li>a principal with <b>no</b> role rows still works through the legacy ceiling — the rollback
 *       promise of the retirement.</li>
 * </ol>
 */
class AgentPrincipalRoleBindingIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private AgentPrincipalService agentPrincipalService;
    @Autowired
    private AgentTemplateService agentTemplateService;
    @Autowired
    private AccessRoleRepository roleRepository;
    @Autowired
    private AccessRoleBindingRepository roleBindingRepository;
    @Autowired
    private AuthorizationGrantRepository grantRepository;
    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired
    private UserRepository userRepository;
    @Autowired
    private WorkspaceFixture workspaceFixture;
    @Autowired
    private ObjectMapper objectMapper;

    private String userId;
    private String token;
    private UUID workspaceId;

    @BeforeEach
    void setUpOwnerWorkspace() {
        String email = "plan0629-roles-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> registered = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "RoleBindingTest"), AuthResponse.class);
        assertEquals(HttpStatus.CREATED, registered.getStatusCode());
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        token = registered.getBody().getAccessToken();
        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(user.getId());
        workspaceId = workspace.getId();
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId, WorkspaceRole.OWNER);
    }

    @Test
    void bindTakesEffectImmediately() {
        AgentPrincipal principal = createPlainPrincipal("bindEffective");
        assertEquals(0, roleGrants(principal.getId(), GrantSources.ROLE).size(),
                "a fresh principal has no workspace role grants");

        bindToWorkspace(principal.getId());

        List<String> atoms = roleAtomNames(principal.getId());
        assertTrue(atoms.containsAll(List.of("read", "write", "exec")),
                "WS_EDITOR atoms must be materialized right away: " + atoms);
        assertTrue(roleBindingRepository
                        .findBySubjectTypeAndScopeTypeAndScopeId(
                                GrantPrincipalPathResolver.AGENT_PRINCIPAL, "workspace", workspaceId)
                        .stream().anyMatch(row -> principal.getId().equals(row.getSubjectId())),
                "the workspace role binding is the source of that effect");
    }

    /**
     * BL-349 (P0 regression guard): BL-345 put MEMORY_WRITE_SELF on WS_* roles, which turned every
     * "bind an agent to a workspace with a default workspace role" call into 403 ROLE_NOT_GRANTABLE
     * (the atom is agent-forbidden). This test binds the editor role and asserts both halves of the
     * fix: the binding succeeds, and the materialized agent atoms never contain SELF.
     */
    @Test
    void defaultWorkspaceRoleBindsToAgentAndCarriesNoAgentForbiddenAtom() {
        AgentPrincipal principal = createPlainPrincipal("bl349Bindable");
        bindToWorkspace(principal.getId());

        List<String> atoms = roleAtomNames(principal.getId());
        assertTrue(atoms.containsAll(List.of("read", "write", "exec")),
                "the editor binding must take effect: " + atoms);
        assertFalse(atoms.contains(ToolFaceRegistry.ACTION_MEMORY_WRITE_SELF),
                "BL-349: a workspace role must not hand MEMORY_WRITE_SELF (agent-forbidden) to an agent");
        assertTrue(PermissionAtomCatalog.canBindToAgentPrincipal(atoms),
                "every atom materialized from a workspace role must be agent-bindable");
    }

    /**
     * BL-349 end-to-end at the HTTP boundary (the exact call e2e made):
     * {@code PUT /api/v1/workspaces/{ws}/agents/{principal}} with the default workspace role must
     * return 200 — before the fix it was 403 ROLE_NOT_GRANTABLE because WS_EDITOR (the default agent
     * workspace role) carried the agent-forbidden MEMORY_WRITE_SELF. Also asserts the materialized
     * atoms of the agent no longer contain that atom.
     */
    @Test
    void httpWorkspaceBindingOfDefaultRoleSucceedsAndCarriesNoSelfAtom() {
        AgentPrincipal principal = createPlainPrincipal("bl349Http");

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.add("X-Workspace-Id", workspaceId.toString());
        Map<String, Object> body = Map.of("permissions",
                List.of(Map.of("actionClass", "read", "resource", "*")));
        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/workspaces/" + workspaceId + "/agents/" + principal.getId(),
                org.springframework.http.HttpMethod.PUT, new HttpEntity<>(body, headers), Map.class);

        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals(principal.getId().toString(), response.getBody().get("principalId"));
        assertEquals(workspaceId.toString(), response.getBody().get("workspaceId"));
        List<String> atoms = roleAtomNames(principal.getId());
        assertFalse(atoms.contains(ToolFaceRegistry.ACTION_MEMORY_WRITE_SELF),
                "BL-349: binding must not hand the agent the agent-forbidden SELF atom: " + atoms);
    }

    @Test
    void unbindRevokesImmediately() {
        AgentPrincipal principal = createPlainPrincipal("unbind");
        bindToWorkspace(principal.getId());
        assertFalse(roleGrants(principal.getId(), GrantSources.ROLE).isEmpty());

        assertTrue(agentPrincipalService.unbindWorkspace(userId, workspaceId, principal.getId()));

        assertEquals(0, roleGrants(principal.getId(), GrantSources.ROLE).size(),
                "unbinding must remove the workspace role grants in the same transaction");
        assertFalse(agentPrincipalService.listWorkspaceAgents(userId, workspaceId).stream()
                        .anyMatch(view -> principal.getId().equals(view.principalId())),
                "and the row must disappear from the workspace list");
    }

    @Test
    void instanceAdminRoleCannotBeBoundToAnAgentPrincipal() {
        AccessRole admin = roleRepository.findByName("ADMIN").orElseThrow();
        CpApiException refused = assertThrows(CpApiException.class,
                () -> createPlainPrincipal("adminRole", List.of(admin.getId())));
        assertEquals(HttpStatus.FORBIDDEN, refused.getStatus());
        assertEquals("ROLE_NOT_GRANTABLE", refused.getCode());
        assertTrue(refused.getMessage().contains("instance-admin role"),
                "the detail names the rule: " + refused.getMessage());
    }

    @Test
    void unknownRoleIdIsRefusedWithTheSameStableCode() {
        CpApiException refused = assertThrows(CpApiException.class,
                () -> createPlainPrincipal("bogusRole", List.of(UUID.randomUUID())));
        assertEquals(HttpStatus.FORBIDDEN, refused.getStatus());
        assertEquals("ROLE_NOT_GRANTABLE", refused.getCode(),
                "no 404: the code must not leak which roles exist");
    }

    /**
     * PLAN-0673 V3.2 缺口闭合（audit-1 §5.2）：创建路径的**默认角色**（{@code AGENT_USER}）也是一次
     * 授予，creator 不持有它的原子时必须被拒 —— 且在任何 principal 行写入之前。
     *
     * <p>为什么单列：{@code SetWorkspaceCapGate#grantorWithoutDefaultRoleAtomsIsRefusedWithZeroWrites}
     * 只覆盖 workspace 侧的结构性默认绑定，覆盖不到"创建路径的实例级默认角色"；而默认授予集恰好是
     * 最容易悄悄放水的地方（creator 被收窄后仍能造出带默认权限的 agent）。</p>
     */
    @Test
    void creatingAPrincipalWhoseDefaultRoleAtomsTheCreatorLacksIsRefused() {
        User weakCreator = userRepository.saveAndFlush(new User(
                "audit-weak-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com",
                "hash", "Weak creator"));
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        long principalsBefore = agentPrincipalRepository.count();

        CpApiException refused = assertThrows(CpApiException.class,
                () -> agentPrincipalService.createPrincipal(weakCreator.getId().toString(),
                        "WeakCreatorAgent", null, snapshot));

        assertEquals(HttpStatus.FORBIDDEN, refused.getStatus(), refused.getMessage());
        assertEquals("PRIVILEGE_ESCALATION", refused.getCode(),
                "the default role is a grant: the creator must hold its atoms at the instance scope");
        assertTrue(refused.getMessage().contains("read"),
                "the refusal names the default-role atoms it cannot grant: " + refused.getMessage());
        assertEquals(principalsBefore, agentPrincipalRepository.count(),
                "a refused creation writes no principal row (zero partial write)");
    }

    @Test
    void principalWithoutRoleRowsStillWorksThroughTheLegacyCeiling() {
        AgentPrincipal principal = createPlainPrincipal("legacyFallback");
        bindToWorkspace(principal.getId());
        // Simulate a pre-ruling row: drop the role side entirely, leave a legacy snapshot behind.
        roleBindingRepository.deleteAll(roleBindingRepository
                .findBySubjectTypeAndScopeTypeAndScopeId(
                        GrantPrincipalPathResolver.AGENT_PRINCIPAL, "workspace", workspaceId));
        grantRepository.deleteAll(roleGrants(principal.getId(), GrantSources.ROLE));
        AuthorizationGrant legacy = new AuthorizationGrant();
        legacy.setId(UUID.randomUUID());
        legacy.setSubjectType(GrantPrincipalPathResolver.AGENT_PRINCIPAL);
        legacy.setSubjectId(principal.getId());
        legacy.setSource(GrantSources.AGENT_DEFAULT);
        legacy.setScopeType("workspace");
        legacy.setScopeId(workspaceId);
        legacy.setReadState("read");
        legacy.setPermissions(objectMapper.createArrayNode()
                .add(objectMapper.createObjectNode()
                        .put("actionClass", "read").put("resource", "*")));
        grantRepository.saveAndFlush(legacy);

        var cap = agentPrincipalService.resolveCapFor(principal.getId(), workspaceId);

        assertTrue(cap.toString().contains("read"),
                "a principal without role rows keeps the legacy ceiling (rollback path): " + cap);
    }

    /**
     * BL-352：**首绑的正确入口是 PUT**（结构化默认绑定，不受 cap 门约束），roles 端点只在有 cap 后可用。
     * 这条闭环同时证明：①纯 API 自举可行 ②严格路径（会话/派发前置）未被放宽 ③cap 不变量仍然生效。
     */
    @Test
    void workspaceOwnerBootstrapsWithPutThenRolesBindAndStrictPathStaysIntact() {
        AgentPrincipal principal = createPlainPrincipal("bl352putbootstrap");
        assertFalse(workspaceAgentRepository.findById(
                new com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId(principal.getId(), workspaceId)).isPresent(),
                "precondition: a fresh principal has no workspace binding yet");

        ResponseEntity<Map> put = putWorkspaceAgent(principal.getId(), token, List.of());
        assertEquals(HttpStatus.OK, put.getStatusCode(), String.valueOf(put.getBody()));

        var cap = agentPrincipalService.resolveCapFor(principal.getId(), workspaceId);
        assertTrue(cap.isArray(), "strict resolveCapFor must succeed after the PUT bootstrap: " + cap);

        // ③ cap 不变量仍然生效：PUT 给的是**空 cap**，所以 roles 端点加角色必须被拒（409 设计行为，
        //    这正是"roles 不能当首绑入口"的代码依据，也是我们**没有**放宽 cap 的证明）。
        ResponseEntity<Map> roles = bindRoleAs(principal.getId(), token);
        assertEquals(HttpStatus.CONFLICT, roles.getStatusCode(), String.valueOf(roles.getBody()));
        assertEquals("ROLE_BINDING_EXCEEDS_CAP", roles.getBody().get("code"));
    }

    /** BL-352 负例 1：**非创建者 + 有原子但未绑定** ⇒ 404（不放宽成"同工作区管理员想绑谁绑谁"）。 */
    @Test
    void nonCreatorWithAtomButUnboundIsStillNotFound() {
        AgentPrincipal principal = createPlainPrincipal("bl352notcreator");
        Bl352Caller other = registerWithRole("bl352-other", WorkspaceRole.OWNER);

        ResponseEntity<Map> response = bindRoleAs(principal.getId(), other.token());

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals("AGENT_PRINCIPAL_NOT_FOUND", response.getBody().get("code"));
    }

    /** BL-352 负例 2：**创建者本人但没有 MANAGE_WORKSPACE_AGENTS** ⇒ 403（创建者身份不能替代原子）。 */
    @Test
    void creatorWithoutManagementAtomIsForbidden() {
        Bl352Caller viewer = registerWithRole("bl352-viewercreator", WorkspaceRole.VIEWER);
        var template = agentTemplateService.resolveForCreation(viewer.userId(), workspaceId.toString(), null);
        AgentPrincipal principal = agentPrincipalService.createPrincipal(viewer.userId(), "bl352viewer",
                null, template.snapshot(), null, null, null, null, null, null, List.of());

        ResponseEntity<Map> response = bindRoleAs(principal.getId(), viewer.token());

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals("FORBIDDEN", response.getBody().get("code"));
    }

    /** BL-352 负例 3：**非创建者且无原子** ⇒ 403（原子门先拦，不是"看不见"）。 */
    @Test
    void nonCreatorWithoutAtomIsForbidden() {
        AgentPrincipal principal = createPlainPrincipal("bl352noatom");
        Bl352Caller nobody = registerWithRole("bl352-nobody", WorkspaceRole.VIEWER);

        ResponseEntity<Map> response = bindRoleAs(principal.getId(), nobody.token());

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), String.valueOf(response.getBody()));
    }

    private record Bl352Caller(String token, String userId) {}

    /** 注册一个新用户并给它在该工作区的角色（OWNER 持有 MANAGE_WORKSPACE_AGENTS，VIEWER 不持有）。 */
    private Bl352Caller registerWithRole(String prefix, WorkspaceRole role) {
        String email = prefix + "-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> registered = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "Bl352"), AuthResponse.class);
        assertEquals(HttpStatus.CREATED, registered.getStatusCode());
        User user = userRepository.findByEmail(email).orElseThrow();
        workspaceFixture.bindWorkspaceRole(workspaceId, user.getId(), role);
        return new Bl352Caller(registered.getBody().getAccessToken(), user.getId().toString());
    }

    private ResponseEntity<Map> putWorkspaceAgent(UUID principalId, String callerToken,
            List<Map<String, Object>> permissions) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(callerToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.add("X-Workspace-Id", workspaceId.toString());
        return restTemplate.exchange(
                baseUrl + "/api/v1/workspaces/" + workspaceId + "/agents/" + principalId,
                org.springframework.http.HttpMethod.PUT,
                new HttpEntity<>(Map.of("permissions", permissions), headers), Map.class);
    }

    private ResponseEntity<Map> bindRoleAs(UUID principalId, String callerToken) {
        Map<String, Object> body = Map.of("roleId",
                roleRepository.findByName("WS_EDITOR").orElseThrow().getId().toString());
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(callerToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(
                baseUrl + "/api/v1/agent-principals/" + principalId + "/roles?workspaceId=" + workspaceId,
                org.springframework.http.HttpMethod.POST, new HttpEntity<>(body, headers), Map.class);
    }
    private AgentPrincipal createPlainPrincipal(String name) {
        return createPlainPrincipal(name, List.of());
    }

    private AgentPrincipal createPlainPrincipal(String name, List<UUID> roleIds) {
        var template = agentTemplateService.resolveForCreation(userId, workspaceId.toString(), null);
        return agentPrincipalService.createPrincipal(userId, name, null, template.snapshot(),
                null, null, null, null, null, null, roleIds);
    }

    /** A minimal cap that both the principal and the actor hold — the binding is optional narrowing. */
    private void bindToWorkspace(UUID principalId) {
        var cap = objectMapper.createArrayNode()
                .add(objectMapper.createObjectNode().put("actionClass", "read").put("resource", "*"));
        agentPrincipalService.setWorkspaceCap(userId, workspaceId, principalId, cap);
    }

    private List<AuthorizationGrant> roleGrants(UUID principalId, String source) {
        return grantRepository
                .findScopedGrants(GrantPrincipalPathResolver.AGENT_PRINCIPAL, principalId,
                        List.of(source), workspaceId)
                .stream()
                .filter(row -> "workspace".equals(row.getScopeType()))
                .toList();
    }

    private List<String> roleAtomNames(UUID principalId) {
        return roleGrants(principalId, GrantSources.ROLE).stream()
                .map(row -> row.getPermissions().path(0).path("actionClass").asText())
                .toList();
    }
}
