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

/**
 * PLAN-0610 W2 / decision #28: the retired PLAN-0585 grant surface no longer unlocks the two gates
 * it existed for, and it must not write anything on the way out.
 *
 * <p>The old scenario (admin grants {@code CREATE_ACCOUNT} → agent-principal creation becomes 201)
 * is replaced by access-role bindings in W3; this test only asserts the retirement contract and
 * that the untouched baseline (creating an agent principal without the atom) still answers 403.</p>
 */
class PrincipalGrantAuthorizationIntegrationTest extends AbstractIntegrationTest {

    private RestTemplate patchClient;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String adminToken;
    private String targetUsername;

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
                "grant-auth-admin-" + UUID.randomUUID() + "@test.com", "hash", UserRole.ADMIN,
                "Grant auth admin", "grantadmin" + shortId()));
        User target = userRepository.saveAndFlush(new User(
                "grant-auth-target-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER,
                "Grant auth target", "granttarget" + shortId()));
        targetUsername = target.getUsername();
        adminToken = TestDataFactory.createGlobalToken(admin.getId().toString(), admin.getEmail(), "ADMIN", 0);
    }

    private static String shortId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 8);
    }

    @Test
    void grantingCreateAccountIsRetiredAndWritesNoGrantRow() {
        fixture();
        int grantsBefore = grantRepository.findAll().size();
        int auditBefore = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE resource_type = 'principal_grant'", Integer.class);

        ResponseEntity<Map> response = patch(Map.of(
                "add", List.of(Map.of("actionClass", "CREATE_ACCOUNT"))));

        assertEquals(HttpStatus.GONE, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals(PrincipalGrantAdminService.RETIRED_CODE, response.getBody().get("code"));
        assertEquals(grantsBefore, grantRepository.findAll().size(),
                "no grant row may be written by the retired surface");
        assertEquals(auditBefore, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM audit_logs WHERE resource_type = 'principal_grant'", Integer.class),
                "no principal_grant audit row may be written by the retired surface");
    }

    @Test
    void agentPrincipalCreationWithoutTheAtomStillFailsClosed() {
        fixture();

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(adminToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> created = patchClient.exchange(
                url("/api/v1/agent-principals"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "retired-grant-probe"), headers), Map.class);

        assertEquals(HttpStatus.FORBIDDEN, created.getStatusCode(),
                "the default-deny baseline is unchanged after the retirement");
    }

    private ResponseEntity<Map> patch(Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(adminToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return patchClient.exchange(url("/api/v1/principal-grants/" + targetUsername), HttpMethod.PATCH,
                new HttpEntity<>(body, headers), Map.class);
    }
}
