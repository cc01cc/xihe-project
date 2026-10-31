package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
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

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0585 V1: the grant surface actually unlocks the two gates it exists for.
 *
 * <p>With nothing granted, {@code POST /api/v1/agent-principals} is 403 (BL-133). After the admin
 * grants {@code CREATE_ACCOUNT} the same call is 201; the Workspace binding still needs its own
 * {@code MANAGE_WORKSPACE_AGENTS} atom scoped to that workspace; revoking {@code CREATE_ACCOUNT}
 * returns the create path to 403. The default grants of the target are never rewritten.</p>
 */
class PrincipalGrantAuthorizationIntegrationTest extends AbstractIntegrationTest {

    private static final String CREATE_ACCOUNT = "CREATE_ACCOUNT";
    private static final String MANAGE_WORKSPACE_AGENTS = "MANAGE_WORKSPACE_AGENTS";

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private AgentPrincipalRepository principalRepository;
    @Autowired private WorkspaceAgentRepository bindingRepository;
    @Autowired private AuthorizationGrantRepository grantRepository;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private GrantDefaultService grantDefaultService;

    private UUID adminId;
    private UUID targetId;
    private UUID workspaceId;
    private String targetUsername;
    private String adminToken;
    private String targetToken;
    private String defaultGrantText;
    private RestTemplate patchClient;

    @BeforeEach
    void usePatchCapableClient() {
        // The shared RestTemplate's default factory (HttpURLConnection) rejects PATCH.
        patchClient = new RestTemplate(new JdkClientHttpRequestFactory());
        patchClient.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(ClientHttpResponse response) throws IOException {
                return response.getStatusCode().is5xxServerError();
            }
        });
    }

    @AfterEach
    void cleanFixtures() {
        if (targetId != null) {
            List<UUID> principals = jdbcTemplate.queryForList(
                    "SELECT id FROM agent_principals WHERE created_by_user_id = ?::uuid",
                    UUID.class, targetId.toString());
            jdbcTemplate.update("DELETE FROM audit_logs WHERE resource_type = 'agent_principal' "
                    + "AND CAST(resource_id AS VARCHAR) IN (SELECT id::text FROM agent_principals "
                    + "WHERE created_by_user_id = ?::uuid)", targetId.toString());
            for (UUID principalId : principals) {
                bindingRepository.deleteAll(bindingRepository.findByIdPrincipalId(principalId));
                grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                        "agent_principal", principalId));
                principalRepository.deleteById(principalId);
            }
        }
        if (workspaceId != null) {
            jdbcTemplate.update("DELETE FROM workspace_users WHERE workspace_id = ?::uuid",
                    workspaceId.toString());
            jdbcTemplate.update("DELETE FROM audit_logs WHERE CAST(workspace_id AS VARCHAR) = ?",
                    workspaceId.toString());
            workspaceRepository.deleteById(workspaceId);
        }
        for (UUID id : new UUID[] {targetId, adminId}) {
            if (id != null) {
                jdbcTemplate.update("DELETE FROM audit_logs WHERE resource_type = 'principal_grant' "
                        + "AND resource_id = ?", id.toString());
                grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", id));
                jdbcTemplate.update("DELETE FROM users WHERE id = ?::uuid", id.toString());
            }
        }
        adminId = null;
        targetId = null;
        workspaceId = null;
        targetUsername = null;
        adminToken = null;
        targetToken = null;
    }

    @Test
    void grantingUnlocksPrincipalCreationAndBindingAndRevokingClosesIt() {
        fixture();

        // Baseline (BL-133): a plain USER cannot create a principal.
        assertEquals(HttpStatus.FORBIDDEN, createPrincipal(targetToken).getStatusCode());

        ResponseEntity<Map> granted = patchGrant(Map.of("add",
                List.of(Map.of("actionClass", CREATE_ACCOUNT))));
        assertEquals(HttpStatus.OK, granted.getStatusCode(), String.valueOf(granted.getBody()));
        assertEquals(true, granted.getBody().get("changed"));

        ResponseEntity<Map> created = createPrincipal(targetToken);
        assertEquals(HttpStatus.CREATED, created.getStatusCode(), String.valueOf(created.getBody()));
        UUID principalId = UUID.fromString((String) created.getBody().get("principalId"));

        // The binding is a separate gate: CREATE_ACCOUNT alone must not bind.
        ResponseEntity<Map> unbindable = bindPrincipal(principalId);
        assertEquals(HttpStatus.FORBIDDEN, unbindable.getStatusCode(),
                String.valueOf(unbindable.getBody()));
        assertTrue(bindingRepository.findByIdPrincipalId(principalId).isEmpty());

        ResponseEntity<Map> manageGranted = patchGrant(Map.of("add",
                List.of(Map.of("actionClass", MANAGE_WORKSPACE_AGENTS,
                        "resource", workspaceId.toString()))));
        assertEquals(HttpStatus.OK, manageGranted.getStatusCode(),
                String.valueOf(manageGranted.getBody()));

        ResponseEntity<Map> bound = bindPrincipal(principalId);
        assertEquals(HttpStatus.OK, bound.getStatusCode(), String.valueOf(bound.getBody()));
        assertEquals(workspaceId.toString(), bound.getBody().get("workspaceId"));
        assertEquals(1, bindingRepository.findByIdPrincipalId(principalId).size());

        ResponseEntity<Map> revoked = patchGrant(Map.of("remove",
                List.of(Map.of("actionClass", CREATE_ACCOUNT))));
        assertEquals(HttpStatus.OK, revoked.getStatusCode(), String.valueOf(revoked.getBody()));
        assertEquals(true, revoked.getBody().get("changed"));
        assertEquals(HttpStatus.FORBIDDEN, createPrincipal(targetToken).getStatusCode());

        assertEquals(2, auditCount(targetId, "principal_grant_added"));
        assertEquals(1, auditCount(targetId, "principal_grant_removed"));
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE action = 'workspace_agent_bound' "
                        + "AND CAST(workspace_id AS VARCHAR) = ?", Integer.class,
                workspaceId.toString()));
        // The registration baseline (source='default') is never rewritten by this surface.
        assertEquals(defaultGrantText, defaultGrantText(targetId));
    }

    // --- helpers ---------------------------------------------------------------------------

    private void fixture() {
        User admin = new User("pg-auth-admin-" + UUID.randomUUID() + "@test.com", "hash",
                UserRole.ADMIN, "Grant admin", "pgauthadmin" + shortId());
        adminId = userRepository.saveAndFlush(admin).getId();

        User target = new User("pg-auth-target-" + UUID.randomUUID() + "@test.com", "hash",
                UserRole.USER, "Grant target", "pgauth" + shortId());
        target = userRepository.saveAndFlush(target);
        targetId = target.getId();
        targetUsername = target.getUsername();
        // Mirror registration (AuthService -> ensureUserDefault) so the baseline row exists.
        grantDefaultService.ensureUserDefault(target);
        defaultGrantText = defaultGrantText(targetId);

        Workspace workspace = workspaceRepository.saveAndFlush(
                new Workspace("Principal grant auth test", targetId.toString()));
        workspaceId = workspace.getId();
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(workspaceId.toString(),
                targetId.toString(), WorkspaceRole.OWNER));

        adminToken = TestDataFactory.createGlobalToken(adminId.toString(), admin.getEmail(), "ADMIN", 0);
        targetToken = TestDataFactory.createWorkspaceToken(targetId.toString(), target.getEmail(),
                "USER", workspaceId.toString(), 0);
    }

    private static String shortId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 8);
    }

    private ResponseEntity<Map> patchGrant(Object body) {
        HttpHeaders headers = auth(adminToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return patchClient.exchange(url("/api/v1/principal-grants/" + targetUsername),
                HttpMethod.PATCH, new HttpEntity<>(body, headers), Map.class);
    }

    private ResponseEntity<Map> createPrincipal(String token) {
        HttpHeaders headers = auth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(url("/api/v1/agent-principals"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Grant surface agent"), headers), Map.class);
    }

    private ResponseEntity<Map> bindPrincipal(UUID principalId) {
        HttpHeaders headers = auth(targetToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(url("/api/v1/workspaces/" + workspaceId + "/agents/" + principalId),
                HttpMethod.PUT, new HttpEntity<>(Map.of("permissions",
                        List.of(Map.of("actionClass", CREATE_ACCOUNT, "resource", "*"))), headers),
                Map.class);
    }

    private static HttpHeaders auth(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private String defaultGrantText(UUID userId) {
        return jdbcTemplate.queryForObject(
                "SELECT permissions::text FROM grants WHERE subject_type = 'user' "
                        + "AND subject_id = ?::uuid AND source = 'default'",
                String.class, userId.toString());
    }

    private int auditCount(UUID targetUserId, String action) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE resource_type = 'principal_grant' "
                        + "AND action = ? AND resource_id = ?",
                Integer.class, action, targetUserId.toString());
    }
}
