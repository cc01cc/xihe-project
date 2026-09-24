package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.service.AgentTemplateService;
import com.cc01cc.p.xihe.cp.status.HealthMonitor;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.*;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.util.Map;
import java.util.UUID;

class AgentChatIntegrationTest extends AbstractWireMockTest {

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("cp.agent-url", () -> "http://localhost:" + wireMock.port() + "/internal/v1/agent/chat");
        registry.add("cp.agent-base-url", () -> "http://localhost:" + wireMock.port());
    }

    @Autowired
    private SseEmitterManager sseEmitterManager;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @Autowired
    private HealthMonitor healthMonitor;

    @Autowired
    private ConfigService configService;

    @Autowired
    private AgentPrincipalService agentPrincipalService;

    @Autowired
    private AgentTemplateService agentTemplateService;

    private String token;
    private String userId;
    private String workspaceId;
    private String principalId;
    private com.fasterxml.jackson.databind.JsonNode principalPermissions;

    @BeforeEach
    void setUp() {
        super.setUp();
        wireMock.resetAll();
        wireMock.stubFor(get(urlEqualTo("/internal/v1/agent/health"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"status\":\"ok\",\"liveness\":\"up\",\"llmReady\":\"ready\",\"configRevision\":\"test-revision\"}")));
        healthMonitor.pollHealth();
        token = registerAndLogin();

        userId = jwtTokenProvider.getUserIdFromToken(token);
        Workspace ws = new Workspace("Agent Test", userId);
        ws = workspaceRepository.save(ws);
        workspaceId = ws.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        token = jwtTokenProvider.createAccessToken(userId, jwtTokenProvider.getEmailFromToken(token), "USER", workspaceId);

        var defaultTemplate = agentTemplateService.resolveForCreation(userId, workspaceId, null);
        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                userId, "Agent chat test principal", null, defaultTemplate.snapshot());
        principalId = principal.getId().toString();
        principalPermissions = principal.getTemplateSnapshot().get("permissions");
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(
                principalId, workspaceId, principalPermissions.deepCopy()));

        assertTrue(workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(UUID.fromString(workspaceId), UUID.fromString(userId)).isPresent(),
                "Workspace user should be created");

        when(sseEmitterManager.hasEmitter(anyString())).thenReturn(true);
    }

    @Test
    void chatForwardsToAgentWithCorrectHeadersAndBody() {
        String sessionId = UUID.randomUUID().toString();
        createAgentSession(sessionId, "Agent body test");

        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/chat"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "text/event-stream")
                        .withBody("event: done\ndata: {\"content\":\"Hello!\"}\n\n")));

        Map<String, Object> body = Map.of(
                "sessionId", sessionId,
                "content", "Hello",
                "userId", userId,
                "workspaceId", workspaceId
        );

        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/chat"),
                HttpMethod.POST,
                entityWithAuth(body, token),
                Map.class);

        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());

        try { Thread.sleep(500); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }

        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/agent/chat"))
                .withHeader("Authorization", containing("Bearer dev-token-not-secure"))
                .withHeader("Content-Type", containing("application/json"))
                .withRequestBody(matchingJsonPath("$.sessionId"))
                .withRequestBody(matchingJsonPath("$.content"))
                .withRequestBody(matchingJsonPath("$.stream", equalTo("true"))));
    }

    @Test
    void chatForwardsStreamingRequestToAgent() {
        String sessionId = UUID.randomUUID().toString();
        createAgentSession(sessionId, "Chat Stream Test");

        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/chat"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "text/event-stream")
                        .withBody("event: token\ndata: {\"content\":\"chunk-1\"}\n\n"
                                + "event: token\ndata: {\"content\":\"chunk-2\"}\n\n"
                                + "event: done\ndata: {\"type\":\"done\"}\n\n")));

        Map<String, Object> body = Map.of(
                "sessionId", sessionId,
                "content", "Execute this",
                "workspaceId", workspaceId,
                "userId", userId
        );

        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/chat"),
                HttpMethod.POST,
                entityWithAuth(body, token),
                Map.class);

        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        try { Thread.sleep(500); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/agent/chat"))
                .withHeader("Authorization", containing("Bearer dev-token-not-secure"))
                .withRequestBody(matchingJsonPath("$.stream", equalTo("true")))
                .withRequestBody(matchingJsonPath("$.runId")));
    }

    @Test
    void chatForwardsRunOverridesResolvedFromUserAndWorkspaceLayers() {
        String sessionId = UUID.randomUUID().toString();
        createAgentSession(sessionId, "Agent override test");
        UUID uid = UUID.fromString(userId);
        UUID wid = UUID.fromString(workspaceId);
        configService.putLayer("user", "llm-provider",
                Map.of("defaultModel", "mimo-v2.5"), "test", uid, null);
        configService.putLayer("user", "agent-profile",
                Map.of("userName", "Alice"), "test", uid, null);
        configService.putLayer("user", "rag",
                Map.of("chunkSize", "512"), "test", uid, null);
        configService.putLayer("user", "embedding",
                Map.of("model", "text-embedding-3-small", "dimensions", "1536"), "test", uid, null);
        configService.putLayer("workspace", "llm-provider",
                Map.of("temperature", "0.2"), "test", uid, wid);
        configService.putLayer("workspace", "agent-runtime",
                Map.of("useRegistry", "true"), "test", uid, wid);

        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/chat"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "text/event-stream")
                        .withBody("event: done\ndata: {\"type\":\"done\"}\n\n")));

        Map<String, Object> body = Map.of(
                "sessionId", sessionId,
                "content", "Hello overrides",
                "userId", userId,
                "workspaceId", workspaceId
        );

        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/chat"),
                HttpMethod.POST,
                entityWithAuth(body, token),
                Map.class);

        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        try { Thread.sleep(500); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }

        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/agent/chat"))
                .withRequestBody(matchingJsonPath(
                        "$.userOverrides['llm-provider'].defaultModel", equalTo("mimo-v2.5")))
                .withRequestBody(matchingJsonPath(
                        "$.userOverrides['agent-profile'].userName", equalTo("Alice")))
                .withRequestBody(matchingJsonPath(
                        "$.userOverrides['rag'].chunkSize", equalTo("512")))
                .withRequestBody(matchingJsonPath(
                        "$.userOverrides['embedding'].model", equalTo("text-embedding-3-small")))
                .withRequestBody(matchingJsonPath(
                        "$.workspaceOverrides['llm-provider'].temperature", equalTo("0.2")))
                .withRequestBody(matchingJsonPath(
                        "$.workspaceOverrides['agent-runtime'].useRegistry", equalTo("true"))));

        configService.deleteKey("user", "llm-provider", "defaultModel", "test", uid, null);
        configService.deleteKey("user", "agent-profile", "userName", "test", uid, null);
        configService.deleteKey("user", "rag", "chunkSize", "test", uid, null);
        configService.deleteKey("user", "embedding", "model", "test", uid, null);
        configService.deleteKey("workspace", "llm-provider", "temperature", "test", uid, wid);
        configService.deleteKey("workspace", "agent-runtime", "useRegistry", "test", uid, wid);
    }

    @Test
    void chatReturns202EvenWhenAgentFails() {
        String sessionId = UUID.randomUUID().toString();
        createAgentSession(sessionId, "Agent failure test");

        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/chat"))
                .willReturn(aResponse().withStatus(500)));

        Map<String, Object> body = Map.of(
                "sessionId", sessionId,
                "content", "Hi",
                "userId", userId,
                "workspaceId", workspaceId
        );

        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/chat"),
                HttpMethod.POST,
                entityWithAuth(body, token),
                Map.class);

        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        try { Thread.sleep(500); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/agent/chat")));
    }

    @Test
    void chatWithoutAuthReturns401() {
        Map<String, Object> body = Map.of("sessionId", "no-auth", "content", "Hello");

        ResponseEntity<Map> response = restTemplate.postForEntity(
                url("/api/v1/chat"), body, Map.class);

        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
    }

    private void createAgentSession(String sessionId, String title) {
        Session session = new Session(workspaceId, userId, title);
        session.setId(UUID.fromString(sessionId));
        session.setAgentPrincipalId(principalId);
        session.setAgentPermissionsSnapshot(principalPermissions.deepCopy());
        sessionRepository.saveAndFlush(session);
    }

    @TestConfiguration
    static class TestMockConfig {

        @Bean
        @Primary
        SseEmitterManager testSseEmitterManager() {
            return Mockito.mock(SseEmitterManager.class);
        }
    }
}
