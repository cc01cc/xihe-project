package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.RestTemplate;

/**
 * PLAN-0610 W3-3: the workspace-membership seam against real PostgreSQL.
 *
 * <p>Three claims, each cross-surface (the point of round-4 P2-5 is that all readers agree):</p>
 *
 * <ol>
 *   <li><b>Creation</b> binds the creator to {@code WS_OWNER} (binding + transitional legacy row),
 *       and the member API reports them as the owner.</li>
 *   <li><b>{@code PUT /api/v1/bindings}</b> is a real membership grant: the subject passes the
 *       tenant gate, appears in the member list and sees the workspace in its workspace list — the
 *       three readers that used to query {@code workspace_users} directly.</li>
 *   <li>The <b>legacy fallback</b> still counts a pre-W3-3 {@code workspace_users} row as
 *       membership, and a member removal through the API clears both facts.</li>
 * </ol>
 */
class WorkspaceMembershipSeamIntegrationTest extends AbstractIntegrationTest {

    private static final String PASSWORD = "Seam-pass-1";

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @Autowired
    private AuthzContext authzContext;

    private RestTemplate api() {
        RestTemplate api = new RestTemplate(new JdkClientHttpRequestFactory());
        api.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.HttpStatusCode statusCode) {
                return statusCode.is5xxServerError();
            }
        });
        return api;
    }

    @Test
    void workspaceCreationBindsTheCreatorAsOwner() throws Exception {
        String token = register("seam-creator@test.com");
        String userId = userIdOf(token);
        String workspaceId = createWorkspace(token, "seam-created");

        assertEquals(List.of("WS_OWNER"), workspaceTierRoles(userId, workspaceId),
                "the creator holds exactly one workspace-tier binding");
        assertEquals("OWNER", jdbc.queryForObject("SELECT role FROM workspace_users"
                        + " WHERE workspace_id = CAST(? AS UUID) AND user_id = CAST(? AS UUID)",
                String.class, workspaceId, userId),
                "the legacy row is mirrored while the table exists (dropped by V89)");

        ResponseEntity<String> members = call(HttpMethod.GET,
                "/api/v1/workspaces/" + workspaceId + "/members", null, token);
        assertEquals(HttpStatus.OK, members.getStatusCode(), members.getBody());
        JsonNode list = objectMapper.readTree(members.getBody());
        assertEquals(1, list.size(), "the creator is the only member");
        assertEquals(userId, list.get(0).path("userId").asText());
        assertEquals("OWNER", list.get(0).path("role").asText());
    }

    @Test
    void bindingApiGrantsMembershipForEveryReader() throws Exception {
        String ownerToken = register("seam-owner@test.com");
        String workspaceId = createWorkspace(ownerToken, "seam-binding");
        String superToken = superAdmin("seam-binding-admin@test.com");
        String memberId = userIdOf(register("seam-member@test.com"));
        String memberToken = login("seam-member@test.com");

        // Tenant gate: not a member yet.
        assertEquals(HttpStatus.FORBIDDEN,
                call(HttpMethod.GET, "/api/v1/workspaces/" + workspaceId, null, memberToken,
                        workspaceId).getStatusCode());

        List<Map<String, String>> desired = new java.util.ArrayList<>(
                workspaceBindings(superToken, workspaceId));
        desired.add(Map.of("subjectId", memberId, "roleId", roleId("WS_EDITOR")));
        ResponseEntity<String> granted = call(HttpMethod.PUT,
                "/api/v1/bindings?scope=workspace&scopeId=" + workspaceId,
                Map.of("bindings", desired), superToken);
        assertEquals(HttpStatus.OK, granted.getStatusCode(), granted.getBody());

        // Reader 1: the tenant gate (AccessScopeResolver + X-Workspace-Id) now accepts the subject.
        assertEquals(HttpStatus.OK,
                call(HttpMethod.GET, "/api/v1/workspaces/" + workspaceId, null, memberToken,
                        workspaceId).getStatusCode());
        // Reader 2: the member list (WorkspaceMemberService over the seam).
        ResponseEntity<String> members = call(HttpMethod.GET,
                "/api/v1/workspaces/" + workspaceId + "/members", null, memberToken, workspaceId);
        assertEquals(HttpStatus.OK, members.getStatusCode(), members.getBody());
        assertTrue(objectMapper.readTree(members.getBody()).findValuesAsText("userId")
                        .contains(memberId),
                "the granted subject appears in the member list");
        // Reader 3: the workspace list (WorkspaceRepository.findActiveByMemberBinding).
        ResponseEntity<String> workspaces = call(HttpMethod.GET, "/api/v1/workspaces", null,
                memberToken);
        assertEquals(HttpStatus.OK, workspaces.getStatusCode(), workspaces.getBody());
        assertTrue(objectMapper.readTree(workspaces.getBody()).findValuesAsText("id")
                        .contains(workspaceId),
                "the workspace appears in the subject's workspace list");
        assertEquals(4, grantRows(memberId, workspaceId),
                "WS_EDITOR materializes its four workspace-tier atoms (read/write/delete/exec)");
    }

    @Test
    void legacyRowStillCountsAndMemberRemovalClearsBothFacts() throws Exception {
        String ownerToken = register("seam-legacy-owner@test.com");
        String ownerId = userIdOf(ownerToken);
        String workspaceId = createWorkspace(ownerToken, "seam-legacy");
        String memberId = userIdOf(register("seam-legacy-member@test.com"));
        String memberToken = login("seam-legacy-member@test.com");

        // A pre-W3-3 fixture row only (no binding): the fallback must still report membership.
        jdbc.update("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES"
                        + " (CAST(? AS UUID), CAST(? AS UUID), 'MEMBER')",
                workspaceId, memberId);
        assertEquals(HttpStatus.OK,
                call(HttpMethod.GET, "/api/v1/workspaces/" + workspaceId, null, memberToken,
                        workspaceId).getStatusCode());
        assertTrue(workspaceTierRoles(memberId, workspaceId).isEmpty(),
                "the fixture wrote no binding — the fallback is what admitted the subject");

        // The owner removes the member: both the binding path and the legacy row are cleared.
        ResponseEntity<String> removed = call(HttpMethod.DELETE,
                "/api/v1/workspaces/" + workspaceId + "/members/" + memberId, null, ownerToken);
        assertEquals(HttpStatus.NO_CONTENT, removed.getStatusCode(), removed.getBody());
        assertEquals(0, countRows("SELECT COUNT(*) FROM workspace_users WHERE workspace_id ="
                + " CAST(? AS UUID) AND user_id = CAST(? AS UUID)", workspaceId, memberId));
        assertTrue(workspaceTierRoles(memberId, workspaceId).isEmpty());
        assertEquals(HttpStatus.FORBIDDEN,
                call(HttpMethod.GET, "/api/v1/workspaces/" + workspaceId, null, memberToken,
                        workspaceId).getStatusCode());
        // The owner is untouched.
        assertEquals(List.of("WS_OWNER"), workspaceTierRoles(ownerId, workspaceId));
    }

    // ── fixtures / helpers ──────────────────────────────────────────────────

    private String superAdmin(String email) throws Exception {
        register(email);
        String userId = userIdOf(login(email));
        jdbc.update("DELETE FROM role_bindings WHERE subject_type = 'user'"
                + " AND subject_id = CAST(? AS UUID) AND scope_type = 'instance'", userId);
        jdbc.update("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                        + " granted_at) SELECT CAST(? AS UUID), r.id, 'user', CAST(? AS UUID),"
                        + " 'instance', NOW() FROM roles r WHERE r.name = 'SUPER_ADMIN'",
                UUID.randomUUID().toString(), userId);
        materializeInstance(userId);
        return login(email);
    }

    private void materializeInstance(String userId) {
        // The mirror of RoleGrantMaterializer: instance-scope atoms only (capability atoms stay out).
        // The resource must be carried when it is not the wildcard — a credential atom with a bare
        // '*' fails the evaluator closed, which would make every atom lookup empty.
        jdbc.update("DELETE FROM grants WHERE subject_type = 'user' AND subject_id = CAST(? AS UUID)"
                + " AND source = 'role' AND scope_type = 'instance'", userId);
        jdbc.update("INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id,"
                        + " permissions, source, scope_type, read_state)"
                        + " SELECT gen_random_uuid(), 'user', CAST(? AS UUID), 'user',"
                        + " CAST(? AS UUID), jsonb_build_array(jsonb_build_object('actionClass',"
                        + " rp.action_class) || CASE WHEN rp.resource_pattern = '*' THEN '{}'::jsonb"
                        + " ELSE jsonb_build_object('resource', rp.resource_pattern) END),"
                        + " 'role', 'instance', 'read'"
                        + " FROM role_bindings b JOIN role_permissions rp ON rp.role_id = b.role_id"
                        + " WHERE b.subject_type = 'user' AND b.subject_id = CAST(? AS UUID)"
                        + " AND b.scope_type = 'instance' AND rp.action_class NOT LIKE '%:%'",
                userId, userId, userId);
        authzContext.invalidate(UUID.fromString(userId));
    }

    private String createWorkspace(String token, String prefix) throws Exception {
        ResponseEntity<String> created = call(HttpMethod.POST, "/api/v1/workspaces",
                Map.of("name", prefix + "-" + UUID.randomUUID()), token);
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), created.getBody());
        return objectMapper.readTree(created.getBody()).path("id").asText();
    }

    private List<Map<String, String>> workspaceBindings(String token, String workspaceId)
            throws Exception {
        ResponseEntity<String> listed = call(HttpMethod.GET,
                "/api/v1/bindings?scope=workspace&scopeId=" + workspaceId, null, token);
        assertEquals(HttpStatus.OK, listed.getStatusCode(), listed.getBody());
        List<Map<String, String>> pairs = new java.util.ArrayList<>();
        for (JsonNode binding : objectMapper.readTree(listed.getBody()).path("bindings")) {
            pairs.add(Map.of("subjectId", binding.path("subjectId").asText(),
                    "roleId", binding.path("roleId").asText()));
        }
        return pairs;
    }

    private ResponseEntity<String> call(HttpMethod method, String path, Object body, String token) {
        return call(method, path, body, token, null);
    }

    private ResponseEntity<String> call(HttpMethod method, String path, Object body, String token,
                                        String workspaceHeader) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        if (workspaceHeader != null) {
            headers.set("X-Workspace-Id", workspaceHeader);
        }
        return api().exchange(url(path), method, new HttpEntity<>(body, headers), String.class);
    }

    private String register(String email) throws Exception {
        ResponseEntity<String> response = api().postForEntity(url("/api/v1/auth/register"),
                Map.of("email", email, "password", PASSWORD, "name", "Seam"), String.class);
        assertEquals(HttpStatus.CREATED, response.getStatusCode(), response.getBody());
        return objectMapper.readTree(response.getBody()).path("accessToken").asText();
    }

    private String login(String email) throws Exception {
        ResponseEntity<String> response = api().postForEntity(url("/api/v1/auth/login"),
                Map.of("identifier", email, "password", PASSWORD), String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
        return objectMapper.readTree(response.getBody()).path("accessToken").asText();
    }

    private String userIdOf(String token) {
        return jwtTokenProvider.getUserIdFromToken(token);
    }

    private String roleId(String name) {
        return jdbc.queryForObject("SELECT CAST(id AS VARCHAR) FROM roles WHERE name = ?",
                String.class, name);
    }

    private List<String> workspaceTierRoles(String userId, String workspaceId) {
        return jdbc.queryForList("SELECT r.name FROM role_bindings b JOIN roles r ON r.id = b.role_id"
                        + " WHERE b.subject_type = 'user' AND b.subject_id = CAST(? AS UUID)"
                        + " AND b.scope_type = 'workspace' AND b.scope_id = CAST(? AS UUID)"
                        + " AND r.name LIKE 'WS_%' ORDER BY r.name",
                String.class, userId, workspaceId);
    }

    private int grantRows(String userId, String workspaceId) {
        return countRows("SELECT COUNT(*) FROM grants WHERE subject_type = 'user'"
                + " AND subject_id = CAST(? AS UUID) AND source = 'role'"
                + " AND scope_type = 'workspace' AND scope_id = CAST(? AS UUID)",
                userId, workspaceId);
    }

    private int countRows(String sql, Object... args) {
        Integer count = jdbc.queryForObject(sql, Integer.class, args);
        assertNotNull(count);
        return count;
    }
}
