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

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-448 (D-1286 / ui-2 417 P1-6): the live-cap public read face
 * {@code GET /workspaces/{ws}/agents/{pid}/effective-cap}. Asserts the wire cap is byte-identical to
 * the internal {@code resolveCapFor} (single computation point C1), that it tracks the LIVE
 * evaluation rather than the stored snapshot, the hit source / grant provenance, and the
 * membership gate + disabled/unbound error semantics.
 */
class EffectiveCapReadTest extends AbstractReusableIntegrationTest {

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private WorkspaceAgentRepository bindingRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private UUID userId;
    private UUID workspaceId;
    private UUID principalId;
    private UUID workspaceRoleId;
    private UUID outsiderId;
    private String token;

    @AfterEach
    void cleanFixtures() {
        if (workspaceRoleId != null) {
            jdbcTemplate.update("DELETE FROM role_bindings WHERE role_id = ?", workspaceRoleId);
            jdbcTemplate.update("DELETE FROM roles WHERE id = ?", workspaceRoleId);
        }
        if (workspaceId != null && principalId != null) {
            bindingRepository.deleteById(new WorkspaceAgentId(principalId, workspaceId));
        }
        if (workspaceId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", userId));
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ?", workspaceId.toString());
            workspaceRepository.deleteById(workspaceId);
        }
        if (principalId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("agent_principal", principalId));
            principalRepository.deleteById(principalId);
        }
        if (userId != null) {
            userRepository.deleteById(userId);
        }
        if (outsiderId != null) {
            userRepository.deleteById(outsiderId);
        }
    }

    @Test
    void effectiveCap_matchesResolveCapFor_withBindingSnapshotSourceAndProvenance() throws Exception {
        fixture();
        bindSnapshot("[{\"actionClass\":\"read\"}]");

        ResponseEntity<Map> response = get();
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        Map<?, ?> body = response.getBody();
        assertNotNull(body);
        // C1: the wire cap is byte-identical to the internal evaluation.
        JsonNode internal = agentPrincipalService.resolveCapFor(principalId, workspaceId);
        assertEquals(objectMapper.valueToTree(internal), objectMapper.valueToTree(body.get("effectiveCap")),
                "effectiveCap must equal resolveCapFor atom-for-atom (single computation point)");
        assertEquals("binding-snapshot", ((Map<?, ?>) body.get("capSource")).get("binding"));
        assertEquals(Boolean.TRUE, body.get("bound"));
        Map<?, ?> provenance = (Map<?, ?>) body.get("provenance");
        assertFalse(((List<?>) provenance.get("principalGrantIds")).isEmpty(),
                "P1-1: the principal grant-row provenance must be non-empty");
        assertTrue(((List<?>) provenance.get("bindingGrantIds")).isEmpty(),
                "a binding-snapshot cap has no binding grant rows");
        assertNotNull(((Map<?, ?>) body.get("defaultGrants")).get("readFace"),
                "P1-2: the read-face default grant set must be present");
    }

    @Test
    void liveCapShrinksWhenPrincipalNarrowed_snapshotStaysStale() throws Exception {
        fixture();
        // Snapshot claims read+write, but the principal only holds read ⇒ live cap = read only.
        bindSnapshot("[{\"actionClass\":\"read\"},{\"actionClass\":\"write\"}]");

        ResponseEntity<Map> response = get();
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        JsonNode cap = objectMapper.valueToTree(response.getBody().get("effectiveCap"));
        assertEquals(1, cap.size(), "live cap must drop the uncovered write atom");
        assertEquals("read", cap.get(0).get("actionClass").asText());
        // The stored snapshot is untouched — this is exactly why the UI could only annotate it.
        JsonNode snapshot = bindingRepository.findById(new WorkspaceAgentId(principalId, workspaceId))
                .orElseThrow().getPermissionsSnapshot();
        assertEquals(2, snapshot.size(), "the stored snapshot still claims read+write (stale)");
    }

    @Test
    void roleBindingSource_whenNoBindingRow() throws Exception {
        fixture();
        bindWorkspaceScopedRoleToPrincipal();

        ResponseEntity<Map> response = get();
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        Map<?, ?> body = response.getBody();
        assertEquals("role-binding", ((Map<?, ?>) body.get("capSource")).get("binding"));
        assertEquals(Boolean.FALSE, body.get("bound"), "no cap binding row ⇒ bound=false");
        JsonNode internal = agentPrincipalService.resolveCapFor(principalId, workspaceId);
        assertEquals(objectMapper.valueToTree(internal), objectMapper.valueToTree(body.get("effectiveCap")));
    }

    @Test
    void unboundWorkspace_answers403() throws Exception {
        fixture();
        // No binding row and no role binding ⇒ resolveCapFor scoped refusal.
        ResponseEntity<Map> response = get();
        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), String.valueOf(response.getBody()));
    }

    @Test
    void disabledPrincipal_answers409() throws Exception {
        fixture();
        bindSnapshot("[{\"actionClass\":\"read\"}]");
        AgentPrincipal principal = principalRepository.findById(principalId).orElseThrow();
        principal.setDisabledAt(Instant.now());
        principalRepository.saveAndFlush(principal);

        ResponseEntity<Map> response = get();
        assertEquals(HttpStatus.CONFLICT, response.getStatusCode(), String.valueOf(response.getBody()));
    }

    @Test
    void nonMember_answers403() throws Exception {
        fixture();
        bindSnapshot("[{\"actionClass\":\"read\"}]");
        User outsider = userRepository.saveAndFlush(new User("outsider-" + UUID.randomUUID() + "@test.com",
                "hash", "Outsider"));
        outsiderId = outsider.getId();
        String outsiderToken = TestDataFactory.createWorkspaceToken(outsiderId.toString(), outsider.getEmail(),
                "USER", workspaceId.toString(), 0);

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(outsiderToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> response = restTemplate.exchange(url(capPath()), HttpMethod.GET,
                new HttpEntity<>(null, headers), Map.class);
        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(),
                "the read face gate is workspace membership, not a role special-case");
    }

    private void fixture() throws Exception {
        User user = userRepository.saveAndFlush(new User("effective-cap-" + UUID.randomUUID() + "@test.com",
                "hash", "Effective Cap Test"));
        userId = user.getId();
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Effective cap test", userId.toString());
        workspaceId = workspace.getId();
        workspaceFixture.bindWorkspaceRole(workspaceId.toString(), userId.toString(), WorkspaceRole.EDITOR);
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("CapAgent");
        principal.setCreatedByUserId(userId.toString());
        principal.setTemplateId("template-1");
        principal.setTemplateSnapshot(objectMapper.readTree(
                "{\"templateId\":\"template-1\",\"templateName\":\"Cap\"}"));
        principal = principalRepository.saveAndFlush(principal);
        principalId = principal.getId();
        addPrincipalGrant("read", "*");
        token = TestDataFactory.createWorkspaceToken(userId.toString(), user.getEmail(), "USER", workspaceId.toString(), 0);
    }

    private void bindSnapshot(String permissionsJson) throws Exception {
        bindingRepository.saveAndFlush(new WorkspaceAgent(principalId.toString(), workspaceId.toString(),
                objectMapper.readTree(permissionsJson)));
    }

    private void bindWorkspaceScopedRoleToPrincipal() {
        workspaceRoleId = UUID.randomUUID();
        jdbcTemplate.update("INSERT INTO roles (id, name, display_name, description, is_system)"
                        + " VALUES (?, ?, ?, ?, FALSE)",
                workspaceRoleId, "TEST_ECR_" + workspaceRoleId.toString().substring(0, 8).toUpperCase(),
                "Test workspace role", "test-only role for effective-cap role-binding source");
        jdbcTemplate.update("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                        + " scope_id, granted_at) VALUES (gen_random_uuid(), ?, 'agent_principal', ?,"
                        + " 'workspace', ?, NOW())",
                workspaceRoleId, principalId, workspaceId);
    }

    private void addPrincipalGrant(String actionClass, String resource) throws Exception {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setGranterType("user");
        grant.setGranterId(userId);
        grant.setSubjectType("agent_principal");
        grant.setSubjectId(principalId);
        grant.setSource(GrantSources.TEMPLATE);
        grant.setReadState("read");
        grant.setPermissions(objectMapper.readTree("[{\"actionClass\":\"" + actionClass
                + "\",\"resource\":\"" + resource + "\"}]"));
        grantRepository.saveAndFlush(grant);
    }

    private String capPath() {
        return "/api/v1/workspaces/" + workspaceId + "/agents/" + principalId + "/effective-cap";
    }

    private ResponseEntity<Map> get() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(url(capPath()), HttpMethod.GET, new HttpEntity<>(null, headers), Map.class);
    }
}