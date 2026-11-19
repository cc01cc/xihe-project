package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.GrantSources;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.support.TestAgentPrincipals;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-106（用户裁定 2026-11-20 00:28，方案 A）：工作区级默认智能体的真实 HTTP 行为。
 *
 * <p>覆盖：PUT/DELETE {@code /api/v1/workspaces/{wsId}/agents/{principalId}/default} 的 200/204、
 * {@code previousPrincipalId} 投影、重复调用的幂等（不重复写审计）、未绑定 principal 的
 * 409 {@code AGENT_PRINCIPAL_NOT_BOUND}、解绑默认主体时自动补
 * {@code workspace_agent_default_cleared}，以及 V177 的 partial unique index 在库层真的挡住
 * 「一个工作区两行 is_default」（服务层 clear→mark 两步法只靠索引兜底时才安全）。</p>
 */
class WorkspaceAgentDefaultIntegrationTest extends AbstractReusableIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private WorkspaceAgentRepository bindingRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private AgentPrincipalService agentPrincipalService;

    private UUID userId;
    private UUID workspaceId;
    private UUID principalId;
    private UUID secondPrincipalId;
    private String token;

    @AfterEach
    void cleanFixtures() {
        if (workspaceId != null && principalId != null) {
            bindingRepository.deleteById(new WorkspaceAgentId(principalId, workspaceId));
        }
        if (workspaceId != null && secondPrincipalId != null) {
            bindingRepository.deleteById(new WorkspaceAgentId(secondPrincipalId, workspaceId));
        }
        if (workspaceId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", userId));
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ?",
                    workspaceId.toString());
            workspaceRepository.deleteById(workspaceId);
        }
        if (principalId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("agent_principal", principalId));
            principalRepository.deleteById(principalId);
        }
        if (secondPrincipalId != null) {
            grantRepository.deleteAll(
                    grantRepository.findBySubjectTypeAndSubjectId("agent_principal", secondPrincipalId));
            principalRepository.deleteById(secondPrincipalId);
        }
        if (userId != null) {
            userRepository.deleteById(userId);
        }
    }

    @Test
    void promotingBoundPrincipalWritesOneAuditWithoutDisplayName() throws Exception {
        fixture();
        bind(principalId);

        ResponseEntity<Map> promoted = defaultRequest(HttpMethod.PUT, principalId);
        assertEquals(HttpStatus.OK, promoted.getStatusCode(), String.valueOf(promoted.getBody()));
        assertEquals(workspaceId.toString(), promoted.getBody().get("workspaceId"));
        assertEquals(principalId.toString(), promoted.getBody().get("principalId"));
        assertEquals(Boolean.TRUE, promoted.getBody().get("isDefault"));
        assertNull(promoted.getBody().get("previousPrincipalId"),
                "第一个默认没有前任");

        assertEquals(Boolean.TRUE, viewOf(principalId).get("isDefault"),
                "GET 列表必须把 isDefault 投影出来，否则 UI 无法画选中态");
        assertEquals(1, countAudit("workspace_agent_default_changed"));
        String detail = onlyAuditDetail("workspace_agent_default_changed");
        assertTrue(detail.contains("principalId=" + principalId), () -> "detail 只写 id：" + detail);
        assertTrue(detail.contains(";from=none;"), () -> "detail 记 from/to：" + detail);
        assertFalse(detail.contains("ResearchAgent"),
                () -> "审计不得写显示名（裁定 ② 只写 principalId）：" + detail);
        assertEquals(principalId, agentPrincipalService.workspaceDefaultAgentPrincipalId(workspaceId));
    }

    @Test
    void switchingDefaultReportsPreviousAndLeavesExactlyOneDefault() throws Exception {
        fixture();
        bind(principalId);
        secondPrincipalId = newPrincipal("SecondAgent");
        bind(secondPrincipalId);

        assertEquals(HttpStatus.OK, defaultRequest(HttpMethod.PUT, principalId).getStatusCode());
        ResponseEntity<Map> switched = defaultRequest(HttpMethod.PUT, secondPrincipalId);
        assertEquals(HttpStatus.OK, switched.getStatusCode(), String.valueOf(switched.getBody()));
        assertEquals(principalId.toString(), switched.getBody().get("previousPrincipalId"),
                "换默认要把前任报出来，调用方才能显式处理旧主体的 UI 状态");

        assertEquals(Boolean.FALSE, viewOf(principalId).get("isDefault"));
        assertEquals(Boolean.TRUE, viewOf(secondPrincipalId).get("isDefault"));
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM workspace_agents WHERE CAST(workspace_id AS VARCHAR) = ? AND is_default",
                Integer.class, workspaceId.toString()), "一个工作区只能有一个默认");
        assertEquals(2, countAudit("workspace_agent_default_changed"));
    }

    @Test
    void promotingCurrentDefaultIsIdempotent() throws Exception {
        fixture();
        bind(principalId);
        assertEquals(HttpStatus.OK, defaultRequest(HttpMethod.PUT, principalId).getStatusCode());

        ResponseEntity<Map> repeated = defaultRequest(HttpMethod.PUT, principalId);
        assertEquals(HttpStatus.OK, repeated.getStatusCode(), String.valueOf(repeated.getBody()));
        assertEquals(principalId.toString(), repeated.getBody().get("previousPrincipalId"),
                "重复提升返回当前默认（就是它自己），但不再落第二条审计");
        assertEquals(1, countAudit("workspace_agent_default_changed"),
                "幂等重复不得重复写审计");
    }

    @Test
    void unboundPrincipalIsConflictOnBothVerbs() throws Exception {
        fixture();
        secondPrincipalId = newPrincipal("UnboundAgent");

        ResponseEntity<Map> promote = defaultRequest(HttpMethod.PUT, secondPrincipalId);
        assertEquals(HttpStatus.CONFLICT, promote.getStatusCode(), String.valueOf(promote.getBody()));
        assertEquals("AGENT_PRINCIPAL_NOT_BOUND", promote.getBody().get("code"));

        ResponseEntity<?> clear = defaultRequest(HttpMethod.DELETE, secondPrincipalId);
        assertEquals(HttpStatus.CONFLICT, clear.getStatusCode(),
                "未绑定时「清一个不可能存在的标记」也是 409，不是静默 204");
        assertEquals(0, countAudit("workspace_agent_default_changed") + countAudit("workspace_agent_default_cleared"));
    }

    @Test
    void deleteClearsDefaultAndRepeatsIdempotently() throws Exception {
        fixture();
        bind(principalId);
        assertEquals(HttpStatus.OK, defaultRequest(HttpMethod.PUT, principalId).getStatusCode());

        ResponseEntity<?> cleared = defaultRequest(HttpMethod.DELETE, principalId);
        assertEquals(HttpStatus.NO_CONTENT, cleared.getStatusCode());
        assertEquals(Boolean.FALSE, viewOf(principalId).get("isDefault"));
        assertNull(agentPrincipalService.workspaceDefaultAgentPrincipalId(workspaceId));
        assertEquals(1, countAudit("workspace_agent_default_cleared"));

        ResponseEntity<?> repeated = defaultRequest(HttpMethod.DELETE, principalId);
        assertEquals(HttpStatus.NO_CONTENT, repeated.getStatusCode(),
                "非默认再删一次仍是 204（UI 重试不该变成错误）");
        assertEquals(1, countAudit("workspace_agent_default_cleared"),
                "没有真的清掉东西就不写第二条审计");
    }

    @Test
    void unbindingTheDefaultPrincipalClearsTheFlagAndAuditsIt() throws Exception {
        fixture();
        bind(principalId);
        assertEquals(HttpStatus.OK, defaultRequest(HttpMethod.PUT, principalId).getStatusCode());

        ResponseEntity<Void> unbound = request(HttpMethod.DELETE, path() + "/" + principalId, null);
        assertEquals(HttpStatus.NO_CONTENT, unbound.getStatusCode());
        assertFalse(bindingRepository.existsById(new WorkspaceAgentId(principalId, workspaceId)));
        assertEquals(0, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM workspace_agents WHERE CAST(workspace_id AS VARCHAR) = ? AND is_default",
                Integer.class, workspaceId.toString()), "绑带被删了，默认标记不能留在别处");
        assertEquals(1, countAudit("workspace_agent_default_cleared"),
                "裁定 ⑤：解绑当前默认要补一条 cleared 审计");
        assertEquals(1, countAudit("workspace_agent_default_changed"),
                "解绑前的提升留一条 changed 审计，解绑只补 cleared 一条");
    }

    @Test
    void partialUniqueIndexRejectsTwoDefaultsInOneWorkspace() throws Exception {
        fixture();
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM pg_indexes WHERE indexname = 'ux_workspace_agents_default'",
                Integer.class), "V177 的 partial unique index 必须真的建在库里");
        bind(principalId);
        secondPrincipalId = newPrincipal("SecondAgent");
        bind(secondPrincipalId);

        assertThrows(DataIntegrityViolationException.class,
                () -> jdbcTemplate.update(
                        "UPDATE workspace_agents SET is_default = true WHERE CAST(workspace_id AS VARCHAR) = ?",
                        workspaceId.toString()),
                "一条无 WHERE is_default 的批量置真必须被索引挡住（服务层 clear→mark 两步法的兜底）");
        assertEquals(0, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM workspace_agents WHERE CAST(workspace_id AS VARCHAR) = ? AND is_default",
                Integer.class, workspaceId.toString()));
    }

    private void fixture() throws Exception {
        User user = userRepository.saveAndFlush(new User("workspace-agent-default-" + UUID.randomUUID() + "@test.com",
                "hash", "Workspace Default Agent Test"));
        userId = user.getId();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Agent default test", userId.toString());
        workspaceId = workspace.getId();
        // PLAN-0610 W4b: the operator is a plain member (EDITOR); WS_OWNER would materialize
        // MANAGE_WORKSPACE_AGENTS by design and bypass the gate under test.
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId.toString(), WorkspaceRole.EDITOR);
        addGrant("MANAGE_WORKSPACE_AGENTS", workspaceId.toString());
        addGrant("read", "*");
        principalId = newPrincipal("ResearchAgent");
        token = TestDataFactory.createWorkspaceToken(userId.toString(), user.getEmail(), "USER",
                workspaceId.toString(), 0);
    }

    private UUID newPrincipal(String name) throws Exception {
        AgentPrincipal principal = TestAgentPrincipals.newUserAgentPrincipal();
        principal.setName(name);
        principal.setCreatedByUserId(userId.toString());
        principal.setTemplateId("template-1");
        principal.setTemplateSnapshot(objectMapper.readTree(
                "{\"templateId\":\"template-1\",\"templateName\":\"Research\","
                        + "\"systemPrompt\":\"secret prompt\",\"provider\":\"private-provider\"}"));
        principal = principalRepository.saveAndFlush(principal);
        UUID id = principal.getId();
        addPrincipalGrant(id, "read", "*");
        return id;
    }

    private void bind(UUID principal) throws Exception {
        bindingRepository.saveAndFlush(new WorkspaceAgent(principal.toString(), workspaceId.toString(),
                objectMapper.readTree("[{\"actionClass\":\"read\"}]")));
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

    private void addPrincipalGrant(UUID principal, String actionClass, String resource) throws Exception {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setGranterType("user");
        grant.setGranterId(userId);
        grant.setSubjectType("agent_principal");
        grant.setSubjectId(principal);
        grant.setSource("template");
        grant.setReadState("read");
        grant.setPermissions(objectMapper.readTree("[{\"actionClass\":\"" + actionClass
                + "\",\"resource\":\"" + resource + "\"}]"));
        grantRepository.saveAndFlush(grant);
    }

    private String path() {
        return "/api/v1/workspaces/" + workspaceId + "/agents";
    }

    private ResponseEntity<Map> defaultRequest(HttpMethod method, UUID principal) {
        return request(method, path() + "/" + principal + "/default", null);
    }

    private <T> ResponseEntity<T> request(HttpMethod method, String path, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(url(path), method, new HttpEntity<>(body, headers), (Class<T>)
                (method == HttpMethod.DELETE ? Void.class : Map.class));
    }

    /** The projected row of {@code principalId} from the live list read face. */
    private Map<?, ?> viewOf(UUID principal) {
        ResponseEntity<Map> listed = request(HttpMethod.GET, path(), null);
        assertEquals(HttpStatus.OK, listed.getStatusCode(), String.valueOf(listed.getBody()));
        Object agents = listed.getBody() == null ? null : listed.getBody().get("agents");
        assertNotNull(agents, "the list envelope must carry an `agents` array");
        for (Object agent : (List<?>) agents) {
            Map<?, ?> view = (Map<?, ?>) agent;
            if (principal.toString().equals(String.valueOf(view.get("principalId")))) {
                return view;
            }
        }
        throw new AssertionError("principal " + principal + " is not in the workspace agent list");
    }

    private int countAudit(String action) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ? AND action = ?",
                Integer.class, workspaceId.toString(), action);
    }

    private String onlyAuditDetail(String action) {
        return jdbcTemplate.queryForObject(
                "SELECT details FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ? AND action = ?",
                String.class, workspaceId.toString(), action);
    }
}
