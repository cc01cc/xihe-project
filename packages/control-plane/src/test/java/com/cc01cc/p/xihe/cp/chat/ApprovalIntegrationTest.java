package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ApprovalIntegrationTest extends AbstractIntegrationTest {

    private static HttpServer agentServer;
    private static final AtomicReference<Integer> AGENT_DECISION_STATUS = new AtomicReference<>(200);
    private static final AtomicReference<String> AGENT_DECISION_AUTH = new AtomicReference<>("");

    @Autowired
    private UserRepository userRepository;

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

    @Autowired
    private ApprovalService approvalService;

    private String authToken;
    private String userId;
    private String workspaceId;
    private String sessionId;
    private String runId;
    private String requestId;

    @DynamicPropertySource
    static void configureAgent(DynamicPropertyRegistry registry) {
        try {
            agentServer = HttpServer.create(new InetSocketAddress(0), 0);
            agentServer.createContext("/internal/v1/agent/approval/respond", exchange -> {
                String auth = exchange.getRequestHeaders().getFirst("Authorization");
                AGENT_DECISION_AUTH.set(auth == null ? "" : auth);
                byte[] body = "{\"status\":\"accepted\"}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
                exchange.sendResponseHeaders(AGENT_DECISION_STATUS.get(), body.length);
                try (OutputStream output = exchange.getResponseBody()) {
                    output.write(body);
                }
            });
            agentServer.createContext("/internal/v1/agent/health", exchange -> {
                byte[] body = "{\"status\":\"ok\",\"liveness\":\"up\",\"llmReady\":\"ready\",\"configRevision\":\"test-revision\"}"
                        .getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
                exchange.sendResponseHeaders(200, body.length);
                try (OutputStream output = exchange.getResponseBody()) {
                    output.write(body);
                }
            });
            agentServer.start();
        } catch (IOException e) {
            throw new ExceptionInInitializerError(e);
        }
        registry.add("cp.agent-base-url", () -> "http://localhost:" + agentServer.getAddress().getPort());
    }

    @AfterAll
    static void stopAgentServer() {
        if (agentServer != null) {
            agentServer.stop(0);
        }
    }

    @BeforeEach
    void setUp() {
        AGENT_DECISION_STATUS.set(200);
        String email = "approval-int-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "ApprovalIntTest");
        ResponseEntity<AuthResponse> regResponse = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        authToken = regResponse.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        Workspace ws = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId)).stream().findFirst().orElseThrow();
        workspaceId = ws.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        authToken = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId);

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "Approval Integration");
        session.setId(UUID.fromString(sessionId));
        sessionRepository.save(session);

        runId = UUID.randomUUID().toString();
        requestId = UUID.randomUUID().toString();
    }

    private ChatRun activeRun(String status) {
        ChatRun run = new ChatRun(runId, sessionId, userId, workspaceId,
                "idem-" + UUID.randomUUID(), "hash", "openai", "gpt-test", "workspace", status);
        return chatRunRepository.save(run);
    }

    private ChatApproval pendingApproval(String reqId, Instant expiresAt) {
        ChatApproval approval = new ChatApproval(reqId, runId, sessionId, userId, workspaceId,
                "request_approval", "delete file", "README.md", "pending", expiresAt);
        return approvalRepository.save(approval);
    }

    private ResponseEntity<Map> decide(String reqId, boolean approved) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(
                baseUrl + "/api/v1/chat/approvals/" + reqId + "/decision",
                HttpMethod.POST, new HttpEntity<>(Map.of("approved", approved), headers), Map.class);
    }

    private RestTemplate noErrorClient() {
        RestTemplate client = new RestTemplate();
        client.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(HttpStatusCode statusCode) {
                return false;
            }
        });
        return client;
    }

    @Test
    void recordPendingPersistsApprovalForActiveRun() {
        activeRun("running");

        approvalService.recordPending(Map.of(
                        "requestId", requestId,
                        "runId", runId,
                        "sessionId", sessionId,
                        "action", "delete file",
                        "details", "README.md",
                        "expiresAt", Instant.now().plusSeconds(300).toString()),
                sessionId, runId, userId, workspaceId);

        ChatApproval saved = approvalRepository.findById(UUID.fromString(requestId)).orElseThrow();
        assertEquals("pending", saved.getState());
        assertEquals(runId, saved.getRunId());
        assertEquals("delete file", saved.getAction());
        assertNotNull(saved.getExpiresAt());
    }

    @Test
    void replayReturnsOnlyLivePendingApprovalsForOwnedSession() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().plusSeconds(300));
        String expiredId = UUID.randomUUID().toString();
        pendingApproval(expiredId, Instant.now().minusSeconds(1));
        String decidedId = UUID.randomUUID().toString();
        ChatApproval decided = new ChatApproval(
                decidedId, runId, sessionId, userId, workspaceId,
                "request_approval", "delete file", "README.md", "approved", Instant.now().plusSeconds(300));
        approvalRepository.save(decided);

        List<Map<String, Object>> replay = approvalService.replayPending(sessionId, userId, workspaceId);

        assertEquals(1, replay.size());
        assertEquals(requestId, replay.get(0).get("requestId").toString());
        assertEquals(Boolean.TRUE, replay.get(0).get("replayed"));
    }

    @Test
    void decideApprovesAndPersistsAfterAgentAccepts() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().plusSeconds(300));

        ResponseEntity<Map> response = decide(requestId, true);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("accepted", response.getBody().get("status"));
        ChatApproval saved = approvalRepository.findById(UUID.fromString(requestId)).orElseThrow();
        assertEquals("approved", saved.getState());
        assertTrue(saved.getApproved());
        assertNotNull(saved.getDecidedAt());
        assertTrue(AGENT_DECISION_AUTH.get().startsWith("Bearer "));
    }

    @Test
    void decideIsIdempotentForSameDecision() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().plusSeconds(300));
        decide(requestId, true);

        ResponseEntity<Map> second = decide(requestId, true);

        assertEquals(HttpStatus.OK, second.getStatusCode());
        assertEquals("accepted", second.getBody().get("status"));
        assertEquals("approved", approvalRepository.findById(UUID.fromString(requestId)).orElseThrow().getState());
    }

    @Test
    void decideConflictsOnDifferentDecision() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().plusSeconds(300));
        decide(requestId, true);

        ResponseEntity<Map> conflict = decide(requestId, false);

        assertEquals(HttpStatus.CONFLICT, conflict.getStatusCode());
        assertEquals("APPROVAL_DECISION_CONFLICT", conflict.getBody().get("code"));
    }

    @Test
    void decideReturns410ForExpiredApproval() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().minusSeconds(1));

        ResponseEntity<Map> response = noErrorClient().exchange(
                baseUrl + "/api/v1/chat/approvals/" + requestId + "/decision",
                HttpMethod.POST,
                authorizedBody(true),
                Map.class);

        assertEquals(HttpStatus.GONE, response.getStatusCode());
        assertEquals("APPROVAL_EXPIRED", response.getBody().get("code"));
    }

    @Test
    void decideReturns404ForUnknownApproval() {
        ResponseEntity<Map> response = noErrorClient().exchange(
                baseUrl + "/api/v1/chat/approvals/" + UUID.randomUUID() + "/decision",
                HttpMethod.POST,
                authorizedBody(true),
                Map.class);

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
        assertEquals("APPROVAL_NOT_FOUND", response.getBody().get("code"));
    }

    private HttpEntity<Map<String, Object>> authorizedBody(boolean approved) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return new HttpEntity<>(Map.of("approved", approved), headers);
    }

    @Test
    void decideEnforcesOwnerBinding() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().plusSeconds(300));
        String otherEmail = "approval-other-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(otherEmail, TestDataFactory.PASSWORD, "Other");
        ResponseEntity<AuthResponse> reg = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        User otherUser = userRepository.findByEmail(otherEmail).orElseThrow();
        String otherTokenScoped = jwtTokenProvider.createAccessToken(
                otherUser.getId().toString(), otherEmail, "USER", workspaceId);

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(otherTokenScoped);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat/approvals/" + requestId + "/decision",
                HttpMethod.POST, new HttpEntity<>(Map.of("approved", true), headers), Map.class);

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
        assertEquals("pending", approvalRepository.findById(UUID.fromString(requestId)).orElseThrow().getState());
    }

    @Test
    void decidePersistsDispatchUnknownWhenAgentFails() {
        activeRun("running");
        pendingApproval(requestId, Instant.now().plusSeconds(300));
        AGENT_DECISION_STATUS.set(500);

        ResponseEntity<Map> response = noErrorClient().exchange(
                baseUrl + "/api/v1/chat/approvals/" + requestId + "/decision",
                HttpMethod.POST, authorizedBody(true), Map.class);

        assertEquals(HttpStatus.BAD_GATEWAY, response.getStatusCode());
    }
}
