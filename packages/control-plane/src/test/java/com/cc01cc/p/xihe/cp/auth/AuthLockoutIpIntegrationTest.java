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

/**
 * PLAN-0558: IP dimension is independent from the account dimension and uses
 * the trusted forwarded client IP.
 */
@TestPropertySource(properties = {
        "cp.auth.login.account.max-failures=100",
        "cp.auth.login.ip.max-failures=3",
        "cp.auth.login.ip.lock-seconds=60",
        "cp.auth.login.global-max-concurrent=0",
        "cp.auth.login.trusted-proxies=127.0.0.1/32,::1/128"
})
class AuthLockoutIpIntegrationTest extends AbstractIntegrationTest {

    @Test
    void ipLockAppliesToDifferentAccountsAndOtherIpStillWorks() {
        String a = "ip-a-" + System.nanoTime() + "@test.com";
        String b = "ip-b-" + System.nanoTime() + "@test.com";
        register(a);
        register(b);

        for (int i = 0; i < 3; i++) {
            assertEquals(HttpStatus.UNAUTHORIZED.value(),
                    login(a, "wrong-password", "198.51.100.30").getStatusCode().value());
        }

        // A fresh account from the locked IP is rejected by the IP dimension.
        ResponseEntity<Map> locked = login("ip-new-" + System.nanoTime() + "@test.com",
                "wrong-password", "198.51.100.30");
        assertEquals(HttpStatus.TOO_MANY_REQUESTS.value(), locked.getStatusCode().value());
        assertEquals("AUTH_RATE_LIMITED", locked.getBody().get("code"));

        // The same account from another IP is not blocked by the first IP bucket.
        ResponseEntity<Map> other = login(b, TestDataFactory.PASSWORD, "198.51.100.31");
        assertEquals(HttpStatus.OK.value(), other.getStatusCode().value());
    }

    private void register(String email) {
        RegisterRequest request = new RegisterRequest(email, TestDataFactory.PASSWORD, "IP Test");
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
