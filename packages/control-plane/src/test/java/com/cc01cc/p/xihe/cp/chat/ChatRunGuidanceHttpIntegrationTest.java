package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.LoginRequest;
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
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0528 wire-level assertions for the public Guidance surface (frozen:
 * spec/session/chat-run-operation.md §Run Guidance): idempotency replay status,
 * non-active run 409 with frozen code, snapshot ordering and cross-user isolation.
 */
class ChatRunGuidanceHttpIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private ChatRunRepository runs;

    @Autowired
    private ChatRunGuidanceService service;

    @Autowired
    private SessionRepository sessions;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Value("${cp.agent-api-token:dev-token-not-secure}")
    private String serviceToken;

    private String email;
    private final String password = TestDataFactory.PASSWORD;
    private String userId;
    private String workspaceId;
    private String sessionId;

    @BeforeEach
    void setUp() {
        email = "guidance-http-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, password, "Guidance HTTP");
        ResponseEntity<AuthResponse> reg = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        assertTrue(reg.getStatusCode().is2xxSuccessful());
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow().getId().toString();

        Session session = new Session(workspaceId, userId, "Guidance HTTP Session");
        session.setId(UUID.randomUUID());
        sessionId = sessions.save(session).getId().toString();
    }

    private String bearer() {
        ResponseEntity<AuthResponse> login = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/login", new LoginRequest(email, password), AuthResponse.class);
        return "Bearer " + login.getBody().getAccessToken();
    }

    private String bearerAsOtherUser() {
        String other = "guidance-other-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        restTemplate.postForEntity(baseUrl + "/api/v1/auth/register",
                new RegisterRequest(other, password, "Other"), AuthResponse.class);
        ResponseEntity<AuthResponse> login = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/login", new LoginRequest(other, password), AuthResponse.class);
        return "Bearer " + login.getBody().getAccessToken();
    }

    private String createRun(String status) {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), sessionId, userId, workspaceId,
                "guidance-http-" + UUID.randomUUID(), "hash", "provider", "model", "workspace", status);
        return runs.save(run).getId().toString();
    }

    private HttpEntity<Map<String, Object>> entity(String token, Map<String, Object> body, String idemKey) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token.replace("Bearer ", ""));
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (idemKey != null) {
            headers.set("Idempotency-Key", idemKey);
        }
        return new HttpEntity<>(body, headers);
    }

    @Test
    void submitReplayReturns200WhileFirstReturns201() {
        String runId = createRun("running");
        String token = bearer();
        String url = baseUrl + "/api/v1/chat/runs/" + runId + "/guidance";

        ResponseEntity<Map<String, Object>> first = restTemplate.exchange(url, HttpMethod.POST,
                entity(token, Map.of("content", "prefer the smaller change"), "idem-http-1"),
                new ParameterizedTypeReference<>() { });
        ResponseEntity<Map<String, Object>> replay = restTemplate.exchange(url, HttpMethod.POST,
                entity(token, Map.of("content", "prefer the smaller change"), "idem-http-1"),
                new ParameterizedTypeReference<>() { });

        assertEquals(201, first.getStatusCode().value());
        assertEquals("pending", first.getBody().get("status"));
        assertEquals(200, replay.getStatusCode().value());
        assertEquals(first.getBody().get("id"), replay.getBody().get("id"), "replay must return original id");
    }

    @Test
    void submitOnNonActiveRunReturns409WithFrozenCode() {
        String runId = createRun("queued");
        // The shared RestTemplate does not throw on 4xx (AbstractIntegrationTest init):
        // assert on the response entity directly.
        ResponseEntity<String> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat/runs/" + runId + "/guidance", HttpMethod.POST,
                entity(bearer(), Map.of("content", "hello"), "idem-409"), String.class);
        assertEquals(409, response.getStatusCode().value());
        assertTrue(response.getBody().contains("GUIDANCE_RUN_NOT_ACTIVE"));
    }

    /** PLAN-0543 D2/V4: knowing runId and key is not a capability; only the owner replays. */
    @Test
    void replayAsNonOwnerReturns403WithoutRecordMetadata() throws Exception {
        String runId = createRun("running");
        String content = "prefer the smaller change";
        ResponseEntity<Map<String, Object>> first = restTemplate.exchange(
                baseUrl + "/api/v1/chat/runs/" + runId + "/guidance", HttpMethod.POST,
                entity(bearer(), Map.of("content", content), "idem-owner-only"),
                new ParameterizedTypeReference<>() { });
        assertEquals(201, first.getStatusCode().value());
        String guidanceId = (String) first.getBody().get("id");

        ResponseEntity<String> foreign = restTemplate.exchange(
                baseUrl + "/api/v1/chat/runs/" + runId + "/guidance", HttpMethod.POST,
                entity(bearerAsOtherUser(), Map.of("content", content), "idem-owner-only"), String.class);

        assertEquals(403, foreign.getStatusCode().value());
        assertFalse(foreign.getBody().contains(guidanceId), "no record id may leak");
        assertFalse(foreign.getBody().contains(content), "no content may leak");
        for (String field : List.of("runId", "sessionId", "sequence", "createdAt")) {
            assertFalse(foreign.getBody().contains("\"" + field + "\""),
                    "no " + field + " metadata may leak");
        }
        JsonNode problem = new ObjectMapper().readTree(foreign.getBody());
        assertEquals(403, problem.path("status").asInt(),
                "the only status is the HTTP problem status, never the record status");
    }

    @Test
    void ownerReplayAfterConsumeReturns200WithStoredStatus() {
        String runId = createRun("streaming");
        String token = bearer();
        String url = baseUrl + "/api/v1/chat/runs/" + runId + "/guidance";
        ResponseEntity<Map<String, Object>> first = restTemplate.exchange(url, HttpMethod.POST,
                entity(token, Map.of("content", "once"), "idem-after-consume"),
                new ParameterizedTypeReference<>() { });
        String guidanceId = (String) first.getBody().get("id");
        service.consume(runId, guidanceId);

        ResponseEntity<Map<String, Object>> replay = restTemplate.exchange(url, HttpMethod.POST,
                entity(token, Map.of("content", "once"), "idem-after-consume"),
                new ParameterizedTypeReference<>() { });

        assertEquals(200, replay.getStatusCode().value());
        assertEquals(guidanceId, replay.getBody().get("id"));
        assertEquals("consumed", replay.getBody().get("status"),
                "replay returns the stored record instead of resurrecting pending");
    }

    /** PLAN-0543 T1.4: internal consume is the Agent's only ack surface. */
    @Test
    void internalConsumeAcknowledgesOnceReplaysAndRejectsExpired() {
        String runId = createRun("streaming");
        String submitUrl = baseUrl + "/api/v1/chat/runs/" + runId + "/guidance";

        ResponseEntity<Map<String, Object>> submitted = restTemplate.exchange(submitUrl, HttpMethod.POST,
                entity(bearer(), Map.of("content", "consume me"), "idem-internal-1"),
                new ParameterizedTypeReference<>() { });
        String guidanceId = (String) submitted.getBody().get("id");

        ResponseEntity<Map<String, Object>> consumed = internalConsume(runId, guidanceId);
        assertEquals(200, consumed.getStatusCode().value());
        assertEquals("consumed", consumed.getBody().get("status"));
        assertEquals(Boolean.TRUE, consumed.getBody().get("firstConsumption"));

        ResponseEntity<Map<String, Object>> replay = internalConsume(runId, guidanceId);
        assertEquals(200, replay.getStatusCode().value());
        assertEquals(Boolean.FALSE, replay.getBody().get("firstConsumption"));

        ResponseEntity<Map<String, Object>> pending = restTemplate.exchange(submitUrl, HttpMethod.POST,
                entity(bearer(), Map.of("content", "will expire"), "idem-internal-2"),
                new ParameterizedTypeReference<>() { });
        String pendingId = (String) pending.getBody().get("id");
        ChatRun run = runs.findById(UUID.fromString(runId)).orElseThrow();
        run.setStatus("succeeded");
        run.setTerminalAt(Instant.now());
        runs.save(run);
        service.settleTerminal(UUID.fromString(runId));

        ResponseEntity<String> expired = restTemplate.exchange(
                internalConsumeUrl(runId, pendingId), HttpMethod.POST, internalEntity(), String.class);
        assertEquals(409, expired.getStatusCode().value());
        assertTrue(expired.getBody().contains("GUIDANCE_ALREADY_TERMINAL_EXPIRED"));
    }

    @Test
    void internalConsumeOnMissingOrCrossRunGuidanceReturns404() {
        String runId = createRun("running");
        String otherRunId = createRun("running");
        ResponseEntity<Map<String, Object>> submitted = restTemplate.exchange(
                baseUrl + "/api/v1/chat/runs/" + runId + "/guidance", HttpMethod.POST,
                entity(bearer(), Map.of("content", "cross run"), "idem-internal-404"),
                new ParameterizedTypeReference<>() { });
        String guidanceId = (String) submitted.getBody().get("id");

        ResponseEntity<String> missing = restTemplate.exchange(
                internalConsumeUrl(runId, UUID.randomUUID().toString()), HttpMethod.POST,
                internalEntity(), String.class);
        assertEquals(404, missing.getStatusCode().value());
        assertTrue(missing.getBody().contains("GUIDANCE_RUN_NOT_FOUND"));

        ResponseEntity<String> crossRun = restTemplate.exchange(
                internalConsumeUrl(otherRunId, guidanceId), HttpMethod.POST,
                internalEntity(), String.class);
        assertEquals(404, crossRun.getStatusCode().value());
        assertTrue(crossRun.getBody().contains("GUIDANCE_RUN_NOT_FOUND"));
        assertEquals(1, service.pendingForAgent(runId).size(), "the original row stays pending");
    }

    private String internalConsumeUrl(String runId, String guidanceId) {
        return baseUrl + "/internal/v1/chat/runs/" + runId + "/guidance/" + guidanceId + "/consume";
    }

    private ResponseEntity<Map<String, Object>> internalConsume(String runId, String guidanceId) {
        return restTemplate.exchange(internalConsumeUrl(runId, guidanceId), HttpMethod.POST,
                internalEntity(), new ParameterizedTypeReference<>() { });
    }

    private HttpEntity<Void> internalEntity() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(serviceToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return new HttpEntity<>(headers);
    }

    @Test
    void snapshotOrdersBySequenceAndIsolatesForeignUser() {
        String runId = createRun("running");
        String token = bearer();
        String url = baseUrl + "/api/v1/chat/runs/" + runId + "/guidance";
        restTemplate.exchange(url, HttpMethod.POST, entity(token, Map.of("content", "one"), "idem-s1"),
                new ParameterizedTypeReference<Map<String, Object>>() { });
        restTemplate.exchange(url, HttpMethod.POST, entity(token, Map.of("content", "two"), "idem-s2"),
                new ParameterizedTypeReference<Map<String, Object>>() { });

        ResponseEntity<Map<String, Object>> mine = restTemplate.exchange(url, HttpMethod.GET,
                entity(token, null, null), new ParameterizedTypeReference<>() { });
        assertEquals(200, mine.getStatusCode().value());
        List<Map<String, Object>> items = castItems(mine.getBody().get("items"));
        assertEquals(2, items.size());
        assertEquals(1, items.get(0).get("sequence"));
        assertEquals(2, items.get(1).get("sequence"));
        assertEquals("user", items.get(0).get("sourceKind"));
        assertEquals("one", items.get(0).get("content"));

        ResponseEntity<String> foreign = restTemplate.exchange(url, HttpMethod.GET,
                entity(bearerAsOtherUser(), null, null), String.class);
        assertEquals(403, foreign.getStatusCode().value(),
                "another user must not read this run's guidance");
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> castItems(Object raw) {
        return (List<Map<String, Object>>) raw;
    }
}
