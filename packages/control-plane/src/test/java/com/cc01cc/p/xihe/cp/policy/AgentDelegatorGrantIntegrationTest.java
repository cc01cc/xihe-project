package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.chat.ChatBindingTestSupport;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 2026-11-04 ruling (task-25): {@code AGENT_DELEGATOR} actually reaches the run's authorization
 * surface, and the frozen Session snapshot keeps "granted later" from silently applying to old
 * Sessions.
 *
 * <p><b>验收顺序是契约的一部分</b>（快照冻结，见 {@code Session.agentPermissionsSnapshot}）：
 * 绑定 {@code AGENT_DELEGATOR} + 工作区能力上限含 {@code SPAWN_AGENT} → 创建会话 →
 * 会话快照含该原子。反向断言同样重要：事后授予/改上限都<b>不会</b>改写已存在会话的快照——
 * {@code GrantIntersectionEvaluator.allows} 对权限路径取交集，旧快照缺原子即恒 deny。</p>
 *
 * <p>两条真实的"缩小/提权"规则（不是测试取巧）：
 * ① 授予角色受「you cannot grant what you do not hold」约束，所以本测试把操作者提升为实例
 * SUPER_ADMIN（现实中第一个委派角色就是实例管理员发下去的）；
 * ② 工作区绑定自带 narrowing cap（{@code AGENT_PERMISSION_SCOPE_EXCEEDED} 保证 cap ⊆ 主体也 ⊆
 * 操作者），cap 为空即"该工作区内不给任何动作"——所以委派要同时有角色与含该原子的 cap。</p>
 */
class AgentDelegatorGrantIntegrationTest extends AbstractIntegrationTest {

    private static final String SPAWN_AGENT = ToolFaceRegistry.ACTION_SPAWN_AGENT;
    private static final String SPAWN_ATOM_JSON = """
            [{"actionClass":"SPAWN_AGENT","resource":"*"}]""";

    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private RoleGrantMaterializer roleGrantMaterializer;
    @Autowired private AccessRoleBindingRepository roleBindings;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ProviderConnectionRepository providerConnections;

    private String ownerToken;
    private String ownerId;
    private String workspaceId;
    private ProviderConnection connection;

    @BeforeEach
    void fixture() {
        AuthResponse owner = register("p25-delegator");
        ownerToken = owner.getAccessToken();
        ownerId = owner.getUser().getId();
        workspaceId = workspaceFixture.createOwnedWorkspace("P25 delegator ws", ownerId).getId().toString();
        connection = ChatBindingTestSupport.ensureChatConnection(providerConnections, "USER", ownerId,
                "p25-" + UUID.randomUUID().toString().substring(0, 8));
        // 授予角色/上限要求操作者持有同样的原子：把 owner 提升为实例 SUPER_ADMIN（真实路径 = 角色绑定 + 物化）。
        roleBindings.save(new AccessRoleBinding(SystemAccessRoleCatalog.SUPER_ADMIN_ID,
                GrantPrincipalPathResolver.USER, UUID.fromString(ownerId), AccessScope.INSTANCE, null,
                UUID.fromString(ownerId)));
        roleGrantMaterializer.materializeSubject(GrantPrincipalPathResolver.USER,
                UUID.fromString(ownerId), UUID.fromString(ownerId), null);
    }

    @Test
    void bindingTheDelegatorRoleLetsAnAgentSessionCarrySpawnAgent() {
        String principalId = createAgent("Delegator agent",
                List.of(SystemAccessRoleCatalog.AGENT_DELEGATOR_ID));
        bindAgentToWorkspace(principalId, SPAWN_ATOM_JSON);

        String sessionId = createSession(principalId);

        String snapshot = sessionSnapshot(sessionId);
        assertTrue(snapshot.contains(SPAWN_AGENT),
                "会话快照必须含 SPAWN_AGENT，否则 spawn 的授权交集恒 deny: " + snapshot);
        assertTrue(agentPrincipalService.resolveCapFor(principalId, workspaceId).toString()
                        .contains(SPAWN_AGENT),
                "live cap 也必须含该原子（角色绑定 → 物化 grants → 求值）");
    }

    @Test
    void grantIsEffectiveImmediatelyButAnExistingSessionSnapshotStaysFrozen() {
        // 1) 先建会话：此时没有委派角色，cap 也为空 ⇒ 快照不含原子（基线）。
        String principalId = createAgent("Late delegator", List.of());
        bindAgentToWorkspace(principalId, "[]");
        String existingSessionId = createSession(principalId);
        assertFalse(sessionSnapshot(existingSessionId).contains(SPAWN_AGENT),
                "基线：未授予委派角色时快照不应含 SPAWN_AGENT");

        // 2) 事后授予（真实绑定 + 物化），并把工作区 cap 提到含 SPAWN_AGENT。
        grantDelegatorRole(principalId);
        bindAgentToWorkspace(principalId, SPAWN_ATOM_JSON);

        // 3) live cap 立即生效，但旧会话的冻结快照不变 ⇒ 旧会话仍不能委派。
        assertTrue(agentPrincipalService.resolveCapFor(principalId, workspaceId).toString()
                .contains(SPAWN_AGENT), "授予 + cap 之后的 live cap 应立即可见");
        assertFalse(sessionSnapshot(existingSessionId).contains(SPAWN_AGENT),
                "事后授予/改上限不得改写已存在会话的快照（交集求值下这是安全属性）");

        // 4) 验收顺序：绑定 → 建会话 → 断言；新会话拿到该原子。
        assertTrue(sessionSnapshot(createSession(principalId)).contains(SPAWN_AGENT),
                "授予之后创建的会话必须带上 SPAWN_AGENT");
    }

    @Test
    void superAdminRoleStillCannotBeBoundToAnAgentPrincipal() {
        ResponseEntity<Map> response = exchange(HttpMethod.POST, "/api/v1/agent-principals",
                """
                {"name":"Admin-ish agent","scope":"PERSONAL","roleIds":["%s"]}"""
                        .formatted(SystemAccessRoleCatalog.SUPER_ADMIN_ID));
        assertEquals(HttpStatus.FORBIDDEN.value(), response.getStatusCode().value(),
                "实例管理角色对 agent 主体仍然禁绑（2026-11-04 裁定）: " + response.getBody());
        assertNotNull(response.getBody());
        assertEquals("ROLE_NOT_GRANTABLE", String.valueOf(response.getBody().get("code")));
    }

    // ------------------------------------------------------------------ helpers

    private AuthResponse register(String label) {
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest(label + "-" + UUID.randomUUID() + "@test.com",
                        TestDataFactory.PASSWORD, label), AuthResponse.class);
        assertEquals(HttpStatus.CREATED.value(), response.getStatusCode().value());
        assertNotNull(response.getBody());
        return response.getBody();
    }

    private String createAgent(String name, List<UUID> roleIds) {
        String ids = roleIds.stream().map(id -> "\"" + id + "\"")
                .reduce((left, right) -> left + "," + right).orElse("");
        ResponseEntity<Map> response = exchange(HttpMethod.POST, "/api/v1/agent-principals",
                """
                {"name":"%s","scope":"PERSONAL","roleIds":[%s]}""".formatted(name, ids));
        assertEquals(HttpStatus.CREATED.value(), response.getStatusCode().value(),
                "agent principal 创建失败: " + response.getBody());
        return String.valueOf(response.getBody().get("principalId"));
    }

    /** 事后授予：真实写一条 workspace 作用域的角色绑定再物化（与产品绑定路径同语义）。 */
    private void grantDelegatorRole(String principalId) {
        roleBindings.save(new AccessRoleBinding(SystemAccessRoleCatalog.AGENT_DELEGATOR_ID,
                GrantPrincipalPathResolver.AGENT_PRINCIPAL, UUID.fromString(principalId),
                AccessScope.WORKSPACE, UUID.fromString(workspaceId), UUID.fromString(ownerId)));
        roleGrantMaterializer.materializeSubject(GrantPrincipalPathResolver.AGENT_PRINCIPAL,
                UUID.fromString(principalId), UUID.fromString(ownerId), workspaceId);
    }

    private void bindAgentToWorkspace(String principalId, String capJson) {
        ResponseEntity<Map> response = exchange(HttpMethod.PUT,
                "/api/v1/workspaces/" + workspaceId + "/agents/" + principalId,
                """
                {"permissions":%s}""".formatted(capJson));
        assertEquals(HttpStatus.OK.value(), response.getStatusCode().value(),
                "绑定 agent 到工作区失败: " + response.getBody());
    }

    /** 建会话（2026-11-04 P0 起必须带显式绑定）。 */
    private String createSession(String principalId) {
        ResponseEntity<Map> response = exchange(HttpMethod.POST, "/api/v1/sessions",
                """
                {"agentPrincipalId":"%s","modelProvider":"%s","modelName":"gpt-test",
                 "providerConnectionId":"%s"}"""
                        .formatted(principalId, connection.getProviderId(), connection.getId()));
        assertEquals(HttpStatus.CREATED.value(), response.getStatusCode().value(),
                "建会话失败: " + response.getBody());
        return String.valueOf(response.getBody().get("id"));
    }

    private String sessionSnapshot(String sessionId) {
        Session session = sessionRepository.findById(UUID.fromString(sessionId)).orElseThrow();
        return String.valueOf(session.getAgentPermissionsSnapshot());
    }

    private ResponseEntity<Map> exchange(HttpMethod method, String path, String body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(ownerToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-Workspace-Id", workspaceId);
        return restTemplate.exchange(url(path), method, new HttpEntity<>(body, headers), Map.class);
    }
}
