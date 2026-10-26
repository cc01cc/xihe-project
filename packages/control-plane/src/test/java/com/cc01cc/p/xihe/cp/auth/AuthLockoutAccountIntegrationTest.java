package com.cc01cc.p.xihe.cp.auth;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.TestPropertySource;
import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0558: account dimension is independent from the source IP and a lock
 * never revokes an already-issued token.
 */
@TestPropertySource(properties = {
        "cp.auth.login.account.max-failures=3",
        "cp.auth.login.account.lock-seconds=60",
        "cp.auth.login.ip.max-failures=100",
        "cp.auth.login.global-max-concurrent=0",
        "cp.auth.login.trusted-proxies=127.0.0.1/32,::1/128"
})
class AuthLockoutAccountIntegrationTest extends AbstractIntegrationTest {

    @Test
    void accountLockAppliesAcrossIpsAndDoesNotRevokeExistingToken() {
        String email = "lock-account-" + System.nanoTime() + "@test.com";
        String other = "lock-other-" + System.nanoTime() + "@test.com";
        register(email);
        register(other);

        ResponseEntity<Map> first = login(email, "wrong-password", "198.51.100.10");
        assertEquals(HttpStatus.UNAUTHORIZED.value(), first.getStatusCode().value());

        ResponseEntity<Map> success = login(email, TestDataFactory.PASSWORD, "198.51.100.10");
        assertEquals(HttpStatus.OK.value(), success.getStatusCode().value());
        String token = (String) success.getBody().get("accessToken");
        assertNotNull(token);

        for (int i = 0; i < 3; i++) {
            assertEquals(HttpStatus.UNAUTHORIZED.value(),
                    login(email, "wrong-password", "198.51.100.10").getStatusCode().value());
        }

        ResponseEntity<Map> locked = login(email, "wrong-password", "198.51.100.10");
        assertEquals(HttpStatus.TOO_MANY_REQUESTS.value(), locked.getStatusCode().value());
        assertEquals("AUTH_RATE_LIMITED", locked.getBody().get("code"));
        assertNotNull(locked.getHeaders().getFirst("Retry-After"));
        assertTrue(Integer.parseInt(locked.getHeaders().getFirst("Retry-After")) >= 1);

        // Same account, different source IP: still locked by the account dimension.
        assertEquals(HttpStatus.TOO_MANY_REQUESTS.value(),
                login(email, "wrong-password", "198.51.100.11").getStatusCode().value());

        // A different account from the first IP is not caught by an IP lock.
        assertEquals(HttpStatus.OK.value(),
                login(other, TestDataFactory.PASSWORD, "198.51.100.10").getStatusCode().value());

        // The lock only gates new logins; the token issued before the lock still works.
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        ResponseEntity<Map> me = restTemplate.exchange(url("/api/v1/auth/me"), HttpMethod.GET,
                new HttpEntity<>(headers), Map.class);
        assertEquals(HttpStatus.OK.value(), me.getStatusCode().value());
    }

    @Test
    void unknownAccountIsCountedAndLocked() {
        String unknown = "unknown-" + System.nanoTime() + "@test.com";
        String otherUnknown = "unknown-other-" + System.nanoTime() + "@test.com";

        for (int i = 0; i < 3; i++) {
            assertEquals(HttpStatus.UNAUTHORIZED.value(),
                    login(unknown, "wrong-password", "198.51.100.20").getStatusCode().value());
        }
        ResponseEntity<Map> locked = login(unknown, "wrong-password", "198.51.100.20");
        assertEquals(HttpStatus.TOO_MANY_REQUESTS.value(), locked.getStatusCode().value());
        assertEquals("AUTH_RATE_LIMITED", locked.getBody().get("code"));

        // A different unknown key is not locked by the first account's bucket.
        assertEquals(HttpStatus.UNAUTHORIZED.value(),
                login(otherUnknown, "wrong-password", "198.51.100.21").getStatusCode().value());
    }

    private void register(String email) {
        RegisterRequest request = new RegisterRequest(email, TestDataFactory.PASSWORD, "Lock Test");
        ResponseEntity<Map> response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                request, Map.class);
        assertEquals(HttpStatus.CREATED.value(), response.getStatusCode().value());
    }

    private ResponseEntity<Map> login(String email, String password, String forwardedFor) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-Forwarded-For", forwardedFor);
        return restTemplate.exchange(url("/api/v1/auth/login"), HttpMethod.POST,
                new HttpEntity<>(new LoginRequest(email, password), headers), Map.class);
    }
}
