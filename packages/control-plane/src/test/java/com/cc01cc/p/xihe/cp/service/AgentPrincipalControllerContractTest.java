package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
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

class AgentPrincipalControllerContractTest extends AbstractIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private WorkspaceAgentRepository bindingRepository;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private UUID userId;
    private String token;

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
            userRepository.deleteById(userId);
        }
    }

    @Test
    void createAccountRequiresIndependentGrantAndCreatesSnapshotWithoutWorkspaceBinding() throws Exception {
        fixture();
        int principalCount = principalRepository.findAll().size();

        ResponseEntity<Map> denied = create(Map.of("name", "No Grant"));
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode());
        assertEquals(principalCount, principalRepository.findAll().size());
        assertEquals(0, auditCount());

        addGrant("CREATE_ACCOUNT", "*");
        ResponseEntity<Map> created = create(Map.of("name", "Bare Default Agent"));
        assertEquals(HttpStatus.CREATED, created.getStatusCode());
        Map<String, Object> body = created.getBody();
        assertNotNull(body);
        assertNotNull(body.get("principalId"));
        assertEquals(null, body.get("templateId"));
        assertEquals(null, body.get("templateName"));
        assertFalse(body.containsKey("permissions"));
        assertFalse(body.containsKey("systemPrompt"));
        assertFalse(body.containsKey("provider"));

        UUID principalId = UUID.fromString((String) body.get("principalId"));
        var principal = principalRepository.findById(principalId).orElseThrow();
        assertEquals("Bare Default Agent", principal.getName());
        assertEquals(userId.toString(), principal.getCreatedByUserId());
        assertTrue(principal.getTemplateSnapshot().path("templateName").isNull());
        assertEquals(List.of("CREATE_ACCOUNT"), actionClasses(principal.getTemplateSnapshot().path("permissions")));
        assertTrue(bindingRepository.findByIdPrincipalId(principalId).isEmpty());
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM grants WHERE subject_type = 'agent_principal' AND subject_id = ?",
                Integer.class, principalId));
        assertEquals(1, auditCount());
        assertEquals(principalId.toString(), jdbcTemplate.queryForObject(
                "SELECT resource_id FROM audit_logs WHERE action = 'agent_principal_created' AND user_id = ?::uuid",
                String.class, userId));
    }

    @Test
    void createRejectsInjectedFieldsBeforeWriting() throws Exception {
        fixture();
        addGrant("CREATE_ACCOUNT", "*");
        int principalCount = principalRepository.findAll().size();
        ResponseEntity<Map> response = create(Map.of(
                "name", "Injected", "templateId", UUID.randomUUID().toString(), "createdByUserId", UUID.randomUUID().toString()));
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        assertEquals(principalCount, principalRepository.findAll().size());
        assertEquals(0, auditCount());

        ResponseEntity<Map> blankTemplate = create(Map.of("name", "Blank Template", "templateId", ""));
        assertEquals(HttpStatus.BAD_REQUEST, blankTemplate.getStatusCode());
        assertEquals(principalCount, principalRepository.findAll().size());
        assertEquals(0, auditCount());
    }

    private void fixture() {
        User user = userRepository.saveAndFlush(new User(
                "principal-create-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "Principal create test"));
        userId = user.getId();
        token = TestDataFactory.createGlobalToken(userId.toString(), user.getEmail(), "USER");
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
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(url("/api/v1/agent-principals"), HttpMethod.POST,
                new HttpEntity<>(body, headers), Map.class);
    }
}
