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
 * PLAN-0558: register is rate-limited per client IP, while loopback stays
 * exempt by default so host E2E registration is not self-poisoned.
 */
@TestPropertySource(properties = {
        "cp.auth.login.register.max-attempts=2",
        "cp.auth.login.register.exempt-loopback=true",
        "cp.auth.login.trusted-proxies=127.0.0.1/32,::1/128"
})
class AuthRegisterLimitIntegrationTest extends AbstractIntegrationTest {

    @Test
    void loopbackRegisterIsExempt() {
        assertEquals(HttpStatus.CREATED.value(),
                register("loop-register-a-" + System.nanoTime() + "@test.com", null).getStatusCode().value());
        assertEquals(HttpStatus.CREATED.value(),
                register("loop-register-b-" + System.nanoTime() + "@test.com", null).getStatusCode().value());
    }

    @Test
    void publicIpRegisterIsLimited() {
        assertEquals(HttpStatus.CREATED.value(),
                register("public-register-a-" + System.nanoTime() + "@test.com",
                        "198.51.100.50").getStatusCode().value());
        ResponseEntity<Map> limited = register("public-register-b-" + System.nanoTime() + "@test.com",
                "198.51.100.50");
        assertEquals(HttpStatus.TOO_MANY_REQUESTS.value(), limited.getStatusCode().value());
        assertEquals("AUTH_RATE_LIMITED", limited.getBody().get("code"));
    }

    private ResponseEntity<Map> register(String email, String forwardedFor) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (forwardedFor != null) {
            headers.set("X-Forwarded-For", forwardedFor);
        }
        RegisterRequest request = new RegisterRequest(email, TestDataFactory.PASSWORD, "Register Limit");
        return restTemplate.exchange(url("/api/v1/auth/register"), HttpMethod.POST,
                new HttpEntity<>(request, headers), Map.class);
    }
}

