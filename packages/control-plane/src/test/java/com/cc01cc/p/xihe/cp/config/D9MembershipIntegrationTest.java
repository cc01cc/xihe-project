package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * PLAN-0581 D9 / verify V11: {@code GET /internal/v1/config/effective/{domain}}
 * must refuse a {@code (userId, workspaceId)} pair that is not a membership.
 *
 * <p>Before this fix the endpoint was authenticated as a service
 * ({@code ROLE_INTERNAL_SERVICE}) but never checked that the user belongs to the
 * workspace, so an internal caller could read any user's layer by pairing that
 * id with any workspace (reproduced as "ws + foreign userId → 200" in PLAN-0590).
 *
 * <p>The five cases below are the frozen boundary (contract §8): the pair is
 * checked only when <b>both</b> parameters are present, the failure is the
 * existing {@code 403 WORKSPACE_FORBIDDEN} code, and the domain validation still
 * answers first.
 */
class D9MembershipIntegrationTest extends AbstractReusableIntegrationTest {

    @org.springframework.beans.factory.annotation.Autowired
    private WorkspaceFixture workspaceFixture;
    @Autowired private com.cc01cc.p.xihe.cp.service.WorkspaceService workspaceService;

    private static final String INTERNAL_TOKEN = "dev-token-not-secure";
    private static final String USER_PASSWORD = "d9-membership-pass-1";

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper objectMapper;

    private String adminToken;
    private String memberId;
    private String workspaceId;
    private String outsiderId;

    @BeforeEach
    void prepareWorkspace() throws Exception {
        ResponseEntity<String> admin = restTemplate.postForEntity(url("/api/v1/auth/register"),
                Map.of("email", "d9-admin-" + UUID.randomUUID() + "@test.com",
                        "password", USER_PASSWORD, "name", "D9 Admin"), String.class);
        assertEquals(HttpStatus.CREATED, admin.getStatusCode(), admin.getBody());
        adminToken = objectMapper.readTree(admin.getBody()).path("accessToken").asText();
        String adminId = objectMapper.readTree(admin.getBody()).path("user").path("id").asText();
        // PLAN-0610 W4b: an instance administrator is the ADMIN role binding (users.role is gone).
        jdbc.update("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type)"
                + " SELECT gen_random_uuid(), id, 'user', CAST(? AS UUID), 'instance'"
                + " FROM roles WHERE name = 'ADMIN'"
                + " ON CONFLICT ON CONSTRAINT uq_role_bindings DO NOTHING", adminId);
        jdbc.update("UPDATE instance_owner SET owner_user_id = CAST(? AS UUID), assigned_at = NOW()"
                + " WHERE id = 1", adminId);

        ResponseEntity<String> member = restTemplate.postForEntity(url("/api/v1/auth/register"),
                Map.of("email", "d9-member-" + UUID.randomUUID() + "@test.com",
                        "password", USER_PASSWORD, "name", "D9 Member"), String.class);
        assertEquals(HttpStatus.CREATED, member.getStatusCode(), member.getBody());
        memberId = objectMapper.readTree(member.getBody()).path("user").path("id").asText();
        // PLAN-0614: register no longer creates a workspace; the fixture creates the member's own.
        workspaceId = workspaceFixture
                .createOwnedWorkspace("D9 member workspace", UUID.fromString(memberId).toString())
                .getId().toString();

        ResponseEntity<String> outsider = restTemplate.postForEntity(url("/api/v1/auth/register"),
                Map.of("email", "d9-outsider-" + UUID.randomUUID() + "@test.com",
                        "password", USER_PASSWORD, "name", "D9 Outsider"), String.class);
        assertEquals(HttpStatus.CREATED, outsider.getStatusCode(), outsider.getBody());
        outsiderId = objectMapper.readTree(outsider.getBody()).path("user").path("id").asText();
    }

    /** Case 1: a real member of the workspace still reads the effective config. */
    @Test
    void memberPairIsAllowed() {
        ResponseEntity<String> response = effective("logging", memberId, workspaceId);
        assertEquals(HttpStatus.OK, response.getStatusCode(), response.getBody());
    }

    /** Case 2 (the regression): a foreign user id paired with this workspace is 403. */
    @Test
    void foreignUserPairIsForbidden() throws Exception {
        ResponseEntity<String> response = effective("logging", outsiderId, workspaceId);
        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), response.getBody());
        assertEquals("WORKSPACE_FORBIDDEN", objectMapper.readTree(response.getBody()).path("code").asText());
    }

    /** Case 3: no userId — instance-layer reads have no membership notion. */
    @Test
    void withoutUserIdStaysAllowed() {
        assertEquals(HttpStatus.OK, effective("logging", null, workspaceId).getStatusCode());
    }

    /** Case 4: no workspaceId — the user layer is still readable. */
    @Test
    void withoutWorkspaceIdStaysAllowed() {
        assertEquals(HttpStatus.OK, effective("logging", outsiderId, null).getStatusCode());
    }

    /**
     * Case 5: an unknown domain is a 400 even for a forbidden pair — the domain
     * check runs before the (more expensive) membership query.
     */
    @Test
    void invalidDomainStillAnswers400First() throws Exception {
        ResponseEntity<String> response = effective("not-a-domain", outsiderId, workspaceId);
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode(), response.getBody());
        assertEquals("INVALID_DOMAIN", objectMapper.readTree(response.getBody()).path("code").asText());
    }

    private ResponseEntity<String> effective(String domain, String userId, String workspace) {
        StringBuilder path = new StringBuilder("/internal/v1/config/effective/").append(domain);
        String separator = "?";
        if (userId != null) {
            path.append(separator).append("userId=").append(userId);
            separator = "&";
        }
        if (workspace != null) {
            path.append(separator).append("workspaceId=").append(workspace);
        }
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(INTERNAL_TOKEN);
        return restTemplate.exchange(url(path.toString()), HttpMethod.GET,
                new HttpEntity<>(headers), String.class);
    }
}
