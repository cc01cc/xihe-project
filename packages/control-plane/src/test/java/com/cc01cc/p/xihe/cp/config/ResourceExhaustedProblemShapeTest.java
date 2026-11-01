package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.policy.ResourceKey;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * PLAN-0622 M1.5 (R6/R7): the rendered refusal shape.
 *
 * <p>Header and body must never disagree about the retry delay, the body must name the resource that
 * ran out, and the status must stay 429 (a governor refusal is not a backend outage).</p>
 */
class ResourceExhaustedProblemShapeTest {

    @Test
    void theRefusalCarriesTheSameRetryHintOnBothChannelsAndIsNeverA503() {
        HttpServletRequest request = mock(HttpServletRequest.class);
        when(request.getRequestURI()).thenReturn("/internal/v1/provider-leases/redeem");

        ResponseEntity<Map<String, Object>> response = new ProblemDetailsHandler(5_000L).resourceExhausted(
                new ResourceExhaustedException(ResourceKey.connection("abc"), 7, "connection is busy"), request);

        assertEquals(429, response.getStatusCode().value());
        assertNotEquals(503, response.getStatusCode().value(), "R7: 429 is not 503");
        assertEquals("7", response.getHeaders().getFirst("Retry-After"));
        assertEquals("no-store", response.getHeaders().getFirst("Cache-Control"));
        Map<String, Object> body = response.getBody();
        assertEquals(7, body.get("retryAfterSeconds"), "R6: body mirrors the header");
        assertEquals("RESOURCE_EXHAUSTED", body.get("code"));
        assertEquals("CONNECTION", body.get("resourceKind"));
        assertEquals("connection:abc", body.get("scope"));
    }
}
