package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.service.AgentTemplateService;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.status.HealthMonitor;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.RestTemplate;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/**
 * PLAN-0348 M1 negative tests (verification, not new implementation): a
 * Session's Workspace binding is immutable, and a client-supplied
 * {@code workspaceId} is always ignored — the effective Workspace is derived
 * from the tenant token. See {@code spec/session/chat-session.md} clauses 1–2.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("h2")
class SessionWorkspaceBindingNegativeTest extends AbstractH2Test {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ProviderConnectionRepository providerConnectionRepository;

    @Autowired
    private ApiRequestTemplateService apiRequestTemplates;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @Autowired
    private AgentPrincipalService agentPrincipalService;

    @Autowired
    private AgentTemplateService agentTemplateService;

    @Autowired
    private BranchPathService branchPathService;

    @Autowired
    private HealthMonitor healthMonitor;

    @Autowired
    private SseEmitterManager sseEmitterManager;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @LocalServerPort
    private int serverPort;

    private static HttpServer agentServer;
    private static int agentPort;
    private static final AtomicReference<String> AGENT_HEALTH = new AtomicReference<>(
            "{\"status\":\"ok\",\"liveness\":\"up\",\"llmReady\":\"ready\",\"configRevision\":\"test-revision\"}");

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        try {
            agentServer = HttpServer.create(new InetSocketAddress(0), 0);
            agentServer.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
            agentServer.createContext("/internal/v1/agent/health", exchange -> {
                byte[] body = AGENT_HEALTH.get().getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
                exchange.sendResponseHeaders(200, body.length);
                try (OutputStream output = exchange.getResponseBody()) {
                    output.write(body);
                }
            });
            agentServer.start();
            agentPort = agentServer.getAddress().getPort();
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
        registry.add("cp.agent-url", () -> "http://localhost:" + agentPort + "/internal/v1/agent/chat");
    }

    private String userId;
    private String email;
    private String workspaceA;
    private String workspaceB;
    private String tokenA;
    private String tokenB;
    private String sessionA;
    private String branchId;
    private RestTemplate patchClient;

    @BeforeEach
    void setUp() throws IOException {
        this.baseUrl = "http://localhost:" + serverPort;
        this.restTemplate = new RestTemplate();
        restTemplate.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.client.ClientHttpResponse response) throws IOException {
                HttpStatus status = HttpStatus.resolve(response.getStatusCode().value());
                return status != null && status.is5xxServerError();
            }
        });
        patchClient = new RestTemplate(new JdkClientHttpRequestFactory());
        patchClient.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.client.ClientHttpResponse response) throws IOException {
                HttpStatus status = HttpStatus.resolve(response.getStatusCode().value());
                return status != null && status.is5xxServerError();
            }
        });
        when(sseEmitterManager.hasEmitter(anyString())).thenReturn(true);
        healthMonitor.pollHealth();

        email = "plan0348-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        restTemplate.postForEntity(baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "P0348"), AuthResponse.class);
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();

        // Workspace A owns the Session; Workspace B is a foreign Workspace of the same user.
        Workspace a = workspaceRepository.save(new Workspace("plan0348-a", userId));
        workspaceA = a.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceA, userId, WorkspaceRole.OWNER));
        Workspace b = workspaceRepository.save(new Workspace("plan0348-b", userId));
        workspaceB = b.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceB, userId, WorkspaceRole.OWNER));

        tokenA = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceA);
        tokenB = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceB);

        ProviderConnection chatConnection = ChatBindingTestSupport.ensureChatConnection(
                providerConnectionRepository, "USER", userId, "plan-0348");
        var defaultTemplate = agentTemplateService.resolveForCreation(userId, workspaceA, null);
        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                userId, "PLAN-0348 principal", null, defaultTemplate.snapshot());
        var permissions = principal.getTemplateSnapshot().get("permissions");
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(
                principal.getId().toString(), workspaceA, permissions.deepCopy()));

        sessionA = UUID.randomUUID().toString();
        Session session = new Session(workspaceA, userId, "PLAN-0348 session");
        session.setId(UUID.fromString(sessionA));
        session.setAgentPrincipalId(principal.getId().toString());
        session.setAgentPermissionsSnapshot(permissions.deepCopy());
        ChatBindingTestSupport.bind(session, chatConnection, apiRequestTemplates);
        sessionRepository.save(session);
        branchId = branchPathService.ensureRootBranchId(sessionA);
    }

    /** V1a: a token scoped to another Workspace cannot mutate the Session. */
    @Test
    void patchSession_crossWorkspaceToken_returns404() {
        HttpHeaders headers = bearer(tokenB);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> response = patchClient.exchange(
                baseUrl + "/api/v1/sessions/" + sessionA, HttpMethod.PATCH,
                new HttpEntity<>(Map.of("title", "rebind attempt"), headers), Map.class);
        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
        assertEquals("SESSION_NOT_FOUND", response.getBody().get("code"));
        assertEquals(workspaceA, currentSessionWorkspace(sessionA));
    }

    /** V1a: the cross-Workspace token cannot delete the Session either. */
    @Test
    void deleteSession_crossWorkspaceToken_returns404() {
        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionA, HttpMethod.DELETE,
                new HttpEntity<>(bearer(tokenB)), Map.class);
        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
        assertEquals("SESSION_NOT_FOUND", response.getBody().get("code"));
        assertTrue(sessionRepository.findById(UUID.fromString(sessionA)).isPresent());
    }

    /** V1b: a body-supplied workspaceId has no field to land in and is ignored. */
    @Test
    void patchSession_bodyWorkspaceIdIsIgnored() {
        HttpHeaders headers = bearer(tokenA);
        headers.setContentType(MediaType.APPLICATION_JSON);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", "renamed");
        body.put("workspaceId", workspaceB);
        ResponseEntity<Map> response = patchClient.exchange(
                baseUrl + "/api/v1/sessions/" + sessionA, HttpMethod.PATCH,
                new HttpEntity<>(body, headers), Map.class);
        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(workspaceA, response.getBody().get("workspaceId"));
        assertEquals(workspaceA, currentSessionWorkspace(sessionA));
    }

    /** V2: ChatRun Workspace comes from the Session, never the request body. */
    @Test
    void chatRun_workspaceIsDerivedFromSessionNotRequestBody() {
        HttpHeaders headers = bearer(tokenA);
        headers.setContentType(MediaType.APPLICATION_JSON);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sessionId", sessionA);
        body.put("branchId", branchId);
        body.put("content", "workspace must come from the session");
        body.put("workspaceId", workspaceB);
        body.put("userId", userId);
        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST, new HttpEntity<>(body, headers), Map.class);
        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        String runId = (String) response.getBody().get("runId");
        assertNotNull(runId);
        assertEquals(workspaceA, jdbcTemplate.queryForObject(
                "SELECT CAST(workspace_id AS VARCHAR) FROM chat_runs WHERE id = CAST(? AS UUID)",
                String.class, runId));
    }

    private HttpHeaders bearer(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private String currentSessionWorkspace(String sessionId) {
        return jdbcTemplate.queryForObject(
                "SELECT CAST(workspace_id AS VARCHAR) FROM sessions WHERE id = CAST(? AS UUID)",
                String.class, sessionId);
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
