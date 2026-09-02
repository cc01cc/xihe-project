package com.cc01cc.p.xihe.cp.chat;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.*;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;

import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class ChatIntegrationTest extends AbstractIntegrationTest {

    private static HttpServer agentServer;
    private static int agentPort;
    private static final ExecutorService SSE_READERS = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "chat-integration-sse-reader");
        thread.setDaemon(true);
        return thread;
    });

    @Autowired
    private MessageRepository messageRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    private String authToken;
    private String userId;
    private String workspaceId;
    private HttpResponse<InputStream> sseResponse;
    private Future<?> sseReader;
    private final AtomicInteger doneEvents = new AtomicInteger();
    private final StringBuilder sseTranscript = new StringBuilder();

    @DynamicPropertySource
    static void configureAgent(DynamicPropertyRegistry registry) {
        try {
            agentServer = HttpServer.create(new InetSocketAddress(0), 0);
            agentPort = agentServer.getAddress().getPort();
            agentServer.createContext("/internal/v1/agent/chat", exchange -> {
                byte[] response = ("event: token\n"
                        + "data: {\"content\":\"integration-reply\"}\n\n"
                        + "event: done\n"
                        + "data: {\"type\":\"done\"}\n\n")
                        .getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", MediaType.TEXT_EVENT_STREAM_VALUE);
                exchange.sendResponseHeaders(200, response.length);
                try (OutputStream output = exchange.getResponseBody()) {
                    output.write(response);
                }
            });
            agentServer.createContext("/internal/v1/agent/health", exchange -> {
                byte[] response = "{\"status\":\"ok\"}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
                exchange.sendResponseHeaders(200, response.length);
                try (OutputStream output = exchange.getResponseBody()) {
                    output.write(response);
                }
            });
            agentServer.start();
        } catch (IOException e) {
            throw new ExceptionInInitializerError(e);
        }
        registry.add("cp.agent-url", () -> "http://localhost:" + agentPort + "/internal/v1/agent/chat");
    }

    @BeforeEach
    void setUp() {
        String email = "chat-int-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "ChatIntTest");
        ResponseEntity<AuthResponse> regResponse = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        authToken = regResponse.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId();
        Workspace ws = workspaceRepository.save(new Workspace("test-workspace", userId));
        workspaceId = ws.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        authToken = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId);
    }

    @AfterEach
    void closeSse() throws IOException {
        if (sseResponse != null) {
            sseResponse.body().close();
            sseResponse = null;
        }
        if (sseReader != null) {
            sseReader.cancel(true);
            sseReader = null;
        }
    }

    @AfterAll
    static void stopAgentServer() {
        if (agentServer != null) {
            agentServer.stop(0);
        }
        SSE_READERS.shutdownNow();
    }

    @Test
    void postChatWithoutAuthReturns401() {
        Map<String, Object> request = Map.of(
                "sessionId", "no-auth-session",
                "content", "Hello"
        );

        ResponseEntity<Map> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/chat", request, Map.class);

        assertEquals(HttpStatus.UNAUTHORIZED.value(), response.getStatusCode().value());
    }

    @Test
    void postChatWithAuthReturnsAccepted() {
        String sessionId = "auth-session-" + UUID.randomUUID().toString().substring(0, 8);
        createSession(sessionId);
        openSse(sessionId);
        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "content", "Hello, this is a test message",
                "userId", userId,
                "workspaceId", workspaceId
        );

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(request, headers);

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST, entity, Map.class);

        assertEquals(HttpStatus.ACCEPTED.value(), response.getStatusCode().value());
        Map<String, Object> body = response.getBody();
        assertNotNull(body);
        assertEquals("accepted", body.get("status"));
        assertEquals(sessionId, body.get("sessionId"));
        assertNotNull(body.get("messageId"));
        assertNotNull(body.get("runId"));
    }

    @Test
    void messageIsPersistedToDatabase() {
        String sessionId = "persist-session-" + UUID.randomUUID().toString().substring(0, 8);
        createSession(sessionId);
        openSse(sessionId);
        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "content", "This message must be persisted",
                "userId", userId,
                "workspaceId", workspaceId
        );

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(request, headers);

        restTemplate.exchange(baseUrl + "/api/v1/chat", HttpMethod.POST, entity, Map.class);

        awaitMessageCount(sessionId, 2);
        List<Message> messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId);
        assertFalse(messages.isEmpty());

        Message msg = messages.stream()
                .filter(message -> message.getRole() == MessageRole.USER)
                .findFirst()
                .orElseThrow();
        assertEquals("This message must be persisted", msg.getContent());
        assertEquals(MessageRole.USER, msg.getRole());
        assertEquals(sessionId, msg.getSessionId());
        assertNotNull(msg.getId());
        assertNotNull(msg.getCreatedAt());
    }

    @Test
    void postChatTwiceAfterDoneKeepsSessionSse() {
        String sessionId = "repeat-session-" + UUID.randomUUID().toString().substring(0, 8);
        createSession(sessionId);
        openSse(sessionId);

        ResponseEntity<Map> first = postChat(sessionId, "first message");
        assertEquals(HttpStatus.ACCEPTED, first.getStatusCode());
        awaitMessageCount(sessionId, 2);
        awaitDoneEvents(1);

        ResponseEntity<Map> second = postChat(sessionId, "second message");
        assertEquals(HttpStatus.ACCEPTED, second.getStatusCode());
        awaitMessageCount(sessionId, 4);
        awaitDoneEvents(2);

        List<Message> messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId);
        assertEquals(2, messages.stream().filter(message -> message.getRole() == MessageRole.USER).count());
        assertEquals(2, messages.stream().filter(message -> message.getRole() == MessageRole.ASSISTANT).count());
        synchronized (sseTranscript) {
            assertTrue(countSseEvents("token") >= 2);
            assertTrue(countSseEvents("done") >= 2);
        }
    }

    private int countSseEvents(String expectedName) {
        int count = 0;
        for (String line : sseTranscript.toString().split("\\R")) {
            if (line.startsWith("event:")
                    && expectedName.equals(line.substring("event:".length()).trim())) {
                count++;
            }
        }
        return count;
    }

    private void createSession(String sessionId) {
        Session session = new Session(workspaceId, userId, "Integration Chat");
        session.setId(sessionId);
        sessionRepository.save(session);
    }

    private ResponseEntity<Map> postChat(String sessionId, String content) {
        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "content", content,
                "workspaceId", workspaceId,
                "userId", userId
        );
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST,
                new HttpEntity<>(request, headers), Map.class);
    }

    private void openSse(String sessionId) {
        try {
            doneEvents.set(0);
            synchronized (sseTranscript) {
                sseTranscript.setLength(0);
            }
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/api/v1/events?sessionId=" + sessionId))
                    .header("Authorization", "Bearer " + authToken)
                    .header("Accept", MediaType.TEXT_EVENT_STREAM_VALUE)
                    .GET()
                    .build();
            sseResponse = HttpClient.newHttpClient()
                    .sendAsync(request, HttpResponse.BodyHandlers.ofInputStream())
                    .get(5, TimeUnit.SECONDS);
            assertEquals(HttpStatus.OK.value(), sseResponse.statusCode());
            InputStream stream = sseResponse.body();
            sseReader = SSE_READERS.submit(() -> {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        synchronized (sseTranscript) {
                            sseTranscript.append(line).append('\n');
                        }
                        if (line.startsWith("event:")
                                && "done".equals(line.substring("event:".length()).trim())) {
                            doneEvents.incrementAndGet();
                        }
                    }
                } catch (IOException ignored) {
                    // The test closes the stream after assertions.
                }
            });
        } catch (Exception e) {
            throw new AssertionError("SSE connection should be established", e);
        }
    }

    private void awaitDoneEvents(int expected) {
        long deadline = System.currentTimeMillis() + 5000;
        while (System.currentTimeMillis() < deadline) {
            if (doneEvents.get() >= expected) {
                return;
            }
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AssertionError("Interrupted while waiting for SSE done event", e);
            }
        }
        fail("Expected at least " + expected + " SSE done events, got " + doneEvents.get());
    }

    private void awaitMessageCount(String sessionId, int expected) {
        long deadline = System.currentTimeMillis() + 5000;
        while (System.currentTimeMillis() < deadline) {
            if (messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId).size() >= expected) {
                return;
            }
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AssertionError("Interrupted while waiting for messages", e);
            }
        }
        fail("Expected at least " + expected + " messages");
    }
}
