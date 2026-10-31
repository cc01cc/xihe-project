package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
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
 * PLAN-0610 W2 / decision #28: the PLAN-0585 {@code /api/v1/principal-grants/*} surface is
 * retired at the service layer with {@code 410 PRINCIPAL_GRANTS_RETIRED}.
 *
 * <p>Why retirement instead of a source rename: V88 narrows {@code ck_grants_source} to the five
 * post-migration values, so the legacy {@code source='direct'} write can never succeed again; a
 * still-live writer would answer 500 on the next PATCH. The surface is replaced by access-role
 * bindings (W3); the controller routes are deleted in W3 and the UI page in W5.</p>
 */
class PrincipalGrantAdminControllerContractTest extends AbstractIntegrationTest {

    /** The shared RestTemplate uses HttpURLConnection: no PATCH and it drops non-2xx bodies. */
    private RestTemplate patchClient;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private UUID adminId;
    private String adminUsername;
    private String adminToken;
    private String targetUsername;
    private String targetToken;

    @BeforeEach
    void usePatchCapableClient() {
        patchClient = new RestTemplate(new JdkClientHttpRequestFactory());
        patchClient.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(ClientHttpResponse response) throws IOException {
                return response.getStatusCode().is5xxServerError();
            }
        });
    }

    private void fixture() {
        User admin = userRepository.saveAndFlush(new User(
                "pg-admin-" + UUID.randomUUID() + "@test.com", "hash", UserRole.ADMIN,
                "Grant admin", "pgadmin" + shortId()));
        adminId = admin.getId();
        adminUsername = admin.getUsername();
        User target = userRepository.saveAndFlush(new User(
                "pg-target-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER,
                "Grant target", "pgtarget" + shortId()));
        targetUsername = target.getUsername();
        adminToken = TestDataFactory.createGlobalToken(adminId.toString(), admin.getEmail(), "ADMIN", 0);
        targetToken = TestDataFactory.createGlobalToken(target.getId().toString(), target.getEmail(), "USER", 0);
    }

    private static String shortId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 8);
    }

    @Test
    void readIsRetiredWith410() {
        fixture();

        ResponseEntity<Map> response = get(adminToken, targetUsername);

        assertEquals(HttpStatus.GONE, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals(PrincipalGrantAdminService.RETIRED_CODE, response.getBody().get("code"));
        assertTrue(String.valueOf(response.getBody().get("detail"))
                .contains("access-role bindings"), String.valueOf(response.getBody()));
    }

    @Test
    void readDoesNotLeakUnknownAccountsAfterRetirement() {
        fixture();

        ResponseEntity<Map> response = get(adminToken, "missing-" + shortId());

        assertEquals(HttpStatus.GONE, response.getStatusCode(),
                "retirement wins over USER_NOT_FOUND: the surface no longer resolves targets");
        assertEquals(PrincipalGrantAdminService.RETIRED_CODE, response.getBody().get("code"));
    }

    @Test
    void patchIsRetiredWith410AndWritesNothing() {
        fixture();
        int grantsBefore = grantRepository.findAll().size();
        int auditBefore = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE resource_type = 'principal_grant'", Integer.class);

        ResponseEntity<Map> response = patch(adminToken, targetUsername,
                Map.of("add", List.of(Map.of("actionClass", "CREATE_ACCOUNT"))));

        assertEquals(HttpStatus.GONE, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals(PrincipalGrantAdminService.RETIRED_CODE, response.getBody().get("code"));
        assertEquals(grantsBefore, grantRepository.findAll().size(),
                "the retired surface must not write a grant row");
        assertEquals(auditBefore, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE resource_type = 'principal_grant'", Integer.class),
                "the retired surface must not write an audit row");
    }

    @Test
    void emptyPatchBodyIsAlsoRetiredRatherThanA400() {
        fixture();

        ResponseEntity<Map> response = patch(adminToken, targetUsername, Map.of());

        assertEquals(HttpStatus.GONE, response.getStatusCode(),
                "retirement is checked before request validation");
        assertEquals(PrincipalGrantAdminService.RETIRED_CODE, response.getBody().get("code"));
    }

    @Test
    void nonAdminStillGets403BeforeRetirement() {
        fixture();

        ResponseEntity<Map> read = get(targetToken, adminUsername);

        assertEquals(HttpStatus.FORBIDDEN, read.getStatusCode());
        assertEquals("FORBIDDEN", read.getBody().get("code"));
    }

    private ResponseEntity<Map> get(String token, String username) {
        return patchClient.exchange(url(path(username)), HttpMethod.GET,
                new HttpEntity<>(auth(token)), Map.class);
    }

    private ResponseEntity<Map> patch(String token, String username, Object body) {
        HttpHeaders headers = auth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return patchClient.exchange(url(path(username)), HttpMethod.PATCH,
                new HttpEntity<>(body, headers), Map.class);
    }

    private static String path(String username) {
        return "/api/v1/principal-grants/" + username;
    }

    private static HttpHeaders auth(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }
}
