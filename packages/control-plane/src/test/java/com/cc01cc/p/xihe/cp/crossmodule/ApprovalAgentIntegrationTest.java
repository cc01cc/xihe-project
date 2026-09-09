package com.cc01cc.p.xihe.cp.crossmodule;

import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.containing;
import static com.github.tomakehurst.wiremock.client.WireMock.equalToJson;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.junit.jupiter.api.Assertions.assertEquals;

class ApprovalAgentIntegrationTest extends AbstractWireMockTest {

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private ChatApprovalRepository approvalRepository;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    private String token;
    private String userId;
    private String workspaceId;
    private String sessionId;
    private String runId;
    private String requestId;

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("cp.agent-base-url", () -> "http://localhost:" + wireMock.port());
    }

    @BeforeEach
    void setUp() {
        super.setUp();
        wireMock.resetAll();
        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/approval/respond"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"status\":\"accepted\"}")));
        token = registerAndLogin();

        userId = jwtTokenProvider.getUserIdFromToken(token);
        Workspace ws = new Workspace("Approval Agent Test", userId);
        ws = workspaceRepository.save(ws);
        workspaceId = ws.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        token = jwtTokenProvider.createAccessToken(userId, jwtTokenProvider.getEmailFromToken(token), "USER", workspaceId);

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "Approval Agent Test");
        session.setId(UUID.fromString(sessionId));
        sessionRepository.save(session);

        runId = UUID.randomUUID().toString();
        requestId = UUID.randomUUID().toString();
    }

    private ChatRun activeRun() {
        ChatRun run = new ChatRun(runId, sessionId, userId, workspaceId,
                "idem-" + UUID.randomUUID(), "hash", "openai", "gpt-test", "workspace", "running");
        return chatRunRepository.save(run);
    }

    private ChatApproval pendingApproval() {
        ChatApproval approval = new ChatApproval(requestId, runId, sessionId, userId, workspaceId,
                "request_approval", "delete file", "README.md", "pending", Instant.now().plusSeconds(300), null, null);
        return approvalRepository.save(approval);
    }

    private ResponseEntity<Map> decide(boolean approved) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return noErrorClient().exchange(
                url("/api/v1/chat/approvals/" + requestId + "/decision"),
                HttpMethod.POST, new HttpEntity<>(Map.of("approved", approved), headers), Map.class);
    }

    private org.springframework.web.client.RestTemplate noErrorClient() {
        org.springframework.web.client.RestTemplate client = new org.springframework.web.client.RestTemplate();
        client.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.HttpStatusCode statusCode) {
                return false;
            }
        });
        return client;
    }

    @Test
    void decisionForwardsBearerAndPayloadToAgentAndPersistsApproved() {
        activeRun();
        pendingApproval();

        ResponseEntity<Map> response = decide(true);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("accepted", response.getBody().get("status"));
        wireMock.verify(postRequestedFor(urlEqualTo("/internal/v1/agent/approval/respond"))
                .withHeader("Authorization", containing("Bearer dev-token-not-secure"))
                .withHeader("Content-Type", containing("application/json"))
                .withRequestBody(equalToJson("{\"requestId\":\"" + requestId + "\",\"approved\":true}")));
        assertEquals("approved", approvalRepository.findById(UUID.fromString(requestId)).orElseThrow().getState());
    }

    @Test
    void decisionPersistsRejectedOnAgentAcceptedRejection() {
        activeRun();
        pendingApproval();

        ResponseEntity<Map> response = decide(false);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("rejected", approvalRepository.findById(UUID.fromString(requestId)).orElseThrow().getState());
    }

    @Test
    void agent5xxPersistsDispatchUnknown() {
        activeRun();
        pendingApproval();
        wireMock.resetAll();
        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/approval/respond"))
                .willReturn(aResponse().withStatus(500)));

        ResponseEntity<Map> response = decide(true);

        assertEquals(HttpStatus.BAD_GATEWAY, response.getStatusCode());
    }

    @Test
    void agentConnectionFailurePersistsDispatchUnknown() {
        activeRun();
        pendingApproval();
        wireMock.resetAll();
        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/approval/respond"))
                .willReturn(aResponse().withFault(com.github.tomakehurst.wiremock.http.Fault.CONNECTION_RESET_BY_PEER)));

        ResponseEntity<Map> response = decide(true);

        assertEquals(HttpStatus.BAD_GATEWAY, response.getStatusCode());
    }

    @Test
    void retryAfterDispatchUnknownSucceedsWhenAgentRecovers() {
        activeRun();
        pendingApproval();
        wireMock.resetAll();
        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/approval/respond"))
                .willReturn(aResponse().withStatus(500)));

        ResponseEntity<Map> first = decide(true);
        assertEquals(HttpStatus.BAD_GATEWAY, first.getStatusCode());
        assertEquals("dispatch_unknown",
                approvalRepository.findById(UUID.fromString(requestId)).orElseThrow().getState());

        wireMock.resetAll();
        wireMock.stubFor(post(urlEqualTo("/internal/v1/agent/approval/respond"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"status\":\"accepted\"}")));

        ResponseEntity<Map> second = decide(true);
        assertEquals(HttpStatus.OK, second.getStatusCode());
        assertEquals("approved",
                approvalRepository.findById(UUID.fromString(requestId)).orElseThrow().getState());
    }

    @Test
    void malformedRequestIdReturns400ProblemDetails() {
        ResponseEntity<Map> response = noErrorClient().exchange(
                url("/api/v1/chat/approvals/not-a-uuid/decision"),
                HttpMethod.POST, entityWithAuth(Map.of("approved", true), token), Map.class);

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        assertEquals("INVALID_REQUEST", response.getBody().get("code"));
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
