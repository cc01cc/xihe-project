package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.AbstractReusableIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
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
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * PLAN-0610 W2 / decision #28: the PLAN-0585 target-user row-lock contract is retired with the
 * surface itself.
 *
 * <p>Before V88 this class proved that a lock wait beyond {@code cp.lock-timeout-ms} surfaced as
 * 503 {@code OPERATION_LOCK_TIMEOUT} instead of a silent success. The retired service now answers
 * {@code 410 PRINCIPAL_GRANTS_RETIRED} before any lock or database work, so the bounded-wait
 * property no longer exists on this surface (access-role binding writes are W3's contract). This
 * test keeps the class name and asserts the retirement so a future reader does not assume the lock
 * semantics are still live.</p>
 */
class PrincipalGrantLockTimeoutContractTest extends AbstractReusableIntegrationTest {

    private RestTemplate patchClient;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private AuthzContext authzContext;

    @Autowired
    private org.springframework.jdbc.core.JdbcTemplate jdbc;


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
        User admin = userRepository.saveAndFlush(new User("lock-admin-" + UUID.randomUUID() + "@test.com", "hash",
                "Lock admin", "lockadmin" + shortId()));
        User target = userRepository.saveAndFlush(new User("lock-target-" + UUID.randomUUID() + "@test.com", "hash",
                "Lock target", "locktarget" + shortId()));
        targetUsername = target.getUsername();
        grantInstanceAdmin(admin.getId());
        adminToken = TestDataFactory.createGlobalToken(admin.getId().toString(), admin.getEmail(), "ADMIN", 0);
    }

    /**
     * PLAN-0610 W4a: an instance administrator is a binding holder (the retired {@code users.role}
     * column never authorizes). Capability atoms are never materialized, so no grant row is needed
     * for {@code cap:instance:admin} to reach the request authorities; the cache is dropped because
     * the row is written behind {@code AuthzContext}'s back.
     */
    private void grantInstanceAdmin(UUID userId) {
        jdbc.update("INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type,"
                + " granted_at) SELECT gen_random_uuid(), r.id, 'user', CAST(? AS UUID), 'instance',"
                + " NOW() FROM roles r WHERE r.name = 'ADMIN'", userId);
        authzContext.invalidateAll();
    }

    private static String shortId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 8);
    }

    @Test
    void lockBoundedWriteIsRetiredNotA503LockTimeout() {
        fixture();

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(adminToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> response = patchClient.exchange(
                url("/api/v1/principal-grants/" + targetUsername), HttpMethod.PATCH,
                new HttpEntity<>(Map.of("add", List.of(Map.of("actionClass", "CREATE_ACCOUNT"))), headers),
                Map.class);

        assertEquals(HttpStatus.GONE, response.getStatusCode(), String.valueOf(response.getBody()));
        assertEquals(PrincipalGrantAdminService.RETIRED_CODE, response.getBody().get("code"));
    }

    @Test
    void concurrentPatchAttemptsAreAllRetiredWithoutLockContention() {
        fixture();

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(adminToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        for (int attempt = 0; attempt < 2; attempt++) {
            ResponseEntity<Map> response = patchClient.exchange(
                    url("/api/v1/principal-grants/" + targetUsername), HttpMethod.PATCH,
                    new HttpEntity<>(Map.of("add", List.of(Map.of("actionClass", "CREATE_ACCOUNT"))), headers),
                    Map.class);
            assertEquals(HttpStatus.GONE, response.getStatusCode(), "attempt " + attempt);
        }
    }
}
