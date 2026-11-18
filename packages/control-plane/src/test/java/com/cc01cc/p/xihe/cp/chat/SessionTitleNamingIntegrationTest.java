package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
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
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.service.AgentPrincipalService;
import com.cc01cc.p.xihe.cp.service.AgentTemplateService;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.status.HealthMonitor;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.RestTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;

import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * D-1866 / task-24 acceptance on a real stack: real CP (real HTTP + real JWT), real PostgreSQL
 * (Testcontainers template database), real admission transaction and row lock. Only the Agent hop
 * is a stub, and it records every request so "naming cost no model call" is checkable.
 *
 * <p>Acceptance ① is the first test (new Session ⇒ first message ⇒ title changes). ② is
 * {@link #manualRenameOutranksTheFirstMessage()}. ③ is
 * {@link #markersOnlyFirstMessageKeepsTheDefaultTitle()}. ④ has its own unit battery in
 * {@link SessionTitleRuleTest} plus the emoji round-trip here. ⑤ is
 * {@link #namingAddsNoExtraAgentOrModelCall()}.
 */
class SessionTitleNamingIntegrationTest extends AbstractIntegrationTest {

    /** Exactly what the UI sends as {@code title} on create (i18n {@code workspace.sessionDefaultTitle}). */
    private static final String UI_DEFAULT_TITLE = "\u672a\u547d\u540d\u4f1a\u8bdd";

    private static final List<String> AGENT_CHAT_REQUESTS =
            Collections.synchronizedList(new ArrayList<>());
    private static HttpServer agentServer;

    @DynamicPropertySource
    static void configureAgent(DynamicPropertyRegistry registry) {
        try {
            agentServer = HttpServer.create(new InetSocketAddress(0), 0);
            int port = agentServer.getAddress().getPort();
            agentServer.createContext("/internal/v1/agent/chat", exchange -> {
                AGENT_CHAT_REQUESTS.add(new String(exchange.getRequestBody().readAllBytes(),
                        StandardCharsets.UTF_8));
                byte[] response = ("event: token\ndata: {\"content\":\"integration-reply\"}\n\n"
                        + "event: done\ndata: {\"type\":\"done\"}\n\n")
                        .getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", MediaType.TEXT_EVENT_STREAM_VALUE);
                exchange.sendResponseHeaders(200, response.length);
                try (OutputStream output = exchange.getResponseBody()) {
                    output.write(response);
                }
            });
            agentServer.createContext("/internal/v1/agent/health", exchange -> {
                byte[] response = ("{\"status\":\"ok\",\"liveness\":\"up\",\"llmReady\":\"ready\","
                        + "\"configRevision\":\"title-naming-test\"}")
                        .getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
                exchange.sendResponseHeaders(200, response.length);
                try (OutputStream output = exchange.getResponseBody()) {
                    output.write(response);
                }
            });
            agentServer.setExecutor(Executors.newCachedThreadPool(runnable -> {
                Thread thread = new Thread(runnable, "title-naming-agent");
                thread.setDaemon(true);
                return thread;
            }));
            agentServer.start();
            registry.add("cp.agent-url", () -> "http://localhost:" + port + "/internal/v1/agent/chat");
            registry.add("cp.agent-base-url", () -> "http://localhost:" + port);
        } catch (IOException cause) {
            throw new ExceptionInInitializerError(cause);
        }
    }

    @AfterAll
    static void stopAgent() {
        if (agentServer != null) {
            agentServer.stop(0);
        }
    }

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceFixture workspaceFixture;

    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;

    @Autowired
    private AgentPrincipalService agentPrincipalService;

    @Autowired
    private AgentTemplateService agentTemplateService;

    @Autowired
    private ProviderConnectionRepository providerConnectionRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private BranchPathService branchPathService;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @Autowired
    private HealthMonitor healthMonitor;

    @Autowired
    private SseEmitterManager sseEmitterManager;

    /** PATCH needs a client factory that supports it; the base RestTemplate uses the JDK default. */
    private RestTemplate patchClient;

    private String authToken;
    private String userId;
    private String workspaceId;
    private String principalId;
    private ProviderConnection chatConnection;

    @BeforeEach
    void setUp() {
        healthMonitor.pollHealth();
        AGENT_CHAT_REQUESTS.clear();
        // POST /chat refuses with 409 SSE_SUBSCRIPTION_REQUIRED unless the session has a live
        // emitter; the naming path is independent of the stream, so stub the subscription.
        when(sseEmitterManager.hasEmitter(anyString())).thenReturn(true);
        patchClient = new RestTemplate(new JdkClientHttpRequestFactory());
        String email = "title-naming-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> registration = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                new RegisterRequest(email, TestDataFactory.PASSWORD, "TitleNamingTest"), AuthResponse.class);
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(userId));
        workspaceId = workspace.getId().toString();
        workspaceFixture.bindWorkspaceRole(workspaceId, userId, WorkspaceRole.OWNER);
        authToken = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId, 0);
        var template = agentTemplateService.resolveForCreation(userId, workspaceId, null);
        AgentPrincipal principal = agentPrincipalService.createPrincipal(
                userId, "TitleNamingPrincipal", null, template.snapshot());
        principalId = principal.getId().toString();
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principalId, workspaceId,
                principal.getTemplateSnapshot().get("permissions").deepCopy()));
        chatConnection = ChatBindingTestSupport.ensureChatConnection(
                providerConnectionRepository, "USER", userId, "title-naming-chat");
    }

    @Test
    void firstUserMessageNamesTheSession() {
        String sessionId = createSessionThroughHttp(UI_DEFAULT_TITLE);
        assertEquals(UI_DEFAULT_TITLE, durableTitle(sessionId), "a fresh Session keeps the UI default");

        ResponseEntity<Map> response = postChat(sessionId, "## 部署脚本怎么跑？");
        assertTrue(response.getStatusCode().is2xxSuccessful(),
                "POST /api/v1/chat answered " + response.getStatusCode() + " " + response.getBody());

        assertEquals("部署脚本怎么跑？", durableTitle(sessionId),
                "the first user message must name the Session (markdown heading stripped)");
    }

    @Test
    void manualRenameOutranksTheFirstMessage() {
        String sessionId = createSessionThroughHttp(UI_DEFAULT_TITLE);
        ResponseEntity<Map> renamed = patchClient.exchange(url("/api/v1/sessions/" + sessionId),
                HttpMethod.PATCH, authorized(Map.of("title", "我的手工会话")), Map.class);
        assertTrue(renamed.getStatusCode().is2xxSuccessful(), "rename answered " + renamed.getStatusCode());
        assertEquals("我的手工会话", durableTitle(sessionId));

        ResponseEntity<Map> response = postChat(sessionId, "## 会被忽略的标题");
        assertTrue(response.getStatusCode().is2xxSuccessful(), "POST /api/v1/chat " + response.getStatusCode());

        assertEquals("我的手工会话", durableTitle(sessionId),
                "hard constraint ①: a manual rename is never overwritten by auto-naming");
    }

    @Test
    void markersOnlyFirstMessageKeepsTheDefaultTitle() {
        String sessionId = createSessionThroughHttp(UI_DEFAULT_TITLE);

        ResponseEntity<Map> response = postChat(sessionId, "###");
        assertTrue(response.getStatusCode().is2xxSuccessful(), "POST /api/v1/chat " + response.getStatusCode());

        assertEquals(UI_DEFAULT_TITLE, durableTitle(sessionId),
                "hard constraint: pure markup must not produce an empty title");
    }

    @Test
    void cjkAndEmojiTruncateWithoutHalfACharacter() {
        String sessionId = createSessionThroughHttp(UI_DEFAULT_TITLE);
        String content = "\ud83d\udc4d".repeat(30) + "\u4e2d".repeat(10);

        ResponseEntity<Map> response = postChat(sessionId, content);
        assertTrue(response.getStatusCode().is2xxSuccessful(), "POST /api/v1/chat " + response.getStatusCode());

        String title = durableTitle(sessionId);
        assertEquals("\ud83d\udc4d".repeat(24) + "\u2026", title);
        assertNoLoneSurrogate(title);
    }

    @Test
    void namingAddsNoExtraAgentOrModelCall() {
        // Differential, not absolute: dispatch retries are unrelated to naming and would make a
        // fixed "one call per message" count flaky. What matters is that deriving a title costs
        // nothing extra — so the same message is sent twice under the two naming outcomes and the
        // Agent call counts must be equal. A model-based naming step would make the rule-named
        // session strictly more expensive than the hand-named one.
        String marker = "rule-naming-cost-probe";
        String namedByRule = createSessionThroughHttp(UI_DEFAULT_TITLE);
        postChat(namedByRule, "## " + marker);
        assertEquals(marker, durableTitle(namedByRule));

        String namedByHand = createSessionThroughHttp(UI_DEFAULT_TITLE);
        patchClient.exchange(url("/api/v1/sessions/" + namedByHand), HttpMethod.PATCH,
                authorized(Map.of("title", "手工会话")), Map.class);
        postChat(namedByHand, "## " + marker);

        try {
            org.awaitility.Awaitility.await().atMost(java.time.Duration.ofSeconds(10))
                    .until(() -> dispatchesFor(namedByRule, marker) >= 1
                            && dispatchesFor(namedByHand, marker) >= 1);
        } catch (org.awaitility.core.ConditionTimeoutException timeout) {
            throw new AssertionError("expected a dispatch per message, saw rule="
                    + dispatchesFor(namedByRule, marker) + " hand=" + dispatchesFor(namedByHand, marker),
                    timeout);
        }
        // Same content, same provider/model, same agent: the two submissions must cost the same
        // number of Agent calls. A model-based naming step would add one to the rule-named side
        // (the CP itself has no provider client — see SessionTitleNoModelCallTest).
        assertEquals(dispatchesFor(namedByHand, marker), dispatchesFor(namedByRule, marker),
                "rule naming must not add an Agent call");
        assertFalse(AGENT_CHAT_REQUESTS.stream().anyMatch(body ->
                        body.contains("\"namingPrompt\"") || body.contains("summarise the message")
                                || body.contains("\"titleDerivation\"")),
                "no naming prompt may reach the Agent");
    }

    /** Agent dispatches for one session carrying this exact message text (retries included). */
    private long dispatchesFor(String sessionId, String marker) {
        synchronized (AGENT_CHAT_REQUESTS) {
            return AGENT_CHAT_REQUESTS.stream()
                    .filter(body -> body.contains(marker) && body.contains(sessionId))
                    .count();
        }
    }

    private String createSessionThroughHttp(String title) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", title);
        body.put("agentPrincipalId", principalId);
        body.put("providerConnectionId", chatConnection.getId().toString());
        body.put("modelProvider", chatConnection.getProviderId());
        body.put("modelName", "gpt-4o-mini");
        ResponseEntity<Map> created = restTemplate.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/sessions"),
                HttpMethod.POST, authorized(body), Map.class);
        assertTrue(created.getStatusCode().is2xxSuccessful(),
                "POST /api/v1/workspaces/{id}/sessions answered " + created.getStatusCode() + " " + created.getBody());
        return String.valueOf(created.getBody().get("id"));
    }

    private ResponseEntity<Map> postChat(String sessionId, String content) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sessionId", sessionId);
        body.put("branchId", branchPathService.ensureRootBranchId(sessionId));
        body.put("content", content);
        return restTemplate.exchange(url("/api/v1/chat"), HttpMethod.POST, authorized(body), Map.class);
    }

    private String durableTitle(String sessionId) {
        Session session = sessionRepository.findById(UUID.fromString(sessionId)).orElseThrow();
        return session.getTitle();
    }

    private HttpEntity<Map<String, Object>> authorized(Map<String, Object> body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(authToken);
        headers.set("X-Workspace-Id", workspaceId);
        return new HttpEntity<>(body, headers);
    }

    /** The SSE subscription gate belongs to the transport, not to naming. */
    @TestConfiguration
    static class SseStubConfiguration {

        @Bean
        @Primary
        SseEmitterManager stubSseEmitterManager() {
            return mock(SseEmitterManager.class);
        }
    }

    private static void assertNoLoneSurrogate(String text) {
        for (int index = 0; index < text.length(); index++) {
            char current = text.charAt(index);
            if (Character.isHighSurrogate(current)) {
                assertTrue(index + 1 < text.length() && Character.isLowSurrogate(text.charAt(index + 1)),
                        "lone high surrogate at " + index);
                index++;
            } else {
                assertFalse(Character.isLowSurrogate(current), "lone low surrogate at " + index);
            }
        }
    }
}
