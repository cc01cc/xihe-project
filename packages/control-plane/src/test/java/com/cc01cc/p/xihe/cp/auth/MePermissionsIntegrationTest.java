package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * PLAN-0610 W3-2b acceptance: {@code /auth/me.capabilities}, {@code /me/permissions}, the retired
 * user-role endpoint and old tokens that still carry a {@code role} claim.
 */
class MePermissionsIntegrationTest extends AbstractReusableIntegrationTest {

    @org.springframework.beans.factory.annotation.Autowired
    private com.cc01cc.p.xihe.cp.integration.WorkspaceFixture workspaceFixture;

    @Autowired
    private JdbcTemplate jdbc;
    @Autowired
    private AuthzContext authzContext;
    @Autowired
    private ObjectMapper objectMapper;
    @Autowired
    private com.cc01cc.p.xihe.cp.service.WorkspaceService workspaceService;

    @Test
    void authMeExposesCapabilitiesAndNoRoleString() throws Exception {
        AuthResponse registered = register("w3b-cap@test.com");
        JsonNode me = getJson(registered.getAccessToken(), "/api/v1/auth/me");

        assertFalse(me.has("role"), "PLAN-0610 W3-2b: the role string is gone: " + me);
        JsonNode capabilities = me.path("capabilities");
        assertTrue(capabilities.isObject(), "capabilities must be an object: " + me);
        assertFalse(capabilities.path("isInstanceAdmin").asBoolean());
        assertFalse(capabilities.path("isInstanceSuper").asBoolean());
        assertTrue(capabilities.path("workspaceAdminOf").isArray());
    }

    @Test
    void mePermissionsReturnsOwnInstanceAtomsAndWorkspaceScopes() throws Exception {
        AuthResponse registered = register("w3b-perms@test.com");
        // PLAN-0614: registration no longer creates a workspace; the fixture creates the caller's own.
        workspaceFixture.createOwnedWorkspace("Me permissions workspace", registered.getUser().getId());
        JsonNode body = getJson(registered.getAccessToken(), "/api/v1/me/permissions");

        assertEquals(registered.getUser().getId(), body.path("userId").asText());
        assertTrue(body.path("instancePermissions").isArray());
        assertTrue(body.path("instancePermissions").size() > 0,
                "registration materializes the USER tier atoms: " + body);
        assertFalse(body.path("instanceCapabilities").toString().contains("instance:admin"));
        JsonNode workspaces = body.path("workspaces");
        assertTrue(workspaces.isArray() && workspaces.size() >= 1,
                "the caller's own workspace must be listed: " + body);
        JsonNode own = workspaces.get(0);
        assertFalse(own.path("workspaceId").asText().isBlank());
        // PLAN-0610 W3-3: the workspace creator is bound to WS_OWNER, which carries
        // workspace:admin, so the caller administers its own workspace while its instance
        // capabilities stay plain-USER (asserted above / below).
        assertTrue(own.path("workspaceAdmin").asBoolean(),
                "the creator owns its own workspace (WS_OWNER): " + own);
    }

    @Test
    void superAdminBindingShowsUpInCapabilitiesAndPermissions() throws Exception {
        AuthResponse registered = register("w3b-super@test.com");
        UUID userId = UUID.fromString(registered.getUser().getId());
        jdbc.update("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type)"
                + " SELECT gen_random_uuid(), id, 'user', CAST(? AS UUID), 'instance'"
                + " FROM roles WHERE name = 'SUPER_ADMIN'"
                + " ON CONFLICT ON CONSTRAINT uq_role_bindings DO NOTHING", userId);
        authzContext.invalidateAll();

        // PLAN-0614: registration no longer creates a workspace; the fixture creates one so the
        // "instance admin administers every workspace" projection has a workspace to report.
        workspaceFixture.createOwnedWorkspace("Me perms super workspace", registered.getUser().getId());
        JsonNode me = getJson(registered.getAccessToken(), "/api/v1/auth/me");
        assertTrue(me.path("capabilities").path("isInstanceAdmin").asBoolean());
        assertTrue(me.path("capabilities").path("isInstanceSuper").asBoolean());

        JsonNode permissions = getJson(registered.getAccessToken(), "/api/v1/me/permissions");
        String caps = permissions.path("instanceCapabilities").toString();
        assertTrue(caps.contains("instance:admin"), caps);
        assertTrue(caps.contains("instance:super"), caps);
        assertTrue(permissions.path("workspaces").get(0).path("workspaceAdmin").asBoolean(),
                "an instance admin administers every workspace (decision #15)");
    }

    @Test
    void patchUserRoleIsRetired() throws Exception {
        AuthResponse registered = register("w3b-retired@test.com");
        // HttpURLConnection (the default RestTemplate factory) cannot send PATCH; use the JDK client.
        java.net.http.HttpRequest request = java.net.http.HttpRequest.newBuilder(java.net.URI.create(
                        baseUrl + "/api/v1/users/" + registered.getUser().getId() + "/role"))
                .method("PATCH", java.net.http.HttpRequest.BodyPublishers.ofString("{\"role\":\"ADMIN\"}"))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + registered.getAccessToken())
                .build();
        java.net.http.HttpResponse<String> response = java.net.http.HttpClient.newHttpClient()
                .send(request, java.net.http.HttpResponse.BodyHandlers.ofString());

        assertEquals(404, response.statusCode(),
                "PATCH /users/{id}/role is retired (no route): " + response.body());
    }

    @Test
    void oldTokenWithRoleClaimStillAuthenticatesThroughCapabilities() throws Exception {
        AuthResponse registered = register("w3b-legacy@test.com");
        String legacyToken = legacyRoleClaimToken(registered.getUser().getId());

        ResponseEntity<String> response = restTemplate.exchange(baseUrl + "/api/v1/auth/me",
                HttpMethod.GET, new HttpEntity<>(bearer(legacyToken)), String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        JsonNode me = objectMapper.readTree(response.getBody());
        // The signed role claim must not be trusted: the capability projection says plain user.
        assertFalse(me.path("capabilities").path("isInstanceAdmin").asBoolean(),
                "a role claim in an old token must not grant capabilities: " + me);
        assertFalse(me.has("role"));
    }

    // ── task-415 (RBAC P1-1): the hit-source audit on the self-service face ────

    @Test
    void mePermissionsReportsTheHitSourceOfEveryAtom() throws Exception {
        AuthResponse registered = register("w3b-sources@test.com");
        UUID userId = UUID.fromString(registered.getUser().getId());
        workspaceFixture.createOwnedWorkspace("Me perms sources workspace", registered.getUser().getId());
        JsonNode body = getJson(registered.getAccessToken(), "/api/v1/me/permissions");

        JsonNode instanceAtoms = body.path("instancePermissions");
        assertTrue(instanceAtoms.size() > 0, "registration materializes the USER tier: " + body);
        boolean sawRoleSource = false;
        for (JsonNode atom : instanceAtoms) {
            JsonNode sources = atom.path("sources");
            assertTrue(sources.isArray() && sources.size() > 0,
                    "task-415: every listed atom names its hit source: " + atom);
            for (JsonNode source : sources) {
                assertFalse(source.path("source").asText().isBlank(), "the provenance is named: " + source);
                assertFalse(source.path("grantId").asText().isBlank(),
                        "the durable grant row is addressable for audit: " + source);
                assertEquals("instance", source.path("scopeType").asText());
                if ("role".equals(source.path("source").asText())) {
                    sawRoleSource = true;
                    assertFalse(source.path("roleName").asText().isBlank(),
                            "a role source names the bound role: " + source);
                }
            }
        }
        assertTrue(sawRoleSource,
                "the USER tier comes from a role binding, so at least one source is source=role");

        // Workspace tier: the same audit, scoped to the workspace the atom was granted in.
        JsonNode own = body.path("workspaces").get(0);
        String workspaceId = own.path("workspaceId").asText();
        assertTrue(own.path("permissions").size() > 0,
                "WS_OWNER carries workspace action atoms, not only the capability: " + own);
        for (JsonNode atom : own.path("permissions")) {
            assertTrue(atom.path("sources").size() > 0, "workspace atoms are audited too: " + atom);
            for (JsonNode source : atom.path("sources")) {
                assertEquals("workspace", source.path("scopeType").asText());
                assertEquals(workspaceId, source.path("scopeId").asText(),
                        "the source points at the workspace the grant belongs to");
            }
        }
    }

    @Test
    void mePermissionsGroupsOneAtomWithEveryContributingGrant() throws Exception {
        AuthResponse registered = register("w3b-grouped@test.com");
        UUID userId = UUID.fromString(registered.getUser().getId());
        JsonNode before = getJson(registered.getAccessToken(), "/api/v1/me/permissions");
        JsonNode first = before.path("instancePermissions").get(0);
        String actionClass = first.path("actionClass").asText();
        String resource = first.path("resource").asText();

        // A second, non-role grant of the SAME atom. The materializer only reconciles source='role'
        // rows, so this template row survives it — exactly the "two sources, one atom" case.
        String permissions = "[{\"actionClass\":\"" + actionClass + "\",\"resource\":\"" + resource + "\"}]";
        jdbc.update("INSERT INTO grants (id, subject_type, subject_id, permissions, source,"
                + " template_name, scope_type) VALUES (gen_random_uuid(), 'user', CAST(? AS UUID),"
                + " CAST(? AS JSONB), 'template', 'task-415-fixture', 'instance')", userId, permissions);
        try {
            authzContext.invalidateAll();
            JsonNode after = getJson(registered.getAccessToken(), "/api/v1/me/permissions");
            int matches = 0;
            JsonNode grouped = null;
            for (JsonNode atom : after.path("instancePermissions")) {
                if (actionClass.equals(atom.path("actionClass").asText())
                        && resource.equals(atom.path("resource").asText())) {
                    matches++;
                    grouped = atom;
                }
            }
            assertEquals(1, matches,
                    "the same atom from two grants is ONE entry (the per-row projection duplicated it)");
            assertEquals(2, grouped.path("sources").size(),
                    "both contributing grants are listed, not just the first: " + grouped);
            boolean role = false;
            boolean template = false;
            for (JsonNode source : grouped.path("sources")) {
                role |= "role".equals(source.path("source").asText());
                template |= "template".equals(source.path("source").asText());
            }
            assertTrue(role && template, "the audit distinguishes the two provenances: " + grouped);
        } finally {
            jdbc.update("DELETE FROM grants WHERE template_name = 'task-415-fixture'");
        }
    }

    /**
     * Mints a token with the pre-W3-2b shape (including a {@code role} claim) using the test
     * secret, i.e. exactly what an old client holds. The issuer no longer produces this shape.
     */
    private String legacyRoleClaimToken(String userId) {
        javax.crypto.SecretKey key = io.jsonwebtoken.security.Keys.hmacShaKeyFor(
                "test-jwt-secret-key-for-testing-purposes".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return io.jsonwebtoken.Jwts.builder()
                .subject(userId)
                .claim("email", "w3b-legacy@test.com")
                .claim("role", "ADMIN")
                .claim("tv", 0)
                .issuedAt(new java.util.Date())
                .expiration(new java.util.Date(System.currentTimeMillis() + 600_000))
                .signWith(key)
                .compact();
    }

    private HttpHeaders bearer(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private JsonNode getJson(String token, String path) throws Exception {
        ResponseEntity<String> response = restTemplate.exchange(baseUrl + path, HttpMethod.GET,
                new HttpEntity<>(bearer(token)), String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        return objectMapper.readTree(response.getBody());
    }

    private AuthResponse register(String email) {
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "W3b"),
                AuthResponse.class);
        assertTrue(response.getStatusCode().is2xxSuccessful(), String.valueOf(response.getBody()));
        return response.getBody();
    }
}
