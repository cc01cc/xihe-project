package com.cc01cc.p.xihe.cp.service;

import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.TestDatabaseProvider;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.migration.AgentPrincipalScopeUpgradeFixture;
import com.cc01cc.p.xihe.cp.policy.SystemAccessRoleCatalog;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * V19 (PLAN-0651): real HTTP behaviour on a database replayed through V125 → V126.
 *
 * <p>The upgrade fixture physically creates three legacy tier principals (PERSONAL / WORKSPACE /
 * INSTANCE) and their surviving bindings/grants before the head migration runs. These seven classes
 * are the positive/negative contract from {@code evidence/v19-evidence-plan.md} §4: every class has
 * an allow and a deny, a deny asserts no durable row/change, and no response may leak the removed
 * {@code scope} tier field.</p>
 *
 * <p>D-174 makes the old tier values semantically superseded: authorization is derived from owner
 * column, workspace binding and role bindings only. This test proves the surviving legacy rows are
 * still readable and that new writes cannot reintroduce a tier.</p>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
@TestPropertySource(properties = "XIHE_WORKSPACE_DOCKER_BACKEND=disabled")
@TestMethodOrder(MethodOrderer.MethodName.class)
class AgentPrincipalScopeUpgradeBehaviorTest {

    private static final String PASSWORD = TestDataFactory.PASSWORD;
    private static final String POLICY_JSON = "{\"memory\":{\"enabled\":true,\"writeMode\":\"tool\","
            + "\"passive\":\"summary\",\"types\":[\"profile\",\"fact\"]}}";

    @DynamicPropertySource
    static void datasource(DynamicPropertyRegistry registry) {
        TestDatabaseProvider.DatabaseRef database = AgentPrincipalScopeUpgradeFixture.database();
        registry.add("spring.datasource.url", database::jdbcUrl);
        registry.add("spring.datasource.username", database::username);
        registry.add("spring.datasource.password", database::password);
    }

    @LocalServerPort
    private int port;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private SessionRepository sessionRepository;

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private Actor owner;

    @BeforeEach
    void bindOwner() throws Exception {
        owner = register("v19owner");
        workspaceFixture.bindWorkspaceRole(AgentPrincipalScopeUpgradeFixture.WORKSPACE_ID,
                UUID.fromString(owner.userId()), WorkspaceRole.OWNER);
    }

    @Test
    void createAcceptsNoTierAndRejectsLegacyTierField() throws Exception {
        Response rejected = send(owner.token(), AgentPrincipalScopeUpgradeFixture.WORKSPACE_ID.toString(),
                "POST", "/api/v1/agent-principals",
                Map.of("name", "v19rejected", "scope", "PERSONAL"));
        assertEquals(400, rejected.status(), rejected.body().toString());
        assertEquals("INVALID_REQUEST", rejected.body().path("code").asText());
        assertEquals(0, count("SELECT count(*) FROM agent_principals WHERE name = ?", "v19rejected"),
                "a rejected create must not write a row");

        Response created = send(owner.token(), AgentPrincipalScopeUpgradeFixture.WORKSPACE_ID.toString(),
                "POST", "/api/v1/agent-principals", Map.of("name", "v19tierless"));
        assertEquals(201, created.status(), created.body().toString());
        assertTrue(created.body().path("ownerUserId").isNull(),
                "D-174: create no longer derives an owner from a legacy tier");
        assertFalse(created.body().has("scope"), "the removed tier field must not reappear: "
                + created.body());
        UUID principalId = UUID.fromString(created.body().path("principalId").asText());
        assertEquals(0, count("SELECT count(*) FROM agent_principals AS p"
                + " WHERE p.id = CAST(? AS UUID) AND p.owner_user_id IS NOT NULL", principalId.toString()));
        assertEquals(1, count("SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_created'"
                + " AND resource_id::text = ? AND details::jsonb->>'authorizationAction' ="
                + " 'MANAGE_WORKSPACE_AGENTS'", principalId.toString()),
                "the create audit carries the authorization action, not a tier");
    }

    @Test
    void listUsesBindingAndOwnerNotLegacyTier() throws Exception {
        Actor outsider = register("v19outsider");
        workspaceFixture.createOwnedWorkspace("v19 own workspace", outsider.userId());

        int auditBefore = count("SELECT count(*) FROM audit_logs WHERE action LIKE '%workspace_agent%'");
        Response listed = send(owner.token(), null, "GET", "/api/v1/agent-principals?workspaceId="
                + AgentPrincipalScopeUpgradeFixture.WORKSPACE_ID, null);
        assertEquals(200, listed.status(), listed.body().toString());
        JsonNode rows = listed.body().path("principals");
        assertTrue(rows.isArray(), listed.body().toString());
        Map<String, JsonNode> byId = new LinkedHashMap<>();
        rows.forEach(row -> byId.put(row.path("principalId").asText(), row));
        for (UUID legacy : List.of(AgentPrincipalScopeUpgradeFixture.PERSONAL_PRINCIPAL_ID,
                AgentPrincipalScopeUpgradeFixture.WORKSPACE_PRINCIPAL_ID,
                AgentPrincipalScopeUpgradeFixture.INSTANCE_PRINCIPAL_ID)) {
            assertTrue(byId.containsKey(legacy.toString()),
                    "the legacy principal must remain visible through its binding: " + legacy);
            assertFalse(byId.get(legacy.toString()).has("scope"),
                    "list must not project the removed tier field");
        }
        assertEquals(auditBefore, count("SELECT count(*) FROM audit_logs"
                        + " WHERE action LIKE '%workspace_agent%'"),
                "a read path must not write a durable audit row");

        Response denied = send(outsider.token(), null, "GET", "/api/v1/agent-principals?workspaceId="
                + AgentPrincipalScopeUpgradeFixture.WORKSPACE_ID, null);
        assertEquals(403, denied.status(), denied.body().toString());
        assertEquals("WORKSPACE_ACCESS_DENIED", denied.body().path("code").asText());
        for (UUID legacy : List.of(AgentPrincipalScopeUpgradeFixture.PERSONAL_PRINCIPAL_ID,
                AgentPrincipalScopeUpgradeFixture.WORKSPACE_PRINCIPAL_ID,
                AgentPrincipalScopeUpgradeFixture.INSTANCE_PRINCIPAL_ID)) {
            assertFalse(denied.body().toString().contains(legacy.toString()),
                    "a denied list must not leak wsA principal rows: " + legacy);
        }
        assertEquals(auditBefore, count("SELECT count(*) FROM audit_logs"
                        + " WHERE action LIKE '%workspace_agent%'"),
                "a denied read path must not write a durable audit row either");
    }

    @Test
    void roleBindingTakesEffectAndForbiddenRoleIsRefused() throws Exception {
        String principalId = AgentPrincipalScopeUpgradeFixture.WORKSPACE_PRINCIPAL_ID.toString();
        int bindingsBefore = count("SELECT count(*) FROM role_bindings WHERE subject_type ="
                + " 'agent_principal' AND subject_id = CAST(? AS UUID)", principalId);

        Response bound = send(owner.token(), AgentPrincipalScopeUpgradeFixture.WORKSPACE_ID.toString(),
                "POST", "/api/v1/agent-principals/" + principalId + "/roles",
                Map.of("roleId", SystemAccessRoleCatalog.WS_EDITOR_ID.toString()));
        assertEquals(201, bound.status(), bound.body().toString());
        assertEquals("workspace", bound.body().path("scopeType").asText());
        assertEquals(AgentPrincipalScopeUpgradeFixture.WORKSPACE_ID.toString(),
                bound.body().path("scopeId").asText());
        assertFalse(bound.body().has("scope"), bound.body().toString());
        assertEquals(bindingsBefore + 1, count("SELECT count(*) FROM role_bindings"
                + " WHERE subject_type = 'agent_principal' AND subject_id = CAST(? AS UUID)", principalId));
        assertTrue(count("SELECT count(*) FROM grants WHERE subject_type = 'agent_principal'"
                + " AND subject_id = CAST(? AS UUID) AND scope_type = 'workspace'"
                + " AND scope_id = CAST(? AS UUID)", principalId,
                AgentPrincipalScopeUpgradeFixture.WORKSPACE_ID.toString()) >= 2,
                "the newly bound workspace role materializes its workspace grants");
        assertEquals(1, count("SELECT count(*) FROM audit_logs WHERE action ="
                + " 'agent_principal_role_bind' AND resource_type = 'role_binding' AND resource_id::text = ?",
                bound.body().path("bindingId").asText()));

        int afterAllow = count("SELECT count(*) FROM role_bindings WHERE subject_type ="
                + " 'agent_principal' AND subject_id = CAST(? AS UUID)", principalId);
        Response forbidden = send(owner.token(), AgentPrincipalScopeUpgradeFixture.WORKSPACE_ID.toString(),
                "POST", "/api/v1/agent-principals/" + principalId + "/roles",
                Map.of("roleId", SystemAccessRoleCatalog.ADMIN_ID.toString()));
        assertEquals(409, forbidden.status(), forbidden.body().toString());
        assertEquals("AGENT_PRINCIPAL_FORBIDDEN_ATOMS", forbidden.body().path("code").asText());
        assertEquals(afterAllow, count("SELECT count(*) FROM role_bindings WHERE subject_type ="
                + " 'agent_principal' AND subject_id = CAST(? AS UUID)", principalId),
                "a forbidden role must leave zero new rows");
    }

    @Test
    void globalDisableAndPatchAreOwnerScopedAndAudited() throws Exception {
        UUID personal = AgentPrincipalScopeUpgradeFixture.PERSONAL_PRINCIPAL_ID;
        Actor outsider = register("v19notowner");
        workspaceFixture.createOwnedWorkspace("v19 outsider workspace", outsider.userId());
        String legacyToken = TestDataFactory.createGlobalToken(
                AgentPrincipalScopeUpgradeFixture.LEGACY_USER_ID.toString(),
                "v19-legacy-" + AgentPrincipalScopeUpgradeFixture.LEGACY_USER_ID + "@test.local",
                "USER", 0);

        Response patched = send(legacyToken, null, "PATCH", "/api/v1/agent-principals/" + personal,
                Map.of("contextPolicy", plain(POLICY_JSON)));
        assertEquals(200, patched.status(), patched.body().toString());
        assertFalse(patched.body().has("scope"), "the removed tier field must not reappear: "
                + patched.body());
        assertEquals("true", string("SELECT context_policy->'memory'->>'enabled'"
                + " FROM agent_principals WHERE id = CAST(? AS UUID)", personal.toString()));

        Response disabled = send(legacyToken, null, "POST", "/api/v1/agent-principals/"
                + personal + "/disable", null);
        assertEquals(204, disabled.status(), disabled.body().toString());
        Response repeated = send(legacyToken, null, "POST", "/api/v1/agent-principals/"
                + personal + "/disable", null);
        assertEquals(204, repeated.status(), "disable is idempotent");
        assertEquals("true", string("SELECT (disabled_at IS NOT NULL)::text FROM agent_principals"
                + " WHERE id = CAST(? AS UUID)", personal.toString()));
        assertEquals(1, count("SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_disabled'"
                + " AND resource_id::text = ?", personal.toString()),
                "the second idempotent disable must not add another audit row");
        assertEquals(1, count("SELECT count(*) FROM audit_logs WHERE action ="
                + " 'agent_principal_context_policy_updated' AND resource_id::text = ?",
                personal.toString()));

        Response denyDisable = send(outsider.token(), null, "POST", "/api/v1/agent-principals/"
                + personal + "/disable", null);
        assertEquals(403, denyDisable.status(), denyDisable.body().toString());
        assertEquals("AGENT_PRINCIPAL_OWNER_MISMATCH", denyDisable.body().path("code").asText());
        Response denyPatch = send(outsider.token(), null, "PATCH", "/api/v1/agent-principals/"
                + personal, Map.of("contextPolicy", plain("{\"memory\":{\"enabled\":false}}")));
        assertEquals(403, denyPatch.status(), denyPatch.body().toString());
        assertEquals("AGENT_PRINCIPAL_OWNER_MISMATCH", denyPatch.body().path("code").asText());
        assertEquals("true", string("SELECT context_policy->'memory'->>'enabled'"
                + " FROM agent_principals WHERE id = CAST(? AS UUID)", personal.toString()),
                "the denied patch must not change the stored policy");
    }

    @Test
    void sessionImpersonationPassesGateOnlyForAuthorizedActor() throws Exception {
        UUID sessionId = createSession();
        Response addedAgent = send(owner.token(), AgentPrincipalScopeUpgradeFixture.WORKSPACE_ID.toString(),
                "POST", "/api/v1/sessions/" + sessionId + "/participants",
                Map.of("principalKind", "AGENT",
                        "principalId", AgentPrincipalScopeUpgradeFixture.WORKSPACE_PRINCIPAL_ID.toString(),
                        "role", "MEMBER"));
        assertEquals(201, addedAgent.status(), addedAgent.body().toString());
        String participantId = addedAgent.body().path("participantId").asText();
        assertFalse(addedAgent.body().has("scope"), addedAgent.body().toString());

        Actor outsider = register("v19sessionoutsider");
        workspaceFixture.bindWorkspaceRole(AgentPrincipalScopeUpgradeFixture.WORKSPACE_ID,
                UUID.fromString(outsider.userId()), WorkspaceRole.EDITOR);
        Response addedHuman = send(owner.token(), AgentPrincipalScopeUpgradeFixture.WORKSPACE_ID.toString(),
                "POST", "/api/v1/sessions/" + sessionId + "/participants",
                Map.of("principalKind", "HUMAN", "principalId", outsider.userId(), "role", "MEMBER"));
        assertEquals(201, addedHuman.status(), addedHuman.body().toString());

        Response allowed = chat(sessionId, participantId);
        assertNotEquals(403, allowed.status(), allowed.body().toString());
        assertEquals(409, allowed.status(), allowed.body().toString());
        assertEquals("SSE_SUBSCRIPTION_REQUIRED", allowed.body().path("code").asText());
        assertFalse(allowed.body().has("scope"), allowed.body().toString());

        Response denied = chatAs(outsider, sessionId, participantId);
        assertEquals(403, denied.status(), denied.body().toString());
        assertEquals("PARTICIPANT_CAP_DENIED", denied.body().path("code").asText());
        assertFalse(denied.body().has("scope"), denied.body().toString());
        assertEquals(0, count("SELECT count(*) FROM chat_runs WHERE session_id = CAST(? AS UUID)",
                sessionId.toString()), "both the allowed-but-SSE-gated and denied paths must not persist a run");
    }

    @Test
    void crossWorkspaceAccessRequiresThatWorkspacesOwnAuthority() throws Exception {
        UUID otherWorkspace = workspaceFixture.createOwnedWorkspace("v19 second workspace",
                owner.userId()).getId();
        String principalId = AgentPrincipalScopeUpgradeFixture.WORKSPACE_PRINCIPAL_ID.toString();
        int before = count("SELECT count(*) FROM workspace_agents WHERE principal_id = CAST(? AS UUID)"
                + " AND workspace_id = CAST(? AS UUID)", principalId, otherWorkspace.toString());
        int auditsBefore = count("SELECT count(*) FROM audit_logs WHERE action IN"
                + " ('workspace_agent_bound', 'workspace_agent_cap_updated')"
                + " AND resource_id::text = ?", principalId);

        Response denied = send(owner.token(), otherWorkspace.toString(), "PUT",
                "/api/v1/workspaces/" + otherWorkspace + "/agents/" + principalId,
                Map.of("permissions", List.of(Map.of("actionClass", "read", "resource", "*"))));
        assertEquals(403, denied.status(), denied.body().toString());
        assertEquals("AGENT_PERMISSION_SCOPE_EXCEEDED", denied.body().path("code").asText(),
                "A's authority cannot be written into B");
        assertEquals(before, count("SELECT count(*) FROM workspace_agents WHERE principal_id ="
                + " CAST(? AS UUID) AND workspace_id = CAST(? AS UUID)", principalId,
                otherWorkspace.toString()), "the denied cross-workspace write leaves zero rows");
        assertEquals(auditsBefore, count("SELECT count(*) FROM audit_logs WHERE action IN"
                        + " ('workspace_agent_bound', 'workspace_agent_cap_updated')"
                        + " AND resource_id::text = ?", principalId),
                "the denied cross-workspace write leaves no durable audit row");

        Response allowed = send(owner.token(), otherWorkspace.toString(), "PUT",
                "/api/v1/workspaces/" + otherWorkspace + "/agents/" + principalId,
                Map.of("permissions", List.of()));
        assertEquals(200, allowed.status(), allowed.body().toString());
        assertFalse(allowed.body().has("scope"), allowed.body().toString());
        assertEquals(before + 1, count("SELECT count(*) FROM workspace_agents WHERE principal_id ="
                + " CAST(? AS UUID) AND workspace_id = CAST(? AS UUID)", principalId,
                otherWorkspace.toString()));
        assertEquals(auditsBefore + 1, count("SELECT count(*) FROM audit_logs WHERE action IN"
                        + " ('workspace_agent_bound', 'workspace_agent_cap_updated')"
                        + " AND resource_id::text = ?", principalId),
                "the allowed cross-workspace bind writes exactly one durable audit row");
    }

    @Test
    void agentCapCannotGrantForbiddenOrUnheldAtoms() throws Exception {
        UUID workspace = AgentPrincipalScopeUpgradeFixture.WORKSPACE_ID;
        Response created = send(owner.token(), workspace.toString(), "POST",
                "/api/v1/agent-principals", Map.of("name", "v19capagent"));
        assertEquals(201, created.status(), created.body().toString());
        UUID principalId = UUID.fromString(created.body().path("principalId").asText());

        // The workspace cap is the ceiling a role binding must fit inside, so the first cap write
        // establishes both the binding row and the structural default workspace role.
        Response allowed = send(owner.token(), workspace.toString(), "PUT",
                "/api/v1/workspaces/" + workspace + "/agents/" + principalId,
                Map.of("permissions", List.of(Map.of("actionClass", "read", "resource", "*"))));
        assertEquals(200, allowed.status(), allowed.body().toString());
        assertFalse(allowed.body().has("scope"), allowed.body().toString());
        assertEquals("read", string("SELECT permissions_snapshot->0->>'actionClass'"
                + " FROM workspace_agents WHERE principal_id = CAST(? AS UUID)"
                + " AND workspace_id = CAST(? AS UUID)", principalId.toString(), workspace.toString()));

        int auditsBefore = count("SELECT count(*) FROM audit_logs WHERE action IN"
                + " ('workspace_agent_bound', 'workspace_agent_cap_updated')"
                + " AND resource_id::text = ?", principalId.toString());
        Response denied = send(owner.token(), workspace.toString(), "PUT",
                "/api/v1/workspaces/" + workspace + "/agents/" + principalId,
                Map.of("permissions", List.of(Map.of("actionClass", "MANAGE_AGENT_PRINCIPALS",
                        "resource", "*"))));
        assertEquals(403, denied.status(), denied.body().toString());
        assertEquals("AGENT_PERMISSION_SCOPE_EXCEEDED", denied.body().path("code").asText());
        assertEquals("read", string("SELECT permissions_snapshot->0->>'actionClass'"
                + " FROM workspace_agents WHERE principal_id = CAST(? AS UUID)"
                + " AND workspace_id = CAST(? AS UUID)", principalId.toString(), workspace.toString()),
                "the denied cap must not overwrite the stored snapshot");
        assertEquals(auditsBefore, count("SELECT count(*) FROM audit_logs WHERE action IN"
                + " ('workspace_agent_bound', 'workspace_agent_cap_updated')"
                + " AND resource_id::text = ?", principalId.toString()),
                "a denied cap leaves no durable audit row");
    }

    // ------------------------------------------------------------------ helpers

    private UUID createSession() {
        Session session = new Session();
        session.setId(UUID.randomUUID());
        session.setWorkspaceId(AgentPrincipalScopeUpgradeFixture.WORKSPACE_ID.toString());
        session.setUserId(owner.userId());
        session.setTitle("v19 scope upgrade session");
        session.setAgentPrincipalId(AgentPrincipalScopeUpgradeFixture.WORKSPACE_PRINCIPAL_ID.toString());
        return sessionRepository.saveAndFlush(session).getId();
    }

    private Response chat(UUID sessionId, String participantId) throws Exception {
        return chatAs(owner, sessionId, participantId);
    }

    private Response chatAs(Actor actor, UUID sessionId, String participantId) throws Exception {
        return send(actor.token(), AgentPrincipalScopeUpgradeFixture.WORKSPACE_ID.toString(), "POST", "/api/v1/chat",
                Map.of("sessionId", sessionId.toString(), "branchId", UUID.randomUUID().toString(),
                        "content", "v19", "asParticipantId", participantId));
    }

    private Actor register(String label) throws Exception {
        String email = label + "-" + UUID.randomUUID() + "@test.local";
        Response response = send(null, null, "POST", "/api/v1/auth/register",
                Map.of("email", email, "password", PASSWORD, "name", label));
        assertEquals(201, response.status(), response.body().toString());
        assertNotNull(response.body().path("accessToken").asText());
        return new Actor(response.body().path("user").path("id").asText(),
                response.body().path("accessToken").asText());
    }

    private Response send(String token, String workspaceId, String method, String path, Object body)
            throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(30));
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        if (workspaceId != null) {
            builder.header("X-Workspace-Id", workspaceId);
        }
        builder.header("Content-Type", "application/json");
        if (body == null) {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            builder.method(method, HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)));
        }
        HttpResponse<String> response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        JsonNode json = response.body() == null || response.body().isBlank()
                ? objectMapper.createObjectNode() : objectMapper.readTree(response.body());
        return new Response(response.statusCode(), json);
    }

    private JsonNode plain(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (Exception failure) {
            throw new IllegalStateException("fixture json is invalid", failure);
        }
    }

    private int count(String sql, Object... args) {
        Integer value = jdbc.queryForObject(sql, Integer.class, args);
        return value == null ? 0 : value;
    }

    private String string(String sql, Object... args) {
        List<String> values = jdbc.queryForList(sql, String.class, args);
        return values.isEmpty() ? null : values.get(0);
    }

    private record Actor(String userId, String token) {
    }

    private record Response(int status, JsonNode body) {
    }
}