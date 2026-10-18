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
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0528 wire-level assertions for the public Guidance surface (frozen:
 * spec/cp-guidance-contract.md §3): idempotency replay status, non-active run
 * 409 with frozen code, snapshot ordering and cross-user isolation.
 */
class ChatRunGuidanceHttpIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private ChatRunRepository runs;

    @Autowired
    private SessionRepository sessions;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

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
