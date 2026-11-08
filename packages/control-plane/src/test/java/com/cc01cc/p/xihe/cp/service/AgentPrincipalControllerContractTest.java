package com.cc01cc.p.xihe.cp.service;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AccessRolePermission;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRolePermissionRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.fasterxml.jackson.databind.JsonNode;
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

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AgentPrincipalControllerContractTest extends AbstractReusableIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private WorkspaceAgentRepository bindingRepository;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRolePermissionRepository permissionRepository;
    @Autowired private AccessRoleBindingRepository roleBindingRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private com.cc01cc.p.xihe.cp.integration.WorkspaceFixture workspaceFixture;
    @Autowired private com.cc01cc.p.xihe.cp.policy.GrantDefaultService grantDefaultService;

    private UUID userId;
    private String token;
    private UUID workspaceId;
    private final List<UUID> testRoleIds = new java.util.ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        if (userId != null) {
            List<UUID> principalIds = jdbcTemplate.queryForList(
                    "SELECT id FROM agent_principals WHERE created_by_user_id = ?::uuid", UUID.class, userId.toString());
            for (UUID principalId : principalIds) {
                bindingRepository.deleteAll(bindingRepository.findByIdPrincipalId(principalId));
                grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("agent_principal", principalId));
                jdbcTemplate.update("DELETE FROM audit_logs WHERE resource_type = 'agent_principal' "
                        + "AND CAST(resource_id AS VARCHAR) = ?", principalId.toString());
                principalRepository.deleteById(principalId);
            }
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", userId));
            roleBindingRepository.deleteAll(
                    roleBindingRepository.findBySubjectTypeAndSubjectId("user", userId));
            userRepository.deleteById(userId);
        }
        for (UUID roleId : testRoleIds) {
            permissionRepository.deleteAll(permissionRepository.findByIdRoleId(roleId));
            accessRoleRepository.deleteById(roleId);
        }
        testRoleIds.clear();
    }

    @Test
    void createAccountRequiresIndependentGrantAndCreatesSnapshotWithoutWorkspaceBinding() throws Exception {
        fixture();
        int principalCount = principalRepository.findAll().size();

        ResponseEntity<Map> denied = create(Map.of("name", "NoGrant"));
        // Layer 1 of 2: no workspace context ⇒ the precondition fails closed (409), not the atom gate.
        assertEquals(HttpStatus.CONFLICT, denied.getStatusCode(), String.valueOf(denied.getBody()));
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", denied.getBody().get("code"));
        // Layer 2 of 2: valid workspace context, no MANAGE_WORKSPACE_AGENTS ⇒ 403 (the original intent;
        // asserting only the 409 above would let the atom gate disappear unnoticed).
        ResponseEntity<Map> forbidden = create(Map.of("name", "NoGrantInContext"), workspaceId);
        assertEquals(HttpStatus.FORBIDDEN, forbidden.getStatusCode(), String.valueOf(forbidden.getBody()));
        assertEquals(principalCount, principalRepository.findAll().size());
        assertEquals(0, auditCount());

        addGrant("MANAGE_WORKSPACE_AGENTS", "*");
        // B 类（BL-326，2026-11-05）：PLAN-0651 D-174 / 51d3fa95 已经**从 create 体里删掉 `scope`**
        // （tier 移除；`AgentPrincipalCreateRequest` 是 additionalProperties:false，未知字段 400），
        // 旧的 `{"scope":"INSTANCE"}` 现在会被判 INVALID_REQUEST。契约里 scope 也不再是视图字段。
        ResponseEntity<Map> created = create(Map.of("name", "BareDefaultAgent"), workspaceId);
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        Map<String, Object> body = created.getBody();
        assertNotNull(body);
        assertNotNull(body.get("principalId"));
        assertEquals(null, body.get("templateId"));
        assertEquals(null, body.get("templateName"));
        assertFalse(body.containsKey("permissions"));
        assertFalse(body.containsKey("scope"),
                "D-174 removed the principal tier from the wire (no `scope` in AgentPrincipalView)");
        assertEquals(null, body.get("ownerUserId"));
        assertFalse(body.containsKey("systemPrompt"));
        assertFalse(body.containsKey("provider"));

        UUID principalId = UUID.fromString((String) body.get("principalId"));
        var principal = principalRepository.findById(principalId).orElseThrow();
        assertEquals("BareDefaultAgent", principal.getName());
        assertEquals(userId.toString(), principal.getCreatedByUserId());
        assertTrue(principal.getTemplateSnapshot().path("templateName").isNull());
        // 默认模板快照 = 调用者物化原子集（instance USER 默认集 ∪ workspace 环 ∪ 本次授予的管理原子），
        // 集合全部从角色目录派生，不写字面量。注意：夹具把被测用户绑成 MEMBER，而 PLAN-0559 起
        // MEMBER/ADMIN 规范化为 **EDITOR**，所以工作区环是 WS_EDITOR 的原子集。
        java.util.Set<String> expectedDefaultAtoms = new java.util.HashSet<>(
                com.cc01cc.p.xihe.cp.policy.RoleAtomExpectations.materializedAtoms(
                        SystemAccessRoleCatalog.USER));
        expectedDefaultAtoms.addAll(com.cc01cc.p.xihe.cp.policy.RoleAtomExpectations.materializedAtoms(
                SystemAccessRoleCatalog.WS_EDITOR));
        expectedDefaultAtoms.add(com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry.ACTION_MANAGE_WORKSPACE_AGENTS);
        assertEquals(expectedDefaultAtoms,
                new java.util.HashSet<>(actionClasses(principal.getTemplateSnapshot().path("permissions"))),
                "the default template snapshot is the caller's materialized atom set");
        assertTrue(bindingRepository.findByIdPrincipalId(principalId).isEmpty());
        // 2026-11-04 裁定（PLAN-0629「role 行是唯一权威源」）：creation 会物化默认实例角色，
        // 一原子一行（uq_grants_role_atom）。B 类（BL-326）：V127/D-174 之后 agent 的默认 instance
        // 角色是 **AGENT_USER**（不是 USER），期望从角色目录单一来源派生，不写字面量。
        java.util.Set<String> expectedAtoms =
                com.cc01cc.p.xihe.cp.policy.RoleAtomExpectations.declaredAtoms(SystemAccessRoleCatalog.AGENT_USER);
        java.util.Set<String> actualAtoms = new java.util.HashSet<>(jdbcTemplate.queryForList(
                "SELECT jsonb_array_elements(permissions)->>'actionClass' FROM grants"
                        + " WHERE subject_type = 'agent_principal' AND subject_id = ?::uuid",
                String.class, principalId));
        assertEquals(expectedAtoms, actualAtoms,
                "each bound-role atom is exactly one grant row: " + actualAtoms);
        assertEquals(1, auditCount());
        assertEquals(principalId.toString(), jdbcTemplate.queryForObject(
                "SELECT resource_id FROM audit_logs WHERE action = 'agent_principal_created' AND user_id = ?::uuid",
                String.class, userId));
    }

    @Test
    void createRejectsInjectedFieldsBeforeWriting() throws Exception {
        fixture();
        addGrant("MANAGE_WORKSPACE_AGENTS", "*");
        int principalCount = principalRepository.findAll().size();
        ResponseEntity<Map> response = create(Map.of(
                "name", "Injected", "templateId", UUID.randomUUID().toString(), "createdByUserId", UUID.randomUUID().toString()));
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        assertEquals(principalCount, principalRepository.findAll().size());
        assertEquals(0, auditCount());

        ResponseEntity<Map> blankTemplate = create(Map.of("name", "BlankTemplate", "templateId", ""));
        assertEquals(HttpStatus.BAD_REQUEST, blankTemplate.getStatusCode());
        assertEquals(principalCount, principalRepository.findAll().size());
        assertEquals(0, auditCount());
    }

    /**
     * BL-326 / D22 → <b>revised by D-196 / BL-336 (2026-11-06 Lead ruling)</b>: the context gate is
     * <b>scope-aware</b>, so the ratified order is now
     * <b>existence (404) → scope-aware context (409) → authority (403)</b> for a subject that turns out
     * to be workspace-scoped, and <b>existence → authority</b> for a personal (instance-scope) one.
     *
     * <p>Two consequences this test pins deliberately:</p>
     * <ol>
     *   <li>an <b>unknown</b> id without a context now answers <b>404</b> — the residual oracle Lead
     *       accepted and asked to be stated rather than denied (the id must be read to learn its scope;
     *       UUIDv4 is unguessable, and pre-D22 the same caller got 403-vs-404 anyway, which leaked more);</li>
     *   <li>a <b>workspace-scoped</b> row without a context answers <b>409</b>, which is the property that
     *       actually matters: a context-less caller never learns anything about a workspace row.</li>
     * </ol>
     */
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"disable", "update"})
    void mutationWithoutWorkspaceContextOnAnUnknownIdAnswersNotFound(String operation) {
        fixture();
        // 关键：这个调用者**没有任何 workspace membership**。否则 TenantContextInterceptor 会走
        // "first active membership" 兜底造出上下文，下面的 409 分支就测不到了。
        String contextlessToken = contextlessToken();
        UUID unknown = UUID.randomUUID();
        ResponseEntity<Map> response = operation.equals("disable")
                ? mutate(HttpMethod.POST, "/api/v1/agent-principals/" + unknown + "/disable", null, contextlessToken)
                : mutate(HttpMethod.PATCH, "/api/v1/agent-principals/" + unknown,
                        Map.of("contextPolicy", Map.of("memory", Map.of("enabled", true))), contextlessToken);

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode(),
                "D-196: existence is resolved first, so an unknown id is a 404 even without a context "
                        + "(the accepted residual oracle) (" + operation + "): " + response.getBody());
        assertEquals("AGENT_PRINCIPAL_NOT_FOUND", response.getBody().get("code"));
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"disable", "update"})
    void mutationWithoutWorkspaceContextOnAWorkspaceScopedRowAnswers409(String operation) {
        fixture();
        String contextlessToken = contextlessToken();
        // D-174 shape: no owning user ⇒ workspace-scoped ⇒ the 409 gate applies.
        com.cc01cc.p.xihe.cp.entity.AgentPrincipal principal =
                new com.cc01cc.p.xihe.cp.entity.AgentPrincipal();
        principal.setName("ws-scoped-" + UUID.randomUUID());
        principal.setCreatedByUserId(userId.toString());
        principal.setTemplateId("template-1");
        principal.setTemplateSnapshot(objectMapper.createObjectNode());
        UUID principalId = principalRepository.saveAndFlush(principal).getId();

        ResponseEntity<Map> response = operation.equals("disable")
                ? mutate(HttpMethod.POST, "/api/v1/agent-principals/" + principalId + "/disable",
                        null, contextlessToken)
                : mutate(HttpMethod.PATCH, "/api/v1/agent-principals/" + principalId,
                        Map.of("contextPolicy", Map.of("memory", Map.of("enabled", true))), contextlessToken);

        assertEquals(HttpStatus.CONFLICT, response.getStatusCode(),
                "D-196: a workspace-scoped subject without a context is a 409 (" + operation + "): "
                        + response.getBody());
        assertEquals("WORKSPACE_CONTEXT_REQUIRED", response.getBody().get("code"),
                "the body must not reveal any field of the row it only read to learn the scope");
    }

    /** A caller with no workspace membership at all — no interceptor fallback can invent a context. */
    private String contextlessToken() {
        User contextless = userRepository.saveAndFlush(new User(
                "principal-create-contextless-" + UUID.randomUUID() + "@test.com", "hash", "Contextless"));
        return TestDataFactory.createGlobalToken(
                contextless.getId().toString(), contextless.getEmail(), "USER", 0);
    }

    private ResponseEntity<Map> mutate(HttpMethod method, String path, Map<String, Object> body, String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        // PATCH 需要 JDK client（URLConnection 不支持 PATCH）；4xx 不抛异常，便于断言状态码。
        org.springframework.web.client.RestTemplate client = new org.springframework.web.client.RestTemplate(
                new org.springframework.http.client.JdkClientHttpRequestFactory());
        client.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.client.ClientHttpResponse response)
                    throws java.io.IOException {
                return response.getStatusCode().is5xxServerError();
            }
        });
        return client.exchange(url(path), method, new HttpEntity<>(body, headers), Map.class);
    }

    private void fixture() {
        User user = userRepository.saveAndFlush(new User("principal-create-" + UUID.randomUUID() + "@test.com", "hash", "Principal create test"));
        userId = user.getId();
        token = TestDataFactory.createGlobalToken(userId.toString(), user.getEmail(), "USER", 0);
        // B 类根因（BL-326）：create 会给新 agent 默认 AGENT_USER 原子，GrantabilityGuard 要求调用者
        // 自己持有 ⇒ 走生产注册路径申领 instance USER 默认集（与 AuthService 同一句），不手写原子名。
        grantDefaultService.ensureUserDefault(user);
        // BL-326（2026-11-05 Lead 裁定）：agent-principal 创建有两层门，两层都要能测到 ——
        // (1) 前置层：无 workspace 上下文 ⇒ 409 WORKSPACE_CONTEXT_REQUIRED；
        // (2) 原子层：有上下文但主体缺 MANAGE_WORKSPACE_AGENTS ⇒ 403。
        // 这个 Workspace 只为第 (2) 层提供合法上下文，且**不能由被测算用户自己拥有**：
        // WS_OWNER 会物化 MANAGE_WORKSPACE_AGENTS（workspace:admin），那样第 (2) 层就永远绿。
        // 所以让一个独立账号当 owner，被测用户只做 MEMBER。
        User workspaceOwner = userRepository.saveAndFlush(new User(
                "principal-create-wsowner-" + UUID.randomUUID() + "@test.com", "hash", "Workspace owner"));
        workspaceId = workspaceFixture.createOwnedWorkspace(
                "principal-create-ctx", workspaceOwner.getId().toString()).getId();
        workspaceFixture.bindWorkspaceRole(workspaceId, userId, WorkspaceRole.MEMBER);
    }

    /**
     * W1c: the caller ceiling is seeded the post-W1 way — a test-only role bound at instance scope
     * and materialized into {@code grants(source='role')}.
     *
     * <p>The previous helper wrote a {@code source='direct'} row, which the authorization gates no
     * longer read ({@code GrantSources.EVALUATION_SOURCES} excludes the retired sources). Keeping the
     * helper on {@code role} is also what the product does after V88: direct is not an authorization
     * input any more.</p>
     */
    private void addGrant(String actionClass, String resource) {
        UUID roleId = UUID.randomUUID();
        accessRoleRepository.save(new AccessRole(roleId, "TEST_GRANT_" + roleId.toString().replace("-", "").toUpperCase(), "Test grant role",
                "test-only role", false));
        permissionRepository.save(new AccessRolePermission(roleId, actionClass, resource));
        roleBindingRepository.save(new AccessRoleBinding(roleId, "user", userId,
                AccessScope.INSTANCE, null, userId));
        materializer.materializeSubject("user", userId, userId, null);
        testRoleIds.add(roleId);
    }

    private List<String> actionClasses(JsonNode permissions) {
        return java.util.stream.StreamSupport.stream(permissions.spliterator(), false)
                .map(atom -> atom.path("actionClass").asText()).toList();
    }

    private int auditCount() {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_created' AND user_id = ?::uuid",
                Integer.class, userId);
    }

    private ResponseEntity<Map> create(Map<String, Object> body) {
        return create(body, null);
    }

    private ResponseEntity<Map> create(Map<String, Object> body, UUID withWorkspace) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (withWorkspace != null) {
            headers.set("X-Workspace-Id", withWorkspace.toString());
        }
        return restTemplate.exchange(url("/api/v1/agent-principals"), HttpMethod.POST,
                new HttpEntity<>(body, headers), Map.class);
    }
}
