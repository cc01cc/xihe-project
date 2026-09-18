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
import com.cc01cc.p.xihe.cp.status.HealthMonitor;
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
    /** PLAN-0352：假 Agent 可被切到“持有流直到取消”模式（删除在飞 run 的终态投递证据）。 */
    private static final java.util.concurrent.atomic.AtomicBoolean HOLD_CHAT_STREAM =
            new java.util.concurrent.atomic.AtomicBoolean(false);
    private static volatile java.util.concurrent.CountDownLatch cancelSignal =
            new java.util.concurrent.CountDownLatch(1);

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

    @Autowired
    private HealthMonitor healthMonitor;

    @Autowired
    private SseEmitterManager sseEmitterManager;

    private String authToken;
    private String userId;
    private String workspaceId;
    private HttpResponse<InputStream> sseResponse;
    private Future<?> sseReader;
    private final AtomicInteger doneEvents = new AtomicInteger();
    private final StringBuilder sseTranscript = new StringBuilder();
    private final java.util.concurrent.atomic.AtomicBoolean sseClosed =
            new java.util.concurrent.atomic.AtomicBoolean(false);

    @DynamicPropertySource
    static void configureAgent(DynamicPropertyRegistry registry) {
        try {
            agentServer = HttpServer.create(new InetSocketAddress(0), 0);
            agentPort = agentServer.getAddress().getPort();
            agentServer.createContext("/internal/v1/agent/chat", exchange -> {
                if (HOLD_CHAT_STREAM.get()) {
                    exchange.getResponseHeaders().set("Content-Type", MediaType.TEXT_EVENT_STREAM_VALUE);
                    exchange.sendResponseHeaders(200, 0);
                    try (OutputStream output = exchange.getResponseBody()) {
                        output.write("event: token\ndata: {\"content\":\"holding\"}\n\n"
                                .getBytes(StandardCharsets.UTF_8));
                        output.flush();
                        try {
                            cancelSignal.await(15, TimeUnit.SECONDS);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        output.write(("event: error\n"
                                + "data: {\"code\":\"cancelled\",\"detail\":\"Run cancelled\",\"retryable\":false,\"outcome\":\"error\",\"type\":\"error\"}\n\n"
                                + "event: done\n"
                                + "data: {\"type\":\"done\",\"outcome\":\"error\",\"errorCode\":\"cancelled\"}\n\n")
                                .getBytes(StandardCharsets.UTF_8));
                    }
                    return;
                }
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
            agentServer.createContext("/internal/v1/agent/runs", exchange -> {
                cancelSignal.countDown();
                byte[] response = "{\"status\":\"accepted\"}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
                exchange.sendResponseHeaders(202, response.length);
                try (OutputStream output = exchange.getResponseBody()) {
                    output.write(response);
                }
            });
            agentServer.createContext("/internal/v1/agent/health", exchange -> {
                byte[] response = "{\"status\":\"ok\",\"liveness\":\"up\",\"llmReady\":\"ready\",\"configRevision\":\"test-revision\"}"
                        .getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
                exchange.sendResponseHeaders(200, response.length);
                try (OutputStream output = exchange.getResponseBody()) {
                    output.write(response);
                }
            });
            // 默认 executor 为单线程（start() 线程）：持有的流会阻塞取消请求，必须并发处理。
            agentServer.setExecutor(Executors.newCachedThreadPool(runnable -> {
                Thread thread = new Thread(runnable, "chat-integration-agent");
                thread.setDaemon(true);
                return thread;
            }));
            agentServer.start();
        } catch (IOException e) {
            throw new ExceptionInInitializerError(e);
        }
        registry.add("cp.agent-url", () -> "http://localhost:" + agentPort + "/internal/v1/agent/chat");
    }

    @BeforeEach
    void setUp() {
        healthMonitor.pollHealth();
        String email = "chat-int-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "ChatIntTest");
        ResponseEntity<AuthResponse> regResponse = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        authToken = regResponse.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        Workspace ws = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId)).stream().findFirst().orElseThrow();
        workspaceId = ws.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        authToken = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId);
    }

    @AfterEach
    void closeSse() throws IOException {
        HOLD_CHAT_STREAM.set(false);
        cancelSignal.countDown();
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
                "sessionId", "aaaaaaad-0000-0000-0000-000000000000",
                "content", "Hello"
        );

        ResponseEntity<Map> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/chat", request, Map.class);

        assertEquals(HttpStatus.UNAUTHORIZED.value(), response.getStatusCode().value());
    }

    @Test
    void postChatWithAuthReturnsAccepted() {
        String sessionId = UUID.randomUUID().toString();
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
        String sessionId = UUID.randomUUID().toString();
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
        String sessionId = UUID.randomUUID().toString();
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

    /**
     * PLAN-0352 V1（无在飞 run）：删除成功后服务端 `complete`，会话 SSE 连接结束、
     * 无重连所需的错误事件、emitter 注销。
     */
    @Test
    void deleteSessionWithoutInFlightRunClosesSse() {
        String sessionId = UUID.randomUUID().toString();
        createSession(sessionId);
        openSse(sessionId);
        assertTrue(awaitSseEventCount("connected", 1, 3000), "SSE must be connected first");

        ResponseEntity<Void> response = deleteSession(sessionId);
        assertEquals(HttpStatus.NO_CONTENT, response.getStatusCode());

        assertTrue(awaitSseClosed(3000), "server must complete the session SSE after delete");
        assertFalse(sseEmitterManager.hasEmitter(sessionId), "emitter must be unregistered");
        synchronized (sseTranscript) {
            assertEquals(0, countSseEvents("error"), "active delete must not emit error events");
        }
        assertTrue(sessionRepository.findById(UUID.fromString(sessionId)).isEmpty());
    }

    /**
     * PLAN-0352 V1（有在飞 run）：删除先取消 → 终态序列（error code=cancelled + done）
     * 投递到会话 SSE → relay 终结（releaseRun）后删除事务 → complete；客户端先收到
     * 终态再看到连接结束，不产生悬挂流式状态。
     */
    @Test
    void deleteSessionWithInFlightRunDeliversCancelledTerminalThenClosesSse() {
        HOLD_CHAT_STREAM.set(true);
        cancelSignal = new java.util.concurrent.CountDownLatch(1);
        try {
            String sessionId = UUID.randomUUID().toString();
            createSession(sessionId);
            openSse(sessionId);
            ResponseEntity<Map> chat = postChat(sessionId, "hold this run");
            assertEquals(HttpStatus.ACCEPTED, chat.getStatusCode());
            assertTrue(awaitSseEventCount("token", 1, 5000), "relay must be in-flight before delete");

            ResponseEntity<Void> response = deleteSession(sessionId);
            assertEquals(HttpStatus.NO_CONTENT, response.getStatusCode());

            assertTrue(awaitSseEventCount("error", 1, 5000),
                    "cancelled terminal error must reach the session SSE before close");
            assertTrue(awaitSseEventCount("done", 1, 5000),
                    "terminal done must reach the session SSE before close");
            assertTrue(awaitSseClosed(5000), "connection must end after terminal delivery");
            assertFalse(sseEmitterManager.hasEmitter(sessionId), "emitter must be unregistered");
            synchronized (sseTranscript) {
                String transcript = sseTranscript.toString();
                assertTrue(transcript.contains("\"code\":\"cancelled\""), transcript);
                assertTrue(transcript.indexOf("event:error") < transcript.indexOf("event:done"),
                        "terminal sequence must be error before done: " + transcript);
            }
            assertTrue(sessionRepository.findById(UUID.fromString(sessionId)).isEmpty());
        } finally {
            HOLD_CHAT_STREAM.set(false);
            cancelSignal.countDown();
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

    private ResponseEntity<Void> deleteSession(String sessionId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        return restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionId,
                HttpMethod.DELETE, new HttpEntity<>(headers), Void.class);
    }

    private boolean awaitSseEventCount(String eventName, int expected, long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            synchronized (sseTranscript) {
                if (countSseEvents(eventName) >= expected) {
                    return true;
                }
            }
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AssertionError("Interrupted while waiting for SSE event " + eventName, e);
            }
        }
        synchronized (sseTranscript) {
            return countSseEvents(eventName) >= expected;
        }
    }

    private boolean awaitSseClosed(long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (sseClosed.get()) {
                return true;
            }
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AssertionError("Interrupted while waiting for SSE close", e);
            }
        }
        return sseClosed.get();
    }

    private void createSession(String sessionId) {
        Session session = new Session(workspaceId, userId, "Integration Chat");
        session.setId(UUID.fromString(sessionId));
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
            sseClosed.set(false);
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
                } finally {
                    sseClosed.set(true);
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
