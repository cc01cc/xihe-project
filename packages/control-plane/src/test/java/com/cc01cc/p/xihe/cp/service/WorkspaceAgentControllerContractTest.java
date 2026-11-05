package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
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

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WorkspaceAgentControllerContractTest extends AbstractIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private WorkspaceAgentRepository bindingRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private UUID userId;
    private UUID workspaceId;
    private UUID otherWorkspaceId;
    private UUID principalId;
    private UUID workspaceRoleId;
    private String token;

    @AfterEach
    void cleanFixtures() {
        if (workspaceRoleId != null) {
            // BL-326: the fixture binds a workspace-scoped role to the principal for the roleIds
            // assertion; drop the binding/role or the principal delete hits the FK.
            jdbcTemplate.update("DELETE FROM role_bindings WHERE role_id = ?", workspaceRoleId);
            jdbcTemplate.update("DELETE FROM roles WHERE id = ?", workspaceRoleId);
        }
        if (workspaceId != null && principalId != null) {
            bindingRepository.deleteById(new WorkspaceAgentId(principalId, workspaceId));
        }
        if (otherWorkspaceId != null && principalId != null) {
            bindingRepository.deleteById(new WorkspaceAgentId(principalId, otherWorkspaceId));
        }
        if (workspaceId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", userId));
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ?", workspaceId.toString());
            workspaceRepository.deleteById(workspaceId);
        }
        if (otherWorkspaceId != null) {
            workspaceRepository.deleteById(otherWorkspaceId);
        }
        if (principalId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("agent_principal", principalId));
            principalRepository.deleteById(principalId);
        }
        if (userId != null) {
            userRepository.deleteById(userId);
        }
    }

    @Test
    void workspaceMemberCanReadButOnlyAuthorizedOperatorCanChangeBinding() throws Exception {
        fixture();

        // PLAN-0622 M1.2 froze the list envelope as `{agents:[…]}` (it used to be a bare array);
        // the test must assert the envelope, not just "something parsed".
        ResponseEntity<Map> empty = request(HttpMethod.GET, path(), null);
        assertEquals(HttpStatus.OK, empty.getStatusCode());
        assertEquals(java.util.Set.of("agents"), empty.getBody().keySet(),
                "the workspace agent list is an envelope, not a bare array");
        assertTrue(agents(empty.getBody()).isEmpty());

        Map<String, Object> request = Map.of("permissions", List.of(Map.of("actionClass", "read")));
        ResponseEntity<Map> denied = request(HttpMethod.PUT, path() + "/" + principalId, request);
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(), String.valueOf(denied.getBody()));
        assertFalse(bindingRepository.existsById(new WorkspaceAgentId(principalId, workspaceId)));

        addGrant("MANAGE_WORKSPACE_AGENTS", workspaceId.toString());
        ResponseEntity<Map> bound = request(HttpMethod.PUT, path() + "/" + principalId, request);
        assertEquals(HttpStatus.OK, bound.getStatusCode());
        assertEquals(workspaceId.toString(), bound.getBody().get("workspaceId"));
        assertTrue(bindingRepository.existsById(new WorkspaceAgentId(principalId, workspaceId)));
        // BL-326（Lead 裁定 ①）：在列表面值之前显式绑一个 workspace 作用域角色，让 roleIds 断言是
        // "非空且等于真实绑定"，而不是 present-but-empty 假绿。位置必须在"列表为空"断言之后 ——
        // 这条绑定本身就会让该 principal 在 workspace 列表里可见（产品既定行为）。
        bindWorkspaceScopedRoleToPrincipal();

        ResponseEntity<Map> listed = request(HttpMethod.GET, path(), null);
        assertEquals(HttpStatus.OK, listed.getStatusCode());
        List<?> listedAgents = agents(listed.getBody());
        assertEquals(1, listedAgents.size(), String.valueOf(listed.getBody()));
        Map<?, ?> view = (Map<?, ?>) listedAgents.getFirst();
        assertEquals(principalId.toString(), view.get("principalId"));
        assertEquals("ResearchAgent", view.get("name"));
        assertEquals("template-1", view.get("templateId"));
        assertEquals("Research", view.get("templateName"));
        // PLAN-0622 M1.2 renamed `permissions` -> `permissionsSnapshot` and made `source` mandatory;
        // D26/D27 added the `bound` / `disabled` projection the UI gates its buttons on.
        assertNotNull(view.get("permissionsSnapshot"),
                "M1.2: the cap is projected as permissionsSnapshot");
        assertFalse(view.containsKey("permissions"),
                "M1.2 removed the bare `permissions` key (a silent rename must fail here)");
        // B 类（BL-326，2026-11-05）：`source` 已随 PLAN-0651 D-174 从投影中移除
        // （51d3fa95 删掉 `result.put("source", view.source())`），而 openapi.yaml 的
        // WorkspaceAgentView 从来就只声明 permissionsSnapshot/bound/disabled/hooks/contextPolicy/
        // roleIds —— 旧断言测的是实现细节而非契约。改为"契约没有的字段不许复活"+ roleIds 存在。
        assertFalse(view.containsKey("source"),
                "the WorkspaceAgentView contract carries no `source` field (roles are expressed via "
                        + "roleIds since D-174); the projection must not resurrect it");
        // BL-326（Lead 2026-11-05 裁定 ①）：`roleIds` 是契约必填，而序列化层长期漏发。断言不能只查
        // key 存在——present-but-always-empty 是另一种假绿，所以这里比对"该行真正的 workspace 作用域
        // 角色绑定"（fixture 显式绑了一个），并同时钉非空。
        assertTrue(view.containsKey("roleIds"),
                "PLAN-0629: roleIds is part of the workspace-agent row contract (BL-326: it was required "
                        + "by openapi.yaml but never serialized)");
        Object wireRoleIds = view.get("roleIds");
        assertNotNull(wireRoleIds, "roleIds must be present as a list, not null");
        java.util.Set<String> expectedRoleIds = new java.util.HashSet<>(jdbcTemplate.queryForList(
                "SELECT role_id::text FROM role_bindings WHERE subject_type = 'agent_principal'"
                        + " AND subject_id = ?::uuid AND scope_type = 'workspace' AND scope_id = ?::uuid",
                String.class, principalId, workspaceId));
        assertEquals(expectedRoleIds,
                new java.util.HashSet<>((java.util.List<String>) wireRoleIds),
                "roleIds must equal the workspace-scoped role bindings that authorize this row");
        assertTrue(expectedRoleIds.contains(workspaceRoleId.toString()),
                "fixture sanity: the bound workspace role must be one of them (non-empty by construction)");
        assertEquals(Boolean.TRUE, view.get("bound"), "D26: a bound row projects bound=true");
        assertEquals(Boolean.FALSE, view.get("disabled"),
                "D27: a principal without disabledAt projects disabled=false");
        assertFalse(view.containsKey("systemPrompt"));
        assertFalse(view.containsKey("provider"));
        assertFalse(view.containsKey("secret"));

        ResponseEntity<Map> injected = request(HttpMethod.PUT, path() + "/" + principalId,
                Map.of("permissions", List.of(), "principalId", UUID.randomUUID().toString()));
        assertEquals(HttpStatus.BAD_REQUEST, injected.getStatusCode());

        bindingRepository.saveAndFlush(new WorkspaceAgent(principalId.toString(), otherWorkspaceId.toString(),
                objectMapper.readTree("[{\"actionClass\":\"read\"}]")));
        ResponseEntity<Void> removed = request(HttpMethod.DELETE, path() + "/" + principalId, null);
        assertEquals(HttpStatus.NO_CONTENT, removed.getStatusCode());
        assertFalse(bindingRepository.existsById(new WorkspaceAgentId(principalId, workspaceId)));
        assertTrue(bindingRepository.existsById(new WorkspaceAgentId(principalId, otherWorkspaceId)));
        assertEquals(2, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ? "
                        + "AND action IN ('workspace_agent_bound','workspace_agent_unbound')",
                Integer.class, workspaceId.toString()));
    }

    @Test
    void permissionCapCannotExceedEitherPrincipalOrOperatorGrants() throws Exception {
        fixture();
        addGrant("MANAGE_WORKSPACE_AGENTS", "*");
        Map<String, Object> tooBroad = Map.of("permissions", List.of(Map.of("actionClass", "write")));
        ResponseEntity<Map> response = request(HttpMethod.PUT, path() + "/" + principalId, tooBroad);
        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), String.valueOf(response.getBody()));
        assertFalse(bindingRepository.existsById(new WorkspaceAgentId(principalId, workspaceId)));
        assertEquals(0, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ? "
                        + "AND action IN ('workspace_agent_bound','workspace_agent_cap_updated')",
                Integer.class, workspaceId.toString()));
    }

    private void bindWorkspaceScopedRoleToPrincipal() {
        workspaceRoleId = UUID.randomUUID();
        jdbcTemplate.update("INSERT INTO roles (id, name, display_name, description, is_system)"
                        + " VALUES (?, ?, ?, ?, FALSE)",
                workspaceRoleId, "TEST_WSA_" + workspaceRoleId.toString().substring(0, 8).toUpperCase(),
                "Test workspace role", "test-only role for roleIds projection");
        jdbcTemplate.update("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                        + " scope_id, granted_at) VALUES (gen_random_uuid(), ?, 'agent_principal', ?,"
                        + " 'workspace', ?, NOW())",
                workspaceRoleId, principalId, workspaceId);
    }

    private void fixture() throws Exception {
        User user = userRepository.saveAndFlush(new User("workspace-agents-" + UUID.randomUUID() + "@test.com",
                "hash", "Workspace Agents Test"));
        userId = user.getId();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Agent binding test", userId.toString());
        workspaceId = workspace.getId();
        Workspace other = workspaceFixture.createOwnedWorkspace("Other Agent binding test", userId.toString());
        otherWorkspaceId = other.getId();
        // PLAN-0610 W4b: the operator under test is a plain workspace member (EDITOR). WS_OWNER
        // materializes MANAGE_WORKSPACE_AGENTS/workspace:admin by design, which would bypass the gate.
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId.toString(), WorkspaceRole.EDITOR);
        workspaceFixture.bindWorkspaceRole(otherWorkspaceId.toString(), userId.toString(), WorkspaceRole.EDITOR);

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("ResearchAgent");
        principal.setCreatedByUserId(userId.toString());
        principal.setTemplateId("template-1");
        principal.setTemplateSnapshot(objectMapper.readTree(
                "{\"templateId\":\"template-1\",\"templateName\":\"Research\","
                        + "\"systemPrompt\":\"secret prompt\",\"provider\":\"private-provider\"}"));
        principal = principalRepository.saveAndFlush(principal);
        principalId = principal.getId();
        addGrant("read", "*");
        addPrincipalGrant("read", "*");
        token = TestDataFactory.createWorkspaceToken(userId.toString(), user.getEmail(), "USER", workspaceId.toString(), 0);
    }

    private void addGrant(String actionClass, String resource) throws Exception {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setGranterType("user");
        grant.setGranterId(userId);
        grant.setSubjectType("user");
        grant.setSubjectId(userId);
        grant.setSource(GrantSources.ROLE);
        grant.setReadState("read");
        grant.setPermissions(objectMapper.readTree("[{\"actionClass\":\"" + actionClass
                + "\",\"resource\":\"" + resource + "\"}]"));
        grantRepository.saveAndFlush(grant);
    }

    private void addPrincipalGrant(String actionClass, String resource) throws Exception {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setGranterType("user");
        grant.setGranterId(userId);
        grant.setSubjectType("agent_principal");
        grant.setSubjectId(principalId);
        grant.setSource("template");
        grant.setReadState("read");
        grant.setPermissions(objectMapper.readTree("[{\"actionClass\":\"" + actionClass
                + "\",\"resource\":\"" + resource + "\"}]"));
        grantRepository.saveAndFlush(grant);
    }

    private String path() {
        return "/api/v1/workspaces/" + workspaceId + "/agents";
    }

    private <T> ResponseEntity<T> request(HttpMethod method, String path, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        // PLAN-0622 M1.2: the list is an envelope object too, so only DELETE has no JSON body type.
        return restTemplate.exchange(url(path), method, new HttpEntity<>(body, headers), (Class<T>)
                (method == HttpMethod.DELETE ? Void.class : Map.class));
    }

    /** The envelope payload of `GET /workspaces/{id}/agents` (M1.2 froze it as `{agents:[…]}`). */
    private static List<?> agents(Map<?, ?> body) {
        Object value = body == null ? null : body.get("agents");
        assertNotNull(value, "the list envelope must carry an `agents` array");
        return (List<?>) value;
    }
}
