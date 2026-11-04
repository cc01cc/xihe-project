package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ProviderConnection;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.service.AgentTemplateService;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.policy.ResourceGovernor;
import com.cc01cc.p.xihe.cp.policy.ResourceKey;
import com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.status.HealthMonitor;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0622 D28 (verify V7 / D14): an over-limit {@code POST /chat} is refused <b>on the request
 * thread</b> with {@code 429 RESOURCE_EXHAUSTED} — {@code Retry-After} header plus
 * {@code code/retryAfterSeconds/resourceKind/scope} in the body — instead of answering {@code 202}
 * and failing the run asynchronously.
 *
 * <p>Acceptance covered here, over a real servlet stack + Testcontainers PostgreSQL + the same fake
 * Agent used by {@link ChatIntegrationTest}:</p>
 * <ol>
 *   <li>two sessions sharing one {@code maxInflight=1} connection: the second submit is 429 and
 *       leaves <b>no</b> {@code chat_runs} row behind (R2);</li>
 *   <li>once the first run reaches its terminal state the slot is released, so a later submit is
 *       admitted again;</li>
 *   <li>the restart-recovery path ({@link ChatRunRecoveryService}) releases the slots it settles.</li>
 * </ol>
 */
class ChatAdmissionGovernorHttpTest extends AbstractIntegrationTest {

    private static HttpServer agentServer;
    private static final AtomicBoolean HOLD_CHAT_STREAM = new AtomicBoolean(false);
    private static final CountDownLatch RELEASE_HOLD = new CountDownLatch(1);

    @DynamicPropertySource
    static void configureAgent(DynamicPropertyRegistry registry) {
        try {
            agentServer = HttpServer.create(new InetSocketAddress(0), 0);
            agentServer.createContext("/internal/v1/agent/chat", exchange -> {
                exchange.getResponseHeaders().set("Content-Type", MediaType.TEXT_EVENT_STREAM_VALUE);
                if (HOLD_CHAT_STREAM.get()) {
                    exchange.sendResponseHeaders(200, 0);
                    try (OutputStream output = exchange.getResponseBody()) {
                        output.write("event: token\ndata: {\"content\":\"holding\"}\n\n"
                                .getBytes(StandardCharsets.UTF_8));
                        output.flush();
                        try {
                            RELEASE_HOLD.await(30, TimeUnit.SECONDS);
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                        }
                        output.write("event: done\ndata: {\"type\":\"done\"}\n\n"
                                .getBytes(StandardCharsets.UTF_8));
                    }
                    return;
                }
                byte[] response = ("event: token\ndata: {\"content\":\"admission-reply\"}\n\n"
                        + "event: done\ndata: {\"type\":\"done\"}\n\n").getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, response.length);
                try (OutputStream output = exchange.getResponseBody()) {
                    output.write(response);
                }
            });
            agentServer.createContext("/internal/v1/agent/runs", exchange -> {
                byte[] response = "{\"status\":\"accepted\"}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
                exchange.sendResponseHeaders(202, response.length);
                try (OutputStream output = exchange.getResponseBody()) {
                    output.write(response);
                }
            });
            agentServer.createContext("/internal/v1/agent/health", exchange -> {
                byte[] response = "{\"status\":\"ok\",\"liveness\":\"up\",\"llmReady\":\"ready\",\"configRevision\":\"admission-test\"}"
                        .getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
                exchange.sendResponseHeaders(200, response.length);
                try (OutputStream output = exchange.getResponseBody()) {
                    output.write(response);
                }
            });
            agentServer.setExecutor(Executors.newCachedThreadPool(runnable -> {
                Thread thread = new Thread(runnable, "chat-admission-agent");
                thread.setDaemon(true);
                return thread;
            }));
            agentServer.start();
        } catch (IOException e) {
            throw new ExceptionInInitializerError(e);
        }
        registry.add("cp.agent-url", () -> "http://localhost:" + agentServer.getAddress().getPort()
                + "/internal/v1/agent/chat");
    }

    @Autowired private UserRepository userRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private ProviderConnectionRepository connectionRepository;
    @Autowired private ProviderCredentialLeaseService credentialLeases;
    @Autowired private ChatRunRecoveryService chatRunRecoveryService;
    @Autowired private ResourceGovernor governor;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private JwtTokenProvider jwtTokenProvider;
    @Autowired private BranchPathService branchPathService;
    @Autowired private ApiRequestTemplateService requestTemplates;
    @Autowired private HealthMonitor healthMonitor;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private AgentPrincipalService agentPrincipalService;
    @Autowired private AgentTemplateService agentTemplateService;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;

    private final HttpClient http = HttpClient.newHttpClient();
    private final List<InputStream> openStreams = new ArrayList<>();

    private String authToken;
    private String userId;
    private String workspaceId;
    private String principalId;
    private com.fasterxml.jackson.databind.JsonNode principalPermissions;
    private ProviderConnection connection;
    private String firstSessionId;
    private String secondSessionId;

    @BeforeEach
    void setUp() throws Exception {
        healthMonitor.pollHealth();
        String email = "admission-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> registered = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                new RegisterRequest(email, TestDataFactory.PASSWORD, "AdmissionTest"), AuthResponse.class);
        assertEquals(201, registered.getStatusCode().value());
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(userId));
        workspaceId = workspace.getId().toString();
        workspaceFixture.bindWorkspaceRole(workspaceId, userId, WorkspaceRole.OWNER);
        authToken = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId, 0);
        var defaultTemplate = agentTemplateService.resolveForCreation(userId, workspaceId, null);
        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                userId, "AdmissionPrincipal", null, defaultTemplate.snapshot());
        principalId = principal.getId().toString();
        principalPermissions = principal.getTemplateSnapshot().get("permissions");
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(
                principalId, workspaceId, principalPermissions.deepCopy()));

        connection = createConnection("admission-" + UUID.randomUUID(), 1);
        firstSessionId = createBoundSession("First", connection);
        secondSessionId = createBoundSession("Second", connection);
        openSse(firstSessionId);
        openSse(secondSessionId);
    }

    @AfterEach
    void closeStreams() {
        HOLD_CHAT_STREAM.set(false);
        RELEASE_HOLD.countDown();
        for (InputStream stream : openStreams) {
            try {
                stream.close();
            } catch (IOException ignored) {
                // The test only needs the subscription dropped.
            }
        }
        openStreams.clear();
    }

    @AfterAll
    static void stopAgentServer() {
        if (agentServer != null) {
            agentServer.stop(0);
        }
    }

    @Test
    void secondConcurrentChatOnTheSameConnectionIsRefusedWith429AtAdmission() throws Exception {
        HOLD_CHAT_STREAM.set(true);

        ResponseEntity<Map> first = postChat(firstSessionId, "hold the only slot");
        assertEquals(HttpStatus.ACCEPTED.value(), first.getStatusCode().value(), body(first));
        String heldRunId = String.valueOf(first.getBody().get("runId"));

        ResponseEntity<Map> refused = postChat(secondSessionId, "must be refused at admission");

        assertEquals(HttpStatus.TOO_MANY_REQUESTS.value(), refused.getStatusCode().value(),
                "D28: the refusal must be the HTTP answer, not an asynchronous run failure: " + body(refused));
        Map<String, Object> problem = refused.getBody();
        assertNotNull(problem);
        assertEquals("RESOURCE_EXHAUSTED", problem.get("code"));
        assertEquals("CONNECTION", problem.get("resourceKind"));
        assertEquals("connection:" + connection.getId(), problem.get("scope"));
        assertTrue(((Number) problem.get("retryAfterSeconds")).intValue() >= 1);
        assertEquals(String.valueOf(problem.get("retryAfterSeconds")),
                refused.getHeaders().getFirst("Retry-After"), "header and body carry the same hint (R6)");
        assertEquals("no-store", refused.getHeaders().getFirst("Cache-Control"));
        assertFalse(chatRunRepository.existsBySessionId(secondSessionId),
                "R2: a refused request must not leave a run row behind");
        assertEquals(1, governor.inflight(ResourceKey.connection(connection.getId().toString())),
                "the first run still holds its admitted slot");

        // The held run terminalizes once the fake Agent finishes; its slots must come back.
        HOLD_CHAT_STREAM.set(false);
        RELEASE_HOLD.countDown();
        awaitTerminal(heldRunId);
        assertEquals(0, governor.inflight(ResourceKey.connection(connection.getId().toString())),
                "acceptance 3: the terminal path releases the admission slots");
        assertEquals(0, governor.inflightForRun(heldRunId));

        ResponseEntity<Map> admittedAgain = postChat(secondSessionId, "after the release");
        assertEquals(HttpStatus.ACCEPTED.value(), admittedAgain.getStatusCode().value(), body(admittedAgain));
        awaitTerminal(String.valueOf(admittedAgain.getBody().get("runId")));
    }

    @Test
    void restartRecoveryReleasesTheSlotsItSettles() {
        ProviderConnection recoveredConnection = createConnection("recovery-" + UUID.randomUUID(), 1);
        String sessionId = createBoundSession("Recovered", recoveredConnection);

        String runId = UUID.randomUUID().toString();
        ChatRun abandoned = new ChatRun(runId, sessionId, userId, workspaceId,
                "idem-" + UUID.randomUUID(), "hash", "custom-openai-compatible", "wire-model", "none", "running");
        chatRunRepository.saveAndFlush(abandoned);

        ProviderCredentialLeaseService.Admission admission = credentialLeases.admit(
                recoveredConnection.getId().toString(), "custom-openai-compatible", "wire-model", null);
        assertFalse(admission.isEmpty(), "the fixture connection is admit-able");
        governor.bindToRun(runId, admission.leases());
        ResourceKey key = ResourceKey.connection(recoveredConnection.getId().toString());
        assertEquals(1, governor.inflight(key));

        chatRunRecoveryService.reconcileOnStartup();

        assertEquals(0, governor.inflight(key),
                "acceptance 4: the restart-recovery terminal path releases the borrowed slots");
        assertEquals(0, governor.inflightForRun(runId));
        assertEquals("ambiguous", chatRunRepository.findById(UUID.fromString(runId)).orElseThrow().getStatus());
    }

    private ProviderConnection createConnection(String connectionKey, Integer maxInflight) {
        ProviderConnection created = ChatBindingTestSupport.ensureChatConnection(
                connectionRepository, "USER", userId, connectionKey);
        created.setMaxInflight(maxInflight);
        return connectionRepository.saveAndFlush(created);
    }

    private String createBoundSession(String title, ProviderConnection boundConnection) {
        String sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, title);
        session.setId(UUID.fromString(sessionId));
        session.setAgentPrincipalId(principalId);
        session.setAgentPermissionsSnapshot(principalPermissions.deepCopy());
        ChatBindingTestSupport.bind(session, boundConnection, requestTemplates);
        sessionRepository.saveAndFlush(session);
        branchPathService.ensureRootBranchId(sessionId);
        return sessionId;
    }

    private void openSse(String sessionId) throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/api/v1/events?sessionId=" + sessionId))
                .header("Authorization", "Bearer " + authToken)
                .header("Accept", MediaType.TEXT_EVENT_STREAM_VALUE)
                .GET()
                .build();
        HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
        assertEquals(HttpStatus.OK.value(), response.statusCode());
        openStreams.add(response.body());
    }

    private ResponseEntity<Map> postChat(String sessionId, String content) {
        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "branchId", branchPathService.ensureRootBranchId(sessionId),
                "content", content);
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(baseUrl + "/api/v1/chat", HttpMethod.POST,
                new HttpEntity<>(request, headers), Map.class);
    }

    private void awaitTerminal(String runId) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 15_000;
        while (System.currentTimeMillis() < deadline) {
            Integer terminal = jdbcTemplate.queryForObject(
                    "select count(*) from chat_runs where id = ? and terminal_at is not null",
                    Integer.class, UUID.fromString(runId));
            if (terminal != null && terminal > 0) {
                return;
            }
            Thread.sleep(50);
        }
        assertTrue(false, "run " + runId + " never reached a terminal state");
    }

    private static String body(ResponseEntity<Map> response) {
        return String.valueOf(response.getBody());
    }
}
