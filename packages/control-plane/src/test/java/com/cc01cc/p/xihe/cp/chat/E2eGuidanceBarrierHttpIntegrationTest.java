package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0536 wire-level acceptance for the E2E-only Guidance barrier, in the
 * {@code e2e} profile (the only place the routes exist).
 *
 * <p>The last case is the whole point of the plan: a real Guidance POST is held
 * inside the barrier, the real cancel endpoint moves the Run to
 * {@code cancelling}, the barrier releases, and the unchanged production
 * validation answers {@code 409 GUIDANCE_RUN_NOT_ACTIVE}.
 */
@ActiveProfiles({"test", "e2e"})
class E2eGuidanceBarrierHttpIntegrationTest extends AbstractIntegrationTest {

    private static final String SERVICE_TOKEN = UUID.randomUUID() + "-" + UUID.randomUUID();
    private static final String E2E_RUN_ID = "host-plan0536-" + UUID.randomUUID().toString().substring(0, 8);

    @Autowired
    private ChatRunRepository runs;
    @Autowired
    private SessionRepository sessions;
    @Autowired
    private UserRepository users;
    @Autowired
    private WorkspaceRepository workspaces;
    @Autowired
    private ObjectMapper objectMapper;

    private String email;
    private String userId;
    private String workspaceId;
    private String sessionId;
    private String userToken;

    @DynamicPropertySource
    static void serviceToken(DynamicPropertyRegistry registry) {
        registry.add("cp.agent-api-token", () -> SERVICE_TOKEN);
    }

    @BeforeEach
    void setUp() {
        email = "barrier-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        var registration = restTemplate.postForEntity(url("/api/v1/auth/register"),
                new RegisterRequest(email, TestDataFactory.PASSWORD, "Barrier"), AuthResponse.class);
        assertTrue(registration.getStatusCode().is2xxSuccessful());
        User user = users.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaces.findActiveByMemberUserId(UUID.fromString(userId))
                .getFirst().getId().toString();
        Session session = new Session(workspaceId, userId, "Barrier Session");
        session.setId(UUID.randomUUID());
        sessionId = sessions.save(session).getId().toString();
        userToken = registration.getBody().getAccessToken();
    }

    @Test
    void userJwtCannotReachTheControlSurface() throws Exception {
        String runId = createRun("running");
        HttpResponse<String> armed = post("/internal/v1/e2e/guidance-barrier/" + runId + "/arm",
                userToken, "{\"e2eRunId\":\"" + E2E_RUN_ID + "\",\"holdMs\":5000}");
        assertEquals(403, armed.statusCode(), "a normal user must not arm the barrier");

        HttpResponse<String> status = get("/internal/v1/e2e/guidance-barrier/" + runId
                + "?e2eRunId=" + E2E_RUN_ID, userToken);
        assertEquals(403, status.statusCode());
    }

    @Test
    void serviceTokenCanArmObserveAndRelease() throws Exception {
        String runId = createRun("running");
        HttpResponse<String> armed = post("/internal/v1/e2e/guidance-barrier/" + runId + "/arm",
                SERVICE_TOKEN, "{\"e2eRunId\":\"" + E2E_RUN_ID + "\",\"holdMs\":5000}");
        assertEquals(200, armed.statusCode(), armed.body());
        assertEquals("armed", json(armed.body()).get("state").asText());

        HttpResponse<String> status = get("/internal/v1/e2e/guidance-barrier/" + runId
                + "?e2eRunId=" + E2E_RUN_ID, SERVICE_TOKEN);
        assertEquals(200, status.statusCode());
        assertEquals("armed", json(status.body()).get("state").asText());

        HttpResponse<String> released = post("/internal/v1/e2e/guidance-barrier/" + runId + "/release?e2eRunId="
                + E2E_RUN_ID, SERVICE_TOKEN, null);
        assertEquals(200, released.statusCode(), released.body());
        assertEquals("absent", json(get("/internal/v1/e2e/guidance-barrier/" + runId
                + "?e2eRunId=" + E2E_RUN_ID, SERVICE_TOKEN).body()).get("state").asText());
    }

    @Test
    void anotherRunIsNotHeldWhileABarrierIsArmed() throws Exception {
        String armedRun = createRun("running");
        String otherRun = createRun("running");
        assertEquals(200, post("/internal/v1/e2e/guidance-barrier/" + armedRun + "/arm", SERVICE_TOKEN,
                "{\"e2eRunId\":\"" + E2E_RUN_ID + "\",\"holdMs\":10000}").statusCode());

        long started = System.nanoTime();
        assertEquals(201, submitGuidance(otherRun, "not held").statusCode(),
                "an unrelated run must not be paused by another run's barrier");
        long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        assertTrue(elapsedMs < 5_000, "unrelated guidance must not wait: " + elapsedMs + "ms");

        post("/internal/v1/e2e/guidance-barrier/" + armedRun + "/release?e2eRunId=" + E2E_RUN_ID,
                SERVICE_TOKEN, null);
    }

    @Test
    void heldSubmissionReturnsFrozen409AfterRealCancel() throws Exception {
        String runId = createRun("running");
        assertEquals(200, post("/internal/v1/e2e/guidance-barrier/" + runId + "/arm", SERVICE_TOKEN,
                "{\"e2eRunId\":\"" + E2E_RUN_ID + "\",\"holdMs\":20000}").statusCode());

        CompletableFuture<HttpResponse<String>> held =
                CompletableFuture.supplyAsync(() -> submitGuidance(runId, "race guidance"));
        awaitBarrierState(runId, "reached");

        HttpResponse<String> cancelled = post("/api/v1/chat/runs/" + runId + "/cancel", userToken,
                "{\"reason\":\"plan0536_race\"}");
        assertEquals(200, cancelled.statusCode(), cancelled.body());

        assertEquals(200, post("/internal/v1/e2e/guidance-barrier/" + runId + "/release?e2eRunId="
                + E2E_RUN_ID, SERVICE_TOKEN, null).statusCode());

        HttpResponse<String> guidance = held.get(10, TimeUnit.SECONDS);
        assertEquals(409, guidance.statusCode(), guidance.body());
        assertTrue(guidance.body().contains("GUIDANCE_RUN_NOT_ACTIVE"), guidance.body());

        JsonNode snapshot = json(get("/api/v1/chat/runs/" + runId + "/guidance", userToken).body());
        assertEquals(0, snapshot.get("items").size(), "a rejected submission must not create a record");
    }

    @Test
    void unreleasedBarrierFailsExplicitlyWithoutWriting() throws Exception {
        String runId = createRun("running");
        assertEquals(200, post("/internal/v1/e2e/guidance-barrier/" + runId + "/arm", SERVICE_TOKEN,
                "{\"e2eRunId\":\"" + E2E_RUN_ID + "\",\"holdMs\":1}").statusCode());

        HttpResponse<String> timedOut = submitGuidance(runId, "never released");
        assertEquals(503, timedOut.statusCode(), timedOut.body());
        assertTrue(timedOut.body().contains(E2eGuidanceBarrier.ERROR_TIMEOUT), timedOut.body());

        JsonNode snapshot = json(get("/api/v1/chat/runs/" + runId + "/guidance", userToken).body());
        assertEquals(0, snapshot.get("items").size(), "a timed-out barrier must not persist guidance");
    }

    private String createRun(String status) {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), sessionId, userId, workspaceId,
                "barrier-" + UUID.randomUUID(), "hash", "provider", "model", "workspace", status);
        return runs.save(run).getId().toString();
    }

    private HttpResponse<String> submitGuidance(String runId, String content) {
        try {
            return post("/api/v1/chat/runs/" + runId + "/guidance", userToken,
                    "{\"content\":\"" + content + "\"}",
                    "Idempotency-Key", "barrier-" + UUID.randomUUID());
        } catch (Exception failure) {
            throw new IllegalStateException(failure);
        }
    }

    private void awaitBarrierState(String runId, String expected) throws Exception {
        for (int attempt = 0; attempt < 200; attempt++) {
            JsonNode body = json(get("/internal/v1/e2e/guidance-barrier/" + runId
                    + "?e2eRunId=" + E2E_RUN_ID, SERVICE_TOKEN).body());
            if (expected.equals(body.get("state").asText())) {
                return;
            }
            Thread.sleep(25);
        }
        throw new AssertionError("barrier never reached " + expected);
    }

    private HttpResponse<String> post(String path, String token, String body) throws Exception {
        return send("POST", path, token, body);
    }

    private HttpResponse<String> post(String path, String token, String body,
                                      String headerName, String headerValue) throws Exception {
        return send("POST", path, token, body, headerName, headerValue);
    }

    private HttpResponse<String> get(String path, String token) throws Exception {
        return send("GET", path, token, null);
    }

    private HttpResponse<String> send(String method, String path, String token, String body,
                                      String... extraHeaders) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url(path)))
                .timeout(Duration.ofSeconds(30));
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        for (int index = 0; index + 1 < extraHeaders.length; index += 2) {
            builder.header(extraHeaders[index], extraHeaders[index + 1]);
        }
        if (body != null) {
            builder.header("Content-Type", "application/json");
            builder.method(method, HttpRequest.BodyPublishers.ofString(body));
        } else {
            builder.method(method, HttpRequest.BodyPublishers.noBody());
        }
        try (HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()) {
            return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        }
    }

    private JsonNode json(String body) throws Exception {
        return objectMapper.readTree(body);
    }
}
