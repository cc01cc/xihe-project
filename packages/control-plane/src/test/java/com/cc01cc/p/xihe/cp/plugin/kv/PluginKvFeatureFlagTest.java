package com.cc01cc.p.xihe.cp.plugin.kv;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * PLAN-0691 T1.5 / D-66: with {@code cp.plugin.enabled=false} (the shipped default) the KV data plane
 * must look like a build that never had it — <b>404</b>, not 401 and not 403.
 *
 * <p>That is a two-part obligation, and both parts are easy to break:
 * <ul>
 *   <li>the controller is not mapped ({@code @ConditionalOnProperty}), so the dispatcher has nothing to
 *       route to;</li>
 *   <li>the security chain must <b>permit</b> the path when the flag is off, otherwise the request
 *       would be answered 401/403 by {@code /internal/v1/**} before it ever reached the dispatcher —
 *       the disabled feature would still be observable as "exists but forbidden".</li>
 * </ul>
 *
 * <p>No token is minted and no binding is seeded on purpose: the answer must not depend on credentials
 * at all, which is exactly what the assertions below check.
 */
class PluginKvFeatureFlagTest extends AbstractIntegrationTest {

    private static final String KV_PATH = "/internal/v1/plugin-bindings/"
            + UUID.randomUUID() + "/kv/default/any";

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void kvSurfaceIsNotFoundWhenTheFeatureIsOff() {
        ResponseEntity<String> response = get(KV_PATH, null);

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode(),
                "D-66: feature-off answers 404, got " + response.getStatusCode() + " " + response.getBody());
        assertFalse(response.getBody() != null && response.getBody().contains("AUTHORIZATION_REQUIRED"),
                "a flagged-off surface must not ask for credentials");
    }

    @Test
    void aBearerTokenDoesNotChangeTheAnswer() {
        ResponseEntity<String> response = get(KV_PATH, "anything-at-all");

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode(),
                "the answer must not depend on the credential when the feature is off");
    }

    @Test
    void otherProtectedPathsStillAnswerUnauthorized() {
        // Control: the 404 above is specific to the flagged-off KV path, not a globally broken chain.
        ResponseEntity<String> response = get("/api/v1/workspaces", null);

        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
        assertEquals("AUTHORIZATION_REQUIRED", objectMapper.readTree(response.getBody())
                .get("code").asText());
    }

    private ResponseEntity<String> get(String path, String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setAccept(List.of(MediaType.APPLICATION_JSON,
                MediaType.valueOf("application/problem+json")));
        if (token != null) {
            headers.setBearerAuth(token);
        }
        return restTemplate.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(null, headers), String.class);
    }
}
