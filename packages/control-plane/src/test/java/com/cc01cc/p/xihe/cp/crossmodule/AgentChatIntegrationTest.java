package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
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
    private JwtTokenProvider jwtTokenProvider;

    private String token;
    private String workspaceId;

    @BeforeEach
    void setUp() {
        super.setUp();
        token = registerAndLogin();

        String userId = jwtTokenProvider.getUserIdFromToken(token);
        Workspace ws = new Workspace("Agent Test", userId);
        ws = workspaceRepository.save(ws);
        workspaceId = ws.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        token = jwtTokenProvider.createAccessToken(userId, jwtTokenProvider.getEmailFromToken(token), "USER", workspaceId);

        assertTrue(workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(workspaceId, userId).isPresent(),
                "Workspace user should be created");

        when(sseEmitterManager.hasEmitter(anyString())).thenReturn(true);
    }

    @Test
    void chatForwardsToAgentWithCorrectHeadersAndBody() {
        String sessionId = "chat-" + UUID.randomUUID().toString().substring(0, 8);

        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/chat"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "text/event-stream")
                        .withBody("event: done\ndata: {\"content\":\"Hello!\"}\n\n")));

        Map<String, Object> body = Map.of(
                "sessionId", sessionId,
                "content", "Hello",
                "userId", "test-user",
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
                .withRequestBody(matchingJsonPath("$.stream")));
    }

    @Test
    void chatReturns202EvenWhenAgentFails() {
        String sessionId = "fail-" + UUID.randomUUID().toString().substring(0, 8);

        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/chat"))
                .willReturn(aResponse().withStatus(500)));

        Map<String, Object> body = Map.of(
                "sessionId", sessionId,
                "content", "Hi",
                "userId", "test-user",
                "workspaceId", workspaceId
        );

        ResponseEntity<Map> response = restTemplate.exchange(
                url("/api/v1/chat"),
                HttpMethod.POST,
                entityWithAuth(body, token),
                Map.class);

        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/agent/chat")));
    }

    @Test
    void chatWithoutAuthReturns401() {
        Map<String, Object> body = Map.of("sessionId", "no-auth", "content", "Hello");

        ResponseEntity<Map> response = restTemplate.postForEntity(
                url("/api/v1/chat"), body, Map.class);

        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
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
