package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.ActiveProfiles;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0536 V1 negative proof: outside the {@code e2e} profile the control
 * routes must not exist at all, so neither a user JWT nor the service token can
 * reach them. This runs on the plain {@code test} profile — the same absence
 * applies to {@code dev} and {@code prod}, which also never activate {@code e2e}.
 */
@ActiveProfiles("test")
class E2eGuidanceBarrierAbsentOutsideE2eProfileTest extends AbstractIntegrationTest {

    private static final String SERVICE_TOKEN = UUID.randomUUID() + "-" + UUID.randomUUID();

    @Autowired
    private UserRepository users;

    @org.springframework.test.context.DynamicPropertySource
    static void configure(org.springframework.test.context.DynamicPropertyRegistry registry) {
        registry.add("cp.agent-api-token", () -> SERVICE_TOKEN);
    }

    @Test
    void controlRoutesDoNotExistWithoutTheE2eProfile() throws Exception {
        String email = "barrier-absent-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        var registration = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest(email, TestDataFactory.PASSWORD, "BarrierAbsent"), AuthResponse.class);
        assertTrue(registration.getStatusCode().is2xxSuccessful());
        User user = users.findByEmail(email).orElseThrow();
        String userToken = registration.getBody().getAccessToken();
        String runId = UUID.randomUUID().toString();

        // A user JWT never passes the /internal/v1/** role gate, so it cannot even
        // learn whether the route exists (403, not 404).
        assertEquals(403, status("POST", "/internal/v1/e2e/guidance-barrier/" + runId + "/arm", userToken,
                "{\"e2eRunId\":\"host-x\",\"holdMs\":1000}"));
        assertEquals(403, status("GET", "/internal/v1/e2e/guidance-barrier/" + runId + "?e2eRunId=host-x",
                userToken, null));
        // The service token is authorized, so absence of the handler is observable: 404.
        assertEquals(404, status("POST", "/internal/v1/e2e/guidance-barrier/" + runId + "/arm", SERVICE_TOKEN,
                "{\"e2eRunId\":\"host-x\",\"holdMs\":1000}"));
        assertEquals(404, status("GET", "/internal/v1/e2e/guidance-barrier/" + runId + "?e2eRunId=host-x",
                SERVICE_TOKEN, null));
        assertTrue(user.getId() != null, "fixture user must exist");
    }

    private int status(String method, String path, String token, String body) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url(path)))
                .timeout(Duration.ofSeconds(20));
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        if (body != null) {
            builder.header("Content-Type", "application/json");
            builder.method(method, HttpRequest.BodyPublishers.ofString(body));
        } else {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        }
        try (HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()) {
            return client.send(builder.build(), HttpResponse.BodyHandlers.ofString()).statusCode();
        }
    }
}
