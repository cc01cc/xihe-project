package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AccessRole;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
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
 * Jackson-3 wire cannot. The shape being pinned is the D29-25 ruling, extended by M1-6 / D29-26:</p>
 * <pre>{@code
 * { "memory": { "enabled": false, "writeMode": "off", "passive": "off",
 *               "types": ["profile", "fact"] } }
 * }</pre>
 *
 * <p>Deliberately not asserted here: any automatic write that <i>takes effect</i> — D29-24 rejected it,
 * and the M1-6 passive path can only produce {@code candidate} rows, whose assertions belong to the
 * memory-write tests rather than to the policy wire test.
 * The hooks document has its own class ({@link AgentPrincipalHooksHttpTest}); this one owns the
 * context-policy document and the interplay of the two on the shared PATCH.</p>
 */
class AgentPrincipalContextPolicyHttpTest extends AbstractIntegrationTest {

    private static final String HOOKS_JSON =
            "{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}";
    private static final String POLICY_JSON =
            "{\"memory\":{\"enabled\":true,\"writeMode\":\"tool\",\"passive\":\"summary\","
                    + "\"types\":[\"profile\",\"fact\"]}}";

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
        UUID principalId = createPrincipal("MemoryAgent");

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
        UUID principalId = createPrincipal("BothDocumentsAgent");
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
        UUID principalId = createPrincipal("HalfUpdateAgent");
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
        UUID principalId = createPrincipal("ClearableMemoryAgent");
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
        UUID principalId = createPrincipal("BodyShapeAgent");

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
        UUID principalId = createPrincipal("InvalidPolicyAgent");

        // The memory section and each of its values is validated by ContextPolicyValidator (single
        // write-side gate); this table is the user-facing contract of D29-25.
        List<String> invalidDocuments = List.of(
                "{\"unknown\":1}",                                  // unknown top-level key
                "{\"memory\":\"nope\"}",                            // memory not an object
                "{\"memory\":{\"unknown\":true}}",                  // unknown memory key
                "{\"memory\":{\"enabled\":\"yes\"}}",               // enabled not a boolean
                "{\"memory\":{\"writeMode\":\"auto\"}}",            // mode outside off|tool
                "{\"memory\":{\"passive\":\"auto\"}}",              // passive outside off|summary|judge
                "{\"memory\":{\"passive\":\"always\"}}",            // no alias may silently mean summary
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
        UUID principalId = createPrincipal("OwnerOnlyMemoryAgent");

        ResponseEntity<Map> response = patch(principalId, body("contextPolicy", plainJson(POLICY_JSON)),
                tokenOf(strangerUserId));

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals("AGENT_PRINCIPAL_OWNER_MISMATCH", response.getBody().get("code"));
        assertNull(principalRepository.findById(principalId).orElseThrow().getContextPolicy(),
                "a stranger must not write somebody else's memory policy");
    }

    // ---------------------------------------------------------------------------------------
    // Guard lock (Lead ruling 2026-11-02) + the two projections the UI needs
    // ---------------------------------------------------------------------------------------

    @Test
    void patchRefusesToWriteAPresetGuardsMemoryPolicy() {
        fixture();
        UUID guardId = seedPresetGuard("PresetGuardMemory");

        ResponseEntity<Map> policy = patch(guardId, body("contextPolicy", plainJson(POLICY_JSON)),
                globalToken());
        assertEquals(HttpStatus.FORBIDDEN, policy.getStatusCode(), String.valueOf(policy.getBody()));
        assertEquals("GUARD_CONTEXT_POLICY_IMMUTABLE", policy.getBody().get("code"),
                "a guard is a system asset: its memory policy must refuse with its own code");

        ResponseEntity<Map> hooks = patch(guardId, body("hooks", plainJson(HOOKS_JSON)), globalToken());
        assertEquals(HttpStatus.FORBIDDEN, hooks.getStatusCode(), String.valueOf(hooks.getBody()));
        assertEquals("GUARD_HOOKS_IMMUTABLE", hooks.getBody().get("code"),
                "the two guard refusals must stay distinguishable on the wire");

        assertNull(principalRepository.findById(guardId).orElseThrow().getContextPolicy(),
                "a refused write must not touch the row");
        assertEquals(0, auditCount(guardId, "agent_principal_context_policy_updated"),
                "a refused write must not be audited as applied");
    }

    @Test
    void workspaceAgentListProjectsTheMemoryPolicy() {
        fixture();
        UUID principalId = createPrincipal("ListedMemoryAgent");
        assertEquals(HttpStatus.OK, patch(principalId, body("contextPolicy", plainJson(POLICY_JSON)),
                globalToken()).getStatusCode());
        bindToWorkspace(principalId);

        Map<String, Object> row = listAgents().stream()
                .filter(item -> principalId.toString().equals(String.valueOf(item.get("principalId"))))
                .findFirst()
                .orElseThrow(() -> new AssertionError("principal not listed in the workspace agent list"));

        assertTrue(row.containsKey("contextPolicy"), "every row carries the key: " + row);
        assertEquals(plainJson(POLICY_JSON), row.get("contextPolicy"),
                "the workspace agent list must project the memory policy, or the UI cannot manage it");
    }

    @Test
    void createResponseReportsThatMemoryIsOff() {
        fixture();
        Map<String, Object> created = createPrincipalResponse("FreshMemoryAgent");

        assertTrue(created.containsKey("contextPolicy"),
                "the create view must state the memory policy: " + created);
        assertNull(created.get("contextPolicy"),
                "a new subject starts with memory off (null = no policy)");
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
        // D22（2026-11-05 Lead 裁定）：agent-principal 写面改为"上下文最先"。stranger 仍需能证明
        // "上下文合法但不是 owner" ⇒ 必须真的是本 workspace 成员，否则会先在租户层被 403 拦下。
        workspaceFixture.bindWorkspaceRole(workspaceId, strangerUserId,
                com.cc01cc.p.xihe.cp.entity.WorkspaceRole.MEMBER);
    }

    private UUID createPrincipal(String name) {
        return UUID.fromString(String.valueOf(createPrincipalResponse(name).get("principalId")));
    }

    private Map<String, Object> createPrincipalResponse(String name) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        // D-174: no tier field; the single creation path is workspace-authorized.
        ResponseEntity<Map> response = exchange(HttpMethod.POST, "/api/v1/agent-principals",
                workspaceToken(), body);
        assertEquals(HttpStatus.CREATED, response.getStatusCode(), String.valueOf(response.getBody()));
        principalIds.add(UUID.fromString(String.valueOf(response.getBody().get("principalId"))));
        return response.getBody();
    }

    /** Seeds the exact provenance a builtin-template create writes (V95 CHECK: both halves). */
    private UUID seedPresetGuard(String name) {
        var snapshot = objectMapper.createObjectNode();
        snapshot.putNull("templateId");
        snapshot.put("templateName", "守卫 Guard");
        snapshot.putArray("permissions");
        AgentPrincipal guard = agentPrincipalService.createPrincipal(
                adminUserId.toString(), name, null, snapshot,
                null, null, null, null,
                AgentPrincipal.ORIGIN_SYSTEM_PRESET, "00000000-0000-4000-8000-0000000000a2", null);
        // D-174: tiers are gone; the seed keeps its legacy owner column (data preserved).
        guard.setOwnerUserId(adminUserId);
        guard = principalRepository.saveAndFlush(guard);
        principalIds.add(guard.getId());
        return guard.getId();
    }

    /** 2026-11-04 裁定（PLAN-0629）：列表只含「绑定了这里 ∪ 在这里持有角色绑定」的主体。 */
    private void bindToWorkspace(UUID principalId) {
        ResponseEntity<Map> response = exchange(HttpMethod.PUT,
                "/api/v1/workspaces/" + workspaceId + "/agents/" + principalId,
                workspaceToken(), Map.of("permissions", List.of()));
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
    }

    private List<Map<String, Object>> listAgents() {
        ResponseEntity<Map> response = exchange(HttpMethod.GET,
                "/api/v1/workspaces/" + workspaceId + "/agents", workspaceToken(), null);
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        List<Map<String, Object>> agents = (List<Map<String, Object>>) response.getBody().get("agents");
        assertNotNull(agents, "the frozen {agents:[...]} envelope: " + response.getBody());
        return agents;
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
        // D22：写面必须带显式 workspace 上下文（否则 409 WORKSPACE_CONTEXT_REQUIRED）。
        headers.set("X-Workspace-Id", workspaceId.toString());
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
