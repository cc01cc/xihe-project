package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AccessRoleBinding;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ConfigEntity;
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
import com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
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
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0625 V10 walkthrough, Gaps I: the hook-subscription document has to survive the HTTP
 * boundary as the {@code {advisors:[{kind,on}]}} object the UI reads.
 *
 * <p>Why this class exists (the lesson of this batch): {@code GuardTemplatePropagationTest} mocks
 * {@code AgentTemplateService} and hands the service a snapshot that already contains {@code hooks},
 * so it could never see that the projection (or the create response) mangled the document. Every
 * assertion here goes through {@code restTemplate} against the running CP and, where the walkthrough
 * asserted a database value, reads the row back.</p>
 */
class AgentPrincipalHooksHttpTest extends AbstractIntegrationTest {

    private static final String HOOKS_JSON =
            "{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}";

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
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private AgentTemplateService agentTemplateService;
    @Autowired private ConfigJpaRepository configJpaRepository;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private RestTemplate patchClient;
    private UUID adminUserId;
    private UUID strangerUserId;
    private UUID workspaceId;
    private final List<UUID> seededRoleBindingIds = new ArrayList<>();
    private final List<UUID> principalIds = new ArrayList<>();
    private final List<UUID> configIds = new ArrayList<>();

    @BeforeEach
    void initPatchClient() {
        // PATCH is not supported by HttpURLConnection (the shared RestTemplate's default factory).
        patchClient = new RestTemplate(new JdkClientHttpRequestFactory());
        patchClient.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(ClientHttpResponse response) {
                // Every non-2xx is an assertion input here, never an exception.
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
        configJpaRepository.deleteAllById(configIds);
        configIds.clear();
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

    // ---------------------------------------------------------------------------------------
    // Gap I: GET /api/v1/workspaces/{workspaceId}/agents
    // ---------------------------------------------------------------------------------------

    @Test
    void workspaceAgentListProjectsHooksAsTheAdvisorsObject() {
        fixture();
        UUID hooked = createPrincipal("Hooked agent", HOOKS_JSON);
        UUID plain = createPrincipal("Plain agent", null);

        List<Map<String, Object>> agents = listAgents();

        Object hooks = hooksOf(agents, hooked);
        assertInstanceOf(Map.class, hooks,
                "Gap I: hooks must stay the {advisors:[…]} object — the permissions-array projection "
                        + "answered [] for every row: " + agents);
        List<?> advisors = (List<?>) ((Map<?, ?>) hooks).get("advisors");
        assertNotNull(advisors, "hooks.advisors is the wire shape: " + hooks);
        assertEquals(1, advisors.size(), String.valueOf(hooks));
        assertEquals("guard", ((Map<?, ?>) advisors.get(0)).get("kind"));
        assertEquals(List.of("approval.ask"), ((Map<?, ?>) advisors.get(0)).get("on"));
        assertNull(hooksOf(agents, plain), "no subscriptions must project as null, never as []");
    }

    // ---------------------------------------------------------------------------------------
    // Gap J: the create/list responses must carry plain JSON documents, not Jackson bean metadata
    // ---------------------------------------------------------------------------------------

    @Test
    void createResponseCarriesHooksAndAllowedModelsAsDocuments() {
        fixture();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", "Explicit hooks agent");
        body.put("scope", "PERSONAL");
        body.put("hooks", plainJson(HOOKS_JSON));
        body.put("allowedModels", List.of(Map.of("provider", "openai", "model", "gpt-4.1")));

        ResponseEntity<Map> response = exchange(HttpMethod.POST, "/api/v1/agent-principals",
                globalToken(), body);

        assertEquals(HttpStatus.CREATED, response.getStatusCode(), String.valueOf(response.getBody()));
        Map<String, Object> created = response.getBody();
        assertNotNull(created);
        assertNoJacksonBeanMetadata(created);
        assertEquals(Map.of("advisors", List.of(Map.of("kind", "guard",
                        "on", List.of("approval.ask")))), created.get("hooks"),
                "Gap J: the response must carry the subscription document: " + created);
        assertEquals(List.of(Map.of("provider", "openai", "model", "gpt-4.1")),
                created.get("allowedModels"),
                "Gap J sibling: allowedModels is a Jackson-2 node too and must not be bean metadata");
        principalIds.add(UUID.fromString(String.valueOf(created.get("principalId"))));
    }

    @Test
    void principalListCarriesHooksAsADocument() {
        fixture();
        UUID hooked = createPrincipal("Listed hooks agent", HOOKS_JSON);

        ResponseEntity<Map> response = exchange(HttpMethod.GET,
                "/api/v1/agent-principals?scope=PERSONAL", globalToken(), null);

        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        List<Map<String, Object>> principals =
                (List<Map<String, Object>>) response.getBody().get("principals");
        assertNotNull(principals, String.valueOf(response.getBody()));
        Map<String, Object> row = principals.stream()
                .filter(item -> hooked.toString().equals(String.valueOf(item.get("principalId"))))
                .findFirst()
                .orElseThrow(() -> new AssertionError("principal not listed: " + principals));
        assertNoJacksonBeanMetadata(row);
        assertEquals(Map.of("advisors", List.of(Map.of("kind", "guard",
                        "on", List.of("approval.ask")))), row.get("hooks"),
                "the scoped list is the same projection and had the same defect: " + row);
    }

    // ---------------------------------------------------------------------------------------
    // Gap H: the template's subscriptions must reach the principal, through the REAL resolver
    // ---------------------------------------------------------------------------------------

    /**
     * The walkthrough's chain, without any mock: a template stored in the config domain declares
     * {@code hooks} → {@link AgentTemplateService#resolveForCreation} (the production resolver) must
     * carry them into the snapshot → the created principal must land them in
     * {@code agent_principals.hooks}.
     *
     * <p>Boundary, stated on purpose so nobody later reads it as a missing migration: this fixes the
     * create path only. A {@code SYSTEM_PRESET} row created <b>before</b> the fix keeps
     * {@code hooks = NULL}; no V99 backfill is written because XH has no deployment surface and the
     * only affected rows are local stack artefacts of the walkthrough.</p>
     */
    @Test
    void templateHooksReachTheDatabaseThroughTheRealResolver() {
        fixture();
        UUID roleId = UUID.randomUUID();
        UUID templateId = UUID.randomUUID();
        saveConfigLayer("roles", rolesArray(roleId, "guard", "read"));
        saveConfigLayer("templates", templatesArray(templateId, "Frozen guard", roleId, HOOKS_JSON));

        AgentTemplateService.ResolvedTemplate resolved = agentTemplateService.resolveForCreation(
                adminUserId.toString(), null, templateId.toString());
        assertEquals("user", resolved.sourceLayer());
        assertEquals(readJson(HOOKS_JSON), resolved.snapshot().path("hooks"),
                "Gap H: the real resolver dropped the template's hooks — the snapshot is what the "
                        + "create path reads its default subscription from");

        UUID created = createPrincipal("Template hooked agent", null, templateId.toString());

        JsonNode stored = principalRepository.findById(created).orElseThrow().getHooks();
        assertNotNull(stored, "Gap H: a guard created from a template with hooks must not land NULL");
        assertEquals(readJson(HOOKS_JSON), stored);
    }

    @Test
    void templateWithoutHooksLeavesThePrincipalWithoutSubscriptions() {
        fixture();
        UUID roleId = UUID.randomUUID();
        UUID templateId = UUID.randomUUID();
        saveConfigLayer("roles", rolesArray(roleId, "plain", "read"));
        saveConfigLayer("templates", templatesArray(templateId, "Plain template", roleId, null));

        AgentTemplateService.ResolvedTemplate resolved = agentTemplateService.resolveForCreation(
                adminUserId.toString(), null, templateId.toString());
        assertTrue(resolved.snapshot().path("hooks").isMissingNode(),
                "no declaration ⇒ no hooks node at all (the create path reads absent as 'none')");

        UUID created = createPrincipal("Plain agent", null, templateId.toString());

        assertNull(principalRepository.findById(created).orElseThrow().getHooks(),
                "a template without hooks must still create a principal without subscriptions");
    }

    // ---------------------------------------------------------------------------------------
    // Gap K: PATCH /api/v1/agent-principals/{principalId} — body is exactly {hooks}
    // ---------------------------------------------------------------------------------------

    @Test
    void patchReplacesSubscriptionsAndWritesTheAuditTrail() {
        fixture();
        UUID principalId = createPrincipal("Mutable agent", null);

        ResponseEntity<Map> response = patch(principalId, hooksBody(plainJson(HOOKS_JSON)),
                globalToken());

        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals(principalId.toString(), response.getBody().get("principalId"));
        assertNoJacksonBeanMetadata(response.getBody());
        assertEquals(Map.of("advisors", List.of(Map.of("kind", "guard",
                        "on", List.of("approval.ask")))), response.getBody().get("hooks"),
                "the response echoes the stored document: " + response.getBody());
        assertEquals(readJson(HOOKS_JSON),
                principalRepository.findById(principalId).orElseThrow().getHooks());
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_hooks_updated' "
                        + "AND CAST(resource_id AS VARCHAR) = ?",
                Integer.class, principalId.toString()), "the mutation is durable-audited");
    }

    @Test
    void patchClearsSubscriptionsWithNull() {
        fixture();
        UUID principalId = createPrincipal("Clearable agent", HOOKS_JSON);

        ResponseEntity<Map> response = patch(principalId, hooksBody(null), globalToken());

        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        assertTrue(response.getBody().containsKey("hooks"), String.valueOf(response.getBody()));
        assertNull(response.getBody().get("hooks"), "null = every subscription cleared");
        assertNull(principalRepository.findById(principalId).orElseThrow().getHooks());
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_hooks_updated' "
                        + "AND CAST(resource_id AS VARCHAR) = ?",
                Integer.class, principalId.toString()));
    }

    /**
     * D25-14: a preset guard's subscriptions come from the template, so the API refuses with its own
     * code. The row is seeded through the production write path (origin + preset_id are what
     * {@code createPrincipalFromTemplate} writes for the builtin template); only the HTTP client is
     * the boundary under test.
     */
    @Test
    void patchRefusesPresetGuardsWithTheirOwnCode() {
        fixture();
        UUID guardId = seedPresetGuard("Preset guard");

        ResponseEntity<Map> response = patch(guardId, hooksBody(plainJson(HOOKS_JSON)), globalToken());

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals("GUARD_HOOKS_IMMUTABLE", response.getBody().get("code"),
                "the refusal keeps its own code, distinct from GUARD_CAP_IMMUTABLE");
        assertNull(principalRepository.findById(guardId).orElseThrow().getHooks(),
                "a refused write must not touch the row");
        assertEquals(0, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_hooks_updated' "
                        + "AND CAST(resource_id AS VARCHAR) = ?",
                Integer.class, guardId.toString()), "a refused write must not be audited as applied");
    }

    @Test
    void patchRequiresTheTierAuthority() {
        fixture();
        UUID principalId = createPrincipal("Owner only agent", HOOKS_JSON);

        ResponseEntity<Map> response = patch(principalId, hooksBody(plainJson(HOOKS_JSON)),
                tokenOf(strangerUserId));

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals("AGENT_PRINCIPAL_OWNER_MISMATCH", response.getBody().get("code"),
                "the tier authority reuses the disable-path code for a foreign PERSONAL principal");
        assertEquals(readJson(HOOKS_JSON),
                principalRepository.findById(principalId).orElseThrow().getHooks(),
                "a stranger must not rewrite somebody else's subscriptions");
    }

    @Test
    void patchRejectsAnythingButAHooksDocument() {
        fixture();
        UUID principalId = createPrincipal("Body shape agent", HOOKS_JSON);

        Map<String, Object> extraKey = hooksBody(plainJson(HOOKS_JSON));
        extraKey.put("name", "renamed");
        assertBadRequest(principalId, extraKey, "additionalProperties:false — no other key is accepted");

        assertBadRequest(principalId, new LinkedHashMap<>(), "an empty body is not a hooks document");

        assertBadRequest(principalId, hooksBody(plainJson(
                        "{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.deny\"]}]}")),
                "an action class outside the frozen whitelist (D25-12) must answer 400, not store a "
                        + "subscription that can never fire");

        assertEquals(readJson(HOOKS_JSON),
                principalRepository.findById(principalId).orElseThrow().getHooks(),
                "none of the rejected bodies may change the stored document");
    }

    // ---------------------------------------------------------------------------------------
    // fixtures / helpers
    // ---------------------------------------------------------------------------------------

    private void fixture() {
        User admin = userRepository.saveAndFlush(new User(
                "hooks-http-" + UUID.randomUUID() + "@test.com", "hash", "Hooks HTTP admin"));
        adminUserId = admin.getId();
        // A plain account (USER tier: CREATE_OWN_AGENT) that also holds instance,admin — exactly the
        // matrix the walkthrough used (admin can read the instance template layer and create).
        grantDefaultService.ensureUserDefault(admin);
        AccessRole adminRole = accessRoleRepository.findByName("ADMIN")
                .orElseThrow(() -> new IllegalStateException("ADMIN role missing (V87)"));
        AccessRoleBinding binding = roleBindingRepository.save(new AccessRoleBinding(adminRole.getId(),
                "user", adminUserId, AccessScope.INSTANCE, null, adminUserId));
        seededRoleBindingIds.add(binding.getId());
        materializer.materializeSubject("user", adminUserId, adminUserId, null);
        // The list is workspace-scoped: the caller must be a member of an active workspace.
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Hooks ws", adminUserId.toString());
        workspaceId = workspace.getId();
        User stranger = userRepository.saveAndFlush(new User(
                "hooks-http-stranger-" + UUID.randomUUID() + "@test.com", "hash", "Hooks HTTP stranger"));
        strangerUserId = stranger.getId();
        grantDefaultService.ensureUserDefault(stranger);
    }

    private UUID createPrincipal(String name, String hooksJson) {
        return createPrincipal(name, hooksJson, null);
    }

    /** Seeds the exact provenance a builtin-template create writes (V95 CHECK: both halves). */
    private UUID seedPresetGuard(String name) {
        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.putNull("templateId");
        snapshot.put("templateName", "守卫 Guard");
        snapshot.putArray("permissions");
        AgentPrincipal guard = agentPrincipalService.createPrincipal(
                adminUserId.toString(), name, null, snapshot, "PERSONAL", adminUserId,
                null, null, null, null,
                AgentPrincipal.ORIGIN_SYSTEM_PRESET, "00000000-0000-4000-8000-0000000000a2");
        principalIds.add(guard.getId());
        return guard.getId();
    }

    /** The frozen body shape: exactly one key, {@code hooks}, which may be null (clear). */
    private Map<String, Object> hooksBody(Object hooks) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("hooks", hooks);
        return body;
    }

    private ResponseEntity<Map> patch(UUID principalId, Map<String, Object> body, String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        // PATCH needs an HTTP client that supports the method; the shared RestTemplate uses
        // HttpURLConnection, which does not.
        return patchClient.exchange(url("/api/v1/agent-principals/" + principalId),
                HttpMethod.PATCH, new HttpEntity<>(body, headers), Map.class);
    }

    private void assertBadRequest(UUID principalId, Map<String, Object> body, String why) {
        ResponseEntity<Map> response = patch(principalId, body, globalToken());
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode(),
                why + " — " + response.getBody());
        assertEquals("INVALID_REQUEST", response.getBody().get("code"), why);
    }

    /** One user-layer config row (the assembled document shape: one row per document key). */
    private void saveConfigLayer(String configKey, JsonNode value) {
        ConfigEntity entity = new ConfigEntity();
        entity.setLayer("user");
        entity.setUserId(adminUserId);
        entity.setDomain("agent-templates");
        entity.setConfigKey(configKey);
        entity.setConfigValue(value.toString());
        entity.setUpdatedBy("test-fixture");
        configIds.add(configJpaRepository.saveAndFlush(entity).getId());
    }

    private JsonNode rolesArray(UUID roleId, String name, String... actionClasses) {
        ObjectNode role = objectMapper.createObjectNode();
        role.put("id", roleId.toString());
        role.put("name", name);
        ArrayNode permissions = role.putArray("permissions");
        for (String actionClass : actionClasses) {
            permissions.addObject().put("actionClass", actionClass).put("resource", "*");
        }
        ArrayNode roles = objectMapper.createArrayNode();
        roles.add(role);
        return roles;
    }

    private JsonNode templatesArray(UUID templateId, String name, UUID roleId, String hooksJson) {
        ObjectNode template = objectMapper.createObjectNode();
        template.put("id", templateId.toString());
        template.put("name", name);
        template.put("description", name + " description");
        template.put("systemPrompt", "You are a fixture agent.");
        template.put("toolMode", "none");
        template.put("roleId", roleId.toString());
        if (hooksJson != null) {
            template.set("hooks", readJson(hooksJson));
        }
        ArrayNode templates = objectMapper.createArrayNode();
        templates.add(template);
        return templates;
    }

    /**
     * {@code templateId == null} keeps the create path on the default (template-less) snapshot.
     *
     * <p>The hooks fixture is a plain {@code Map}/{@code List} on purpose: the test's own client
     * serialises with Jackson 3, so a Jackson-2 {@link JsonNode} would be sent as bean metadata —
     * the very defect Gap J asserts on the server side.</p>
     */
    private UUID createPrincipal(String name, String hooksJson, String templateId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("scope", "PERSONAL");
        if (templateId != null) {
            body.put("templateId", templateId);
        }
        if (hooksJson != null) {
            body.put("hooks", plainJson(hooksJson));
        }
        ResponseEntity<Map> response = exchange(HttpMethod.POST, "/api/v1/agent-principals",
                globalToken(), body);
        assertEquals(HttpStatus.CREATED, response.getStatusCode(), String.valueOf(response.getBody()));
        UUID principalId = UUID.fromString(String.valueOf(response.getBody().get("principalId")));
        principalIds.add(principalId);
        return principalId;
    }

    private List<Map<String, Object>> listAgents() {
        ResponseEntity<Map> response = exchange(HttpMethod.GET,
                "/api/v1/workspaces/" + workspaceId + "/agents", workspaceToken(), null);
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        List<Map<String, Object>> agents = (List<Map<String, Object>>) response.getBody().get("agents");
        assertNotNull(agents, "the frozen {agents:[...]} envelope: " + response.getBody());
        return agents;
    }

    private Object hooksOf(List<Map<String, Object>> agents, UUID principalId) {
        Map<String, Object> row = agents.stream()
                .filter(item -> principalId.toString().equals(String.valueOf(item.get("principalId"))))
                .findFirst()
                .orElseThrow(() -> new AssertionError("principal not listed: " + principalId + " in " + agents));
        assertTrue(row.containsKey("hooks"), "every row carries the hooks key: " + row);
        return row.get("hooks");
    }

    private JsonNode readJson(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException("fixture JSON is invalid: " + json, e);
        }
    }

    /**
     * Negative assertion for Gap J: a Jackson-2 node that reached the response would serialise as its
     * bean properties ({@code array}, {@code containerNode}, {@code nodeType}, {@code missingNode}…),
     * so any of those keys anywhere in the body means the document never made it onto the wire.
     */
    private void assertNoJacksonBeanMetadata(Object value) {
        if (value instanceof Map<?, ?> map) {
            for (String forbidden : List.of("nodeType", "containerNode", "missingNode", "valueNode")) {
                assertTrue(!map.containsKey(forbidden),
                        "response carries Jackson bean metadata ('" + forbidden + "'): " + map);
            }
            map.values().forEach(this::assertNoJacksonBeanMetadata);
        } else if (value instanceof List<?> list) {
            list.forEach(this::assertNoJacksonBeanMetadata);
        }
    }

    /** A Jackson-2 tree lowered to plain Java so the Jackson-3 wire converter sends the document. */
    private Object plainJson(String json) {
        return objectMapper.convertValue(readJson(json), Object.class);
    }

    private String globalToken() {
        return tokenOf(adminUserId);
    }

    private String workspaceToken() {
        return TestDataFactory.createWorkspaceToken(adminUserId.toString(), emailOf(adminUserId), "USER",
                workspaceId.toString(), 0);
    }

    private String tokenOf(UUID userId) {
        return TestDataFactory.createGlobalToken(userId.toString(), emailOf(userId), "USER", 0);
    }

    private String emailOf(UUID userId) {
        return userRepository.findById(userId).orElseThrow().getEmail();
    }

    private ResponseEntity<Map> exchange(HttpMethod method, String path, String token, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(url(path), method, new HttpEntity<>(body, headers), Map.class);
    }
}
