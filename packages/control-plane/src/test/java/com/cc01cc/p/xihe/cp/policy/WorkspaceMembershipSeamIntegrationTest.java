package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
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
 *   <li><b>Creation</b> binds the creator to {@code WS_OWNER}, and the member API reports them as
 *       the owner.</li>
 *   <li><b>{@code PUT /api/v1/bindings}</b> is a real membership grant: the subject passes the
 *       tenant gate, appears in the member list and sees the workspace in its workspace list — the
 *       three readers that used to query {@code workspace_users} directly.</li>
 *   <li>A member removal through the API drops the binding, so every reader stops admitting the
 *       subject (V89 dropped the legacy table, so the binding is the only membership fact).</li>
 * </ol>
 */
class WorkspaceMembershipSeamIntegrationTest extends AbstractIntegrationTest {

    private static final String PASSWORD = "Seam-pass-1";

    @Autowired
    private JdbcTemplate jdbc;

    @org.springframework.beans.factory.annotation.Autowired
    private WorkspaceFixture workspaceFixture;

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
        assertEquals(RoleAtomExpectations.materializedAtomCount(SystemAccessRoleCatalog.WS_EDITOR),
                grantRows(memberId, workspaceId),
                "WS_EDITOR materializes one row per catalog action atom (0651 M2 widened 4→7)");
    }

    @Test
    void memberRemovalDropsTheBindingForEveryReader() throws Exception {
        String ownerToken = register("seam-removal-owner@test.com");
        String ownerId = userIdOf(ownerToken);
        String workspaceId = createWorkspace(ownerToken, "seam-removal");
        String memberId = userIdOf(register("seam-removal-member@test.com"));
        String memberToken = login("seam-removal-member@test.com");

        // A workspace-tier binding is the only way in (V89 dropped workspace_users).
        jdbc.update("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                        + " scope_id, granted_at) SELECT gen_random_uuid(), r.id, 'user',"
                        + " CAST(? AS UUID), 'workspace', CAST(? AS UUID), NOW()"
                        + " FROM roles r WHERE r.name = 'WS_EDITOR'", memberId, workspaceId);
        assertEquals(HttpStatus.OK,
                call(HttpMethod.GET, "/api/v1/workspaces/" + workspaceId, null, memberToken,
                        workspaceId).getStatusCode());
        assertEquals(List.of("WS_EDITOR"), workspaceTierRoles(memberId, workspaceId));

        // The owner removes the member: the binding and the derived access go with it.
        ResponseEntity<String> removed = call(HttpMethod.DELETE,
                "/api/v1/workspaces/" + workspaceId + "/members/" + memberId, null, ownerToken);
        assertEquals(HttpStatus.NO_CONTENT, removed.getStatusCode(), removed.getBody());
        assertTrue(workspaceTierRoles(memberId, workspaceId).isEmpty());
        assertEquals(HttpStatus.FORBIDDEN,
                call(HttpMethod.GET, "/api/v1/workspaces/" + workspaceId, null, memberToken,
                        workspaceId).getStatusCode());
        // The owner is untouched.
        assertEquals(List.of("WS_OWNER"), workspaceTierRoles(ownerId, workspaceId));
    }

    @Test
    void nonMemberDenialIsLoggedAsActionAtomDeniedWithSourceNone() throws Exception {
        // PLAN-0651 T1.5 (proposal B, B5): the member-face denial must produce the canonical
        // [POLICY] event=action_atom_denied line with the four closed fields, and a subject
        // denied here holds MANAGE_WORKSPACE_MEMBERS from no evaluation source (source=none).
        String ownerToken = register("seam-atom-owner@test.com");
        String workspaceId = createWorkspace(ownerToken, "seam-atom");
        String outsiderToken = register("seam-atom-outsider@test.com");
        String outsiderId = userIdOf(outsiderToken);

        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        ch.qos.logback.classic.Logger policyLogger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(RequesterAuthority.class);
        policyLogger.addAppender(appender);
        ResponseEntity<String> denied;
        try {
            // The headerless member route reaches the member service itself (the tenant gate
            // only guards the header path), so this 403 comes from the membership matrix.
            denied = call(HttpMethod.GET, "/api/v1/workspaces/" + workspaceId + "/members",
                    null, outsiderToken);
        } finally {
            policyLogger.detachAppender(appender);
        }
        assertEquals(HttpStatus.FORBIDDEN, denied.getStatusCode(), denied.getBody());

        ch.qos.logback.classic.spi.ILoggingEvent event = appender.list.stream()
                .filter(candidate -> candidate.getFormattedMessage()
                        .contains("event=action_atom_denied"))
                .filter(candidate -> candidate.getFormattedMessage()
                        .contains("subject=" + outsiderId))
                .findFirst().orElse(null);
        assertNotNull(event, "the member-face denial must log action_atom_denied: " + appender.list);
        assertEquals(ch.qos.logback.classic.Level.WARN, event.getLevel());
        java.util.Map<String, String> fields = new java.util.LinkedHashMap<>();
        for (String part : event.getFormattedMessage().split(" ")) {
            int eq = part.indexOf('=');
            if (eq > 0) {
                fields.put(part.substring(0, eq), part.substring(eq + 1));
            }
        }
        // Closed vocabulary (B4): exactly event + the four fields, no resource strings.
        assertEquals(5, fields.size(), event.getFormattedMessage());
        assertEquals("MANAGE_WORKSPACE_MEMBERS", fields.get("atom"));
        assertEquals(outsiderId, fields.get("subject"));
        assertEquals(workspaceId, fields.get("workspaceId"));
        assertEquals("none", fields.get("source"));
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
        // PLAN-0618: the public create route now needs an explicit direct_attach payload + Runtime probe;
        // these tests exercise the membership/binding seams, so the carrier row comes from the fixture.
        // (The pure "API creation binds the creator as OWNER" assertion moved, unchanged in meaning, to
        // WorkspaceCreationOwnerBindingWireMockTest in the WireMock lane — Lead 裁定 B.)
        return workspaceFixture.createOwnedWorkspace(prefix + "-" + UUID.randomUUID(), userIdOf(token))
                .getId().toString();
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
