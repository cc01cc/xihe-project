package com.cc01cc.p.xihe.cp.auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;

/**
 * PLAN-0581 §6 / verify V6: the closed policy over the real HTTP surface.
 *
 * <p>This class needs its own Spring context because the switch is a bootstrap env
 * read at bean construction ({@code @Value}); {@code @TestPropertySource} is the
 * supported way to pin it per test class. Everything else (PG container, schema,
 * Flyway) is inherited from {@link AbstractIntegrationTest}.
 */
@TestPropertySource(properties = "XIHE_AUTH_REGISTRATION_POLICY=closed")
class RegistrationPolicyIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void closedPolicyRefusesRegistrationWithoutCreatingARow() throws Exception {
        long before = jdbc.queryForObject("SELECT COUNT(*) FROM users", Long.class);

        ResponseEntity<String> response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                Map.of("email", "closed-policy-" + java.util.UUID.randomUUID() + "@test.com",
                        "password", "closed-policy-pass", "name", "Closed"),
                String.class);

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode(), response.getBody());
        assertEquals("REGISTRATION_CLOSED", objectMapper.readTree(response.getBody()).path("code").asText());
        assertEquals(before, jdbc.queryForObject("SELECT COUNT(*) FROM users", Long.class),
                "a refused registration must not create a user row");
    }

    /**
     * The policy check sits <b>after</b> the 0558 IP throttle (contract §6): the
     * profile disables throttling by default, so the observable order is proven by
     * the unit-level placement assertion — the closed branch is reached only after
     * {@code loginAttemptService.checkAndRecordRegister} returns. This test pins the
     * remaining half: the refusal is a clean 403 body, not a 429 or a 500.
     */
    @Test
    void closedPolicyAnswers403NotThrottleOrServerError() {
        ResponseEntity<String> response = restTemplate.postForEntity(url("/api/v1/auth/register"),
                Map.of("email", "another-closed-" + java.util.UUID.randomUUID() + "@test.com",
                        "password", "closed-policy-pass", "name", "Closed"),
                String.class);
        assertFalse(response.getStatusCode().is2xxSuccessful());
        assertFalse(response.getStatusCode().is5xxServerError(), "never a 500");
        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
    }
}
