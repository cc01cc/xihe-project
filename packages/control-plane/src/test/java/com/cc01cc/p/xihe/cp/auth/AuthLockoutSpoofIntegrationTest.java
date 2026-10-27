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

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * PLAN-0558: with no trusted proxy configured, a forged X-Forwarded-For must
 * not create new IP buckets.
 */
@TestPropertySource(properties = {
        "cp.auth.login.account.max-failures=100",
        "cp.auth.login.ip.max-failures=2",
        "cp.auth.login.ip.lock-seconds=60",
        "cp.auth.login.global-max-concurrent=0",
        "cp.auth.login.trusted-proxies="
})
class AuthLockoutSpoofIntegrationTest extends AbstractIntegrationTest {

    @Test
    void forgedForwardedForDoesNotBypassIpLimit() {
        assertEquals(HttpStatus.UNAUTHORIZED.value(),
                login("198.51.100.40").getStatusCode().value());
        assertEquals(HttpStatus.UNAUTHORIZED.value(),
                login("198.51.100.41").getStatusCode().value());

        ResponseEntity<Map> locked = login("198.51.100.42");
        assertEquals(HttpStatus.TOO_MANY_REQUESTS.value(), locked.getStatusCode().value());
        assertEquals("AUTH_RATE_LIMITED", locked.getBody().get("code"));
    }

    private ResponseEntity<Map> login(String forwardedFor) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-Forwarded-For", forwardedFor);
        return restTemplate.exchange(url("/api/v1/auth/login"), HttpMethod.POST,
                new HttpEntity<>(new LoginRequest("spoof-" + System.nanoTime() + "@test.com",
                        "wrong-password"), headers), Map.class);
    }
}
