package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgentId;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
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

class WorkspaceAgentControllerContractTest extends AbstractIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private WorkspaceAgentRepository bindingRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private UUID userId;
    private UUID workspaceId;
    private UUID otherWorkspaceId;
    private UUID principalId;
    private String token;

    @AfterEach
    void cleanFixtures() {
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

        ResponseEntity<List> empty = request(HttpMethod.GET, path(), null);
        assertEquals(HttpStatus.OK, empty.getStatusCode());
        assertTrue(empty.getBody().isEmpty());

        Map<String, Object> request = Map.of("permissions", List.of(Map.of("actionClass", "read")));
        ResponseEntity<Map> denied = request(HttpMethod.PUT, path() + "/" + principalId, request);
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(), String.valueOf(denied.getBody()));
        assertFalse(bindingRepository.existsById(new WorkspaceAgentId(principalId, workspaceId)));

        addGrant("MANAGE_WORKSPACE_AGENTS", workspaceId.toString());
        ResponseEntity<Map> bound = request(HttpMethod.PUT, path() + "/" + principalId, request);
        assertEquals(HttpStatus.OK, bound.getStatusCode());
        assertEquals(workspaceId.toString(), bound.getBody().get("workspaceId"));
        assertTrue(bindingRepository.existsById(new WorkspaceAgentId(principalId, workspaceId)));

        ResponseEntity<List> listed = request(HttpMethod.GET, path(), null);
        assertEquals(HttpStatus.OK, listed.getStatusCode());
        Map<?, ?> view = (Map<?, ?>) listed.getBody().getFirst();
        assertEquals(principalId.toString(), view.get("principalId"));
        assertEquals("Research Agent", view.get("name"));
        assertEquals("template-1", view.get("templateId"));
        assertEquals("Research", view.get("templateName"));
        assertNotNull(view.get("permissions"));
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

    private void fixture() throws Exception {
        User user = userRepository.saveAndFlush(new User("workspace-agents-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Workspace Agents Test"));
        userId = user.getId();
        Workspace workspace = workspaceRepository.saveAndFlush(new Workspace("Agent binding test", userId.toString()));
        workspaceId = workspace.getId();
        Workspace other = workspaceRepository.saveAndFlush(new Workspace("Other Agent binding test", userId.toString()));
        otherWorkspaceId = other.getId();
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(workspaceId.toString(), userId.toString(), WorkspaceRole.OWNER));
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(otherWorkspaceId.toString(), userId.toString(), WorkspaceRole.OWNER));

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Research Agent");
        principal.setCreatedByUserId(userId.toString());
        principal.setTemplateId("template-1");
        principal.setTemplateSnapshot(objectMapper.readTree(
                "{\"templateId\":\"template-1\",\"templateName\":\"Research\","
                        + "\"systemPrompt\":\"secret prompt\",\"provider\":\"private-provider\"}"));
        principal = principalRepository.saveAndFlush(principal);
        principalId = principal.getId();
        addGrant("read", "*");
        addPrincipalGrant("read", "*");
        token = TestDataFactory.createWorkspaceToken(userId.toString(), user.getEmail(), "USER", workspaceId.toString());
    }

    private void addGrant(String actionClass, String resource) throws Exception {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setGranterType("user");
        grant.setGranterId(userId);
        grant.setSubjectType("user");
        grant.setSubjectId(userId);
        grant.setSource("direct");
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
        return restTemplate.exchange(url(path), method, new HttpEntity<>(body, headers), (Class<T>)
                (method == HttpMethod.GET ? List.class : method == HttpMethod.DELETE ? Void.class : Map.class));
    }
}
