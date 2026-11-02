package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.AccessScope;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.policy.RoleGrantMaterializer;
import com.cc01cc.p.xihe.cp.repository.AccessRoleBindingRepository;
import com.cc01cc.p.xihe.cp.repository.AccessRoleRepository;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0629 M1 (D29-21): wiring of {@code agent_principals.context_policy} — the memory policy
 * document of V92's column, which had no entity field, no writer and no reader before this batch.
 *
 * <p>Everything is asserted at the HTTP boundary against a real PostgreSQL (Testcontainers), because
 * the previous batches taught the lesson twice: a mock can hold a document that the JPA mapping or the
 * Jackson-3 wire cannot. The shape being pinned is the frozen v1 ruling (D29-25):</p>
 * <pre>{@code
 * { "memory": { "enabled": false, "writeMode": "off", "types": ["profile", "fact"] } }
 * }</pre>
 *
 * <p>Deliberately not asserted here: any "automatically summarise and write memory" behaviour — D29-24
 * rejected it, and there is no {@code auto} value in the durable {@code origin} enum it belongs to.
 * The hooks document has its own class ({@link AgentPrincipalHooksHttpTest}); this one owns the
 * context-policy document and the interplay of the two on the shared PATCH.</p>
 */
class AgentPrincipalContextPolicyHttpTest extends AbstractIntegrationTest {

    private static final String HOOKS_JSON =
            "{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}";
    private static final String POLICY_JSON =
            "{\"memory\":{\"enabled\":true,\"writeMode\":\"tool\",\"types\":[\"profile\",\"fact\"]}}";

    @Autowired private UserRepository userRepository;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private WorkspaceAgentRepository bindingRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private AccessRoleRepository accessRoleRepository;
    @Autowired private AccessRoleBindingRepository roleBindingRepository;
    @Autowired private RoleGrantMaterializer materializer;
    @Autowired private GrantDefaultService grantDefaultService;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private RestTemplate patchClient;
    private UUID adminUserId;
    private UUID strangerUserId;
    private UUID workspaceId;
    private final List<UUID> seededRoleBindingIds = new ArrayList<>();
    private final List<UUID> principalIds = new ArrayList<>();

    @BeforeEach
    void initPatchClient() {
        // PATCH is not supported by HttpURLConnection (the shared RestTemplate's default factory).
        patchClient = new RestTemplate(new JdkClientHttpRequestFactory());
        patchClient.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(ClientHttpResponse response) {
                return false;
            }
        });
    }

    @AfterEach
    void cleanFixtures() {
        for (UUID principalId : principalIds) {
            bindingRepository.deleteAll(bindingRepository.findByIdPrincipalId(principalId));
            grantRepository.deleteAll(
                    grantRepository.findBySubjectTypeAndSubjectId("agent_principal", principalId));
            jdbcTemplate.update("DELETE FROM audit_logs WHERE resource_type = 'agent_principal' "
                    + "AND CAST(resource_id AS VARCHAR) = ?", principalId.toString());
            principalRepository.deleteById(principalId);
        }
        principalIds.clear();
        if (workspaceId != null) {
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ?",
                    workspaceId.toString());
            workspaceFixture.unbindWorkspace(workspaceId);
            workspaceRepository.deleteById(workspaceId);
            workspaceId = null;
        }
        for (UUID roleBindingId : seededRoleBindingIds) {
            roleBindingRepository.deleteById(roleBindingId);
        }
        seededRoleBindingIds.clear();
        deleteUser(adminUserId);
        adminUserId = null;
        deleteUser(strangerUserId);
        strangerUserId = null;
    }

    // ---------------------------------------------------------------------------------------
    // Mapping round trip: PATCH -> DB column -> view
    // ---------------------------------------------------------------------------------------

    @Test
    void patchStoresTheContextPolicyAndBothReadSurfacesProjectIt() {
        fixture();
        UUID principalId = createPrincipal("Memory agent");

        ResponseEntity<Map> response = patch(principalId, body("contextPolicy", plainJson(POLICY_JSON)),
                globalToken());

        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals(principalId.toString(), response.getBody().get("principalId"));
        assertNull(response.getBody().get("hooks"), "an untouched hooks document stays null here");
        assertEquals(plainJson(POLICY_JSON), response.getBody().get("contextPolicy"),
                "the response echoes the persisted document: " + response.getBody());

        assertEquals(readJson(POLICY_JSON),
                principalRepository.findById(principalId).orElseThrow().getContextPolicy(),
                "the entity mapping must read the jsonb column back (V92 created it; this is its first writer)");
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM agent_principals WHERE id = CAST(? AS UUID) "
                        + "AND context_policy::jsonb = CAST(? AS jsonb)",
                Integer.class, principalId.toString(), POLICY_JSON),
                "the value must be in the column, not merely in the persistence context");

        Map<String, Object> row = personalPrincipalRow(principalId);
        assertEquals(plainJson(POLICY_JSON), row.get("contextPolicy"),
                "GET /agent-principals projects the memory policy: " + row);
    }

    @Test
    void patchCarriesHooksAndContextPolicyTogether() {
        fixture();
        UUID principalId = createPrincipal("Both documents agent");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("hooks", plainJson(HOOKS_JSON));
        body.put("contextPolicy", plainJson(POLICY_JSON));

        ResponseEntity<Map> response = patch(principalId, body, globalToken());

        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals(plainJson(HOOKS_JSON), response.getBody().get("hooks"));
        assertEquals(plainJson(POLICY_JSON), response.getBody().get("contextPolicy"));
        assertEquals(readJson(HOOKS_JSON),
                principalRepository.findById(principalId).orElseThrow().getHooks());
        assertEquals(readJson(POLICY_JSON),
                principalRepository.findById(principalId).orElseThrow().getContextPolicy());
        assertEquals(1, auditCount(principalId, "agent_principal_hooks_updated"));
        assertEquals(1, auditCount(principalId, "agent_principal_context_policy_updated"),
                "each surface keeps its own audit action");
    }

    @Test
    void patchOnOneDocumentLeavesTheOtherUntouched() {
        fixture();
        UUID principalId = createPrincipal("Half update agent");
        assertEquals(HttpStatus.OK, patch(principalId, body("contextPolicy", plainJson(POLICY_JSON)),
                globalToken()).getStatusCode());
        int policyAuditsAfterFirstPatch = auditCount(principalId, "agent_principal_context_policy_updated");

        ResponseEntity<Map> response = patch(principalId, body("hooks", plainJson(HOOKS_JSON)),
                globalToken());

        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals(readJson(POLICY_JSON),
                principalRepository.findById(principalId).orElseThrow().getContextPolicy(),
                "a hooks-only PATCH must not clear the memory policy");
        assertEquals(plainJson(POLICY_JSON), response.getBody().get("contextPolicy"),
                "the echo reports the persisted policy, not a stale null for an untouched field");
        assertEquals(policyAuditsAfterFirstPatch,
                auditCount(principalId, "agent_principal_context_policy_updated"),
                "a hooks-only PATCH must not add a context-policy audit entry");
    }

    @Test
    void patchClearsContextPolicyWithNull() {
        fixture();
        UUID principalId = createPrincipal("Clearable memory agent");
        patch(principalId, body("contextPolicy", plainJson(POLICY_JSON)), globalToken());

        ResponseEntity<Map> response = patch(principalId, body("contextPolicy", null), globalToken());

        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        assertTrue(response.getBody().containsKey("contextPolicy"));
        assertNull(response.getBody().get("contextPolicy"), "null = cleared");
        assertNull(principalRepository.findById(principalId).orElseThrow().getContextPolicy());
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM agent_principals WHERE id = CAST(? AS UUID) AND context_policy IS NULL",
                Integer.class, principalId.toString()));
    }

    // ---------------------------------------------------------------------------------------
    // Body and shape rejections
    // ---------------------------------------------------------------------------------------

    @Test
    void patchRejectsUnknownKeysAndEmptyBodies() {
        fixture();
        UUID principalId = createPrincipal("Body shape agent");

        assertBadRequest(principalId, Map.of("name", "renamed"),
                "additionalProperties:false — no key outside hooks/contextPolicy is accepted");
        assertBadRequest(principalId, new LinkedHashMap<>(),
                "an empty body names no document");

        Map<String, Object> withExtraKey = body("contextPolicy", plainJson(POLICY_JSON));
        withExtraKey.put("origin", "ui");
        assertBadRequest(principalId, withExtraKey,
                "the origin enum belongs to the (future) memory rows, not to this document");

        assertNull(principalRepository.findById(principalId).orElseThrow().getContextPolicy(),
                "rejected bodies must not write");
    }

    @Test
    void patchRejectsMemoryDocumentsOutsideTheFrozenV1Shape() {
        fixture();
        UUID principalId = createPrincipal("Invalid policy agent");

        // The memory section and each of its values is validated by ContextPolicyValidator (single
        // write-side gate); this table is the user-facing contract of D29-25.
        List<String> invalidDocuments = List.of(
                "{\"unknown\":1}",                                  // unknown top-level key
                "{\"memory\":\"nope\"}",                            // memory not an object
                "{\"memory\":{\"unknown\":true}}",                  // unknown memory key
                "{\"memory\":{\"enabled\":\"yes\"}}",               // enabled not a boolean
                "{\"memory\":{\"writeMode\":\"auto\"}}",            // mode outside off|tool
                "{\"memory\":{\"types\":\"profile\"}}",             // types not an array
                "{\"memory\":{\"types\":[\"secret\"]}}",            // type outside profile|fact
                "{\"memory\":{\"types\":[1]}}"                      // non-string type
        );
        for (String document : invalidDocuments) {
            assertBadRequest(principalId, body("contextPolicy", plainJson(document)),
                    "must reject " + document);
        }

        ResponseEntity<Map> judge = patch(principalId,
                body("contextPolicy", plainJson("{\"memory\":{\"writeMode\":\"judge\"}}")),
                globalToken());
        assertEquals(HttpStatus.BAD_REQUEST, judge.getStatusCode(), String.valueOf(judge.getBody()));
        assertEquals("INVALID_REQUEST", judge.getBody().get("code"));
        assertTrue(String.valueOf(judge.getBody().get("detail"))
                        .contains("writeMode judge is not implemented in v1 (planned for M2)"),
                "the v1-reserved value must carry the roadmap detail: " + judge.getBody());

        assertNull(principalRepository.findById(principalId).orElseThrow().getContextPolicy(),
                "none of the rejected documents may reach the column");
    }

    @Test
    void patchRequiresTheTierAuthority() {
        fixture();
        UUID principalId = createPrincipal("Owner only memory agent");

        ResponseEntity<Map> response = patch(principalId, body("contextPolicy", plainJson(POLICY_JSON)),
                tokenOf(strangerUserId));

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals("AGENT_PRINCIPAL_OWNER_MISMATCH", response.getBody().get("code"));
        assertNull(principalRepository.findById(principalId).orElseThrow().getContextPolicy(),
                "a stranger must not write somebody else's memory policy");
    }

    // ---------------------------------------------------------------------------------------
    // fixtures / helpers
    // ---------------------------------------------------------------------------------------

    private void fixture() {
        User admin = userRepository.saveAndFlush(new User(
                "memory-http-" + UUID.randomUUID() + "@test.com", "hash", "Memory HTTP admin"));
        adminUserId = admin.getId();
        grantDefaultService.ensureUserDefault(admin);
        AccessRole adminRole = accessRoleRepository.findByName("ADMIN")
                .orElseThrow(() -> new IllegalStateException("ADMIN role missing (V87)"));
        AccessRoleBinding binding = roleBindingRepository.save(new AccessRoleBinding(adminRole.getId(),
                "user", adminUserId, AccessScope.INSTANCE, null, adminUserId));
        seededRoleBindingIds.add(binding.getId());
        materializer.materializeSubject("user", adminUserId, adminUserId, null);
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Memory ws", adminUserId.toString());
        workspaceId = workspace.getId();
        User stranger = userRepository.saveAndFlush(new User(
                "memory-http-stranger-" + UUID.randomUUID() + "@test.com", "hash", "Memory stranger"));
        strangerUserId = stranger.getId();
        grantDefaultService.ensureUserDefault(stranger);
    }

    private UUID createPrincipal(String name) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("scope", "PERSONAL");
        ResponseEntity<Map> response = exchange(HttpMethod.POST, "/api/v1/agent-principals",
                globalToken(), body);
        assertEquals(HttpStatus.CREATED, response.getStatusCode(), String.valueOf(response.getBody()));
        UUID principalId = UUID.fromString(String.valueOf(response.getBody().get("principalId")));
        principalIds.add(principalId);
        return principalId;
    }

    private Map<String, Object> body(String key, Object value) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put(key, value);
        return body;
    }

    private Map<String, Object> personalPrincipalRow(UUID principalId) {
        ResponseEntity<Map> response = exchange(HttpMethod.GET,
                "/api/v1/agent-principals?scope=PERSONAL", globalToken(), null);
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        List<Map<String, Object>> principals =
                (List<Map<String, Object>>) response.getBody().get("principals");
        assertNotNull(principals, String.valueOf(response.getBody()));
        return principals.stream()
                .filter(item -> principalId.toString().equals(String.valueOf(item.get("principalId"))))
                .findFirst()
                .orElseThrow(() -> new AssertionError("principal not listed: " + principals));
    }

    private ResponseEntity<Map> patch(UUID principalId, Map<String, Object> body, String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return patchClient.exchange(url("/api/v1/agent-principals/" + principalId),
                HttpMethod.PATCH, new HttpEntity<>(body, headers), Map.class);
    }

    private void assertBadRequest(UUID principalId, Map<String, Object> body, String why) {
        ResponseEntity<Map> response = patch(principalId, body, globalToken());
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode(), why + " — " + response.getBody());
        assertEquals("INVALID_REQUEST", response.getBody().get("code"), why);
    }

    private int auditCount(UUID principalId, String action) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = ? "
                        + "AND CAST(resource_id AS VARCHAR) = ?",
                Integer.class, action, principalId.toString());
    }

    private String globalToken() {
        return tokenOf(adminUserId);
    }

    private String tokenOf(UUID userId) {
        return TestDataFactory.createGlobalToken(userId.toString(), emailOf(userId), "USER", 0);
    }

    private String emailOf(UUID userId) {
        return userRepository.findById(userId).orElseThrow().getEmail();
    }

    private void deleteUser(UUID userId) {
        if (userId == null) {
            return;
        }
        jdbcTemplate.update("DELETE FROM audit_logs WHERE user_id = CAST(? AS UUID)", userId.toString());
        grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", userId));
        roleBindingRepository.deleteAll(
                roleBindingRepository.findBySubjectTypeAndSubjectId("user", userId));
        userRepository.deleteById(userId);
    }

    private JsonNode readJson(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException("fixture JSON is invalid: " + json, e);
        }
    }

    /** Jackson-2 tree lowered to plain Java so the Jackson-3 wire converter sends the document. */
    private Object plainJson(String json) {
        return objectMapper.convertValue(readJson(json), Object.class);
    }

    private ResponseEntity<Map> exchange(HttpMethod method, String path, String token, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(url(path), method, new HttpEntity<>(body, headers), Map.class);
    }
}
