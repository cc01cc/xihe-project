package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.*;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.RestTemplate;
import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.repository.SessionOperationRepository;
import com.cc01cc.p.xihe.cp.status.HealthMonitor;
import com.cc01cc.p.xihe.cp.operation.OperationService;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("h2")
class ChatControllerTest extends AbstractH2Test {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private MessageRepository messageRepository;

    @Autowired
    private FileRepository fileRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private SessionOperationRepository sessionOperationRepository;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.OperationItemRepository operationItemRepository;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.OperationExtensionRepository operationExtensionRepository;

    @Autowired
    private OperationService operationService;

    @Autowired
    private SseEmitterManager sseEmitterManager;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @Autowired
    private HealthMonitor healthMonitor;

    @LocalServerPort
    private int serverPort;

    private static HttpServer agentServer;
    private static int agentPort;
    private static final AtomicReference<String> AGENT_HEALTH = new AtomicReference<>(
            "{\"status\":\"ok\",\"liveness\":\"up\",\"llmReady\":\"ready\",\"configRevision\":\"test-revision\"}");
    private static final AtomicReference<Boolean> AGENT_AVAILABLE = new AtomicReference<>(true);

    private String authToken;
    private String userId;
    private String workspaceId;
    private String sessionId;

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        try {
            agentServer = HttpServer.create(new InetSocketAddress(0), 0);
            agentServer.createContext("/internal/v1/agent/health", exchange -> {
                if (!AGENT_AVAILABLE.get()) {
                    exchange.sendResponseHeaders(503, -1);
                    exchange.close();
                    return;
                }
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

    @BeforeEach
    void setUp() throws IOException {
        this.baseUrl = "http://localhost:" + serverPort;
        this.restTemplate = new RestTemplate();
        restTemplate.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.client.ClientHttpResponse response) throws java.io.IOException {
                HttpStatus status = HttpStatus.resolve(response.getStatusCode().value());
                return status != null && status.is5xxServerError();
            }
        });

        when(sseEmitterManager.hasEmitter(anyString())).thenReturn(true);
        AGENT_AVAILABLE.set(true);
        healthMonitor.pollHealth();

        String email = "chat-ctrl-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> reg = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", new RegisterRequest(email, TestDataFactory.PASSWORD, "ChatCtrl"), AuthResponse.class);
        authToken = reg.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        Workspace ws = workspaceRepository.save(new Workspace("chat-test-workspace", userId));
        workspaceId = ws.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        authToken = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId);

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "Chat Test");
        session.setId(UUID.fromString(sessionId));
        sessionRepository.save(session);
    }

    @AfterEach
    void tearDown() throws IOException {
        String basePath = System.getProperty("java.io.tmpdir") + "/xihe-test/attachments";
        Path root = Path.of(basePath);
        if (Files.exists(root)) {
            Files.walk(root).sorted((a, b) -> -a.compareTo(b)).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException e) {
                    // ignore cleanup errors
                }
            });
        }
        if (agentServer != null) {
            try {
                agentServer.removeContext("/internal/v1/agent/chat");
            } catch (IllegalArgumentException e) {
                // context may not exist; ignore
            }
        }
    }

    @Test
    void chat_withAttachments_persistsMessageAndUpdatesFiles() throws IOException {
        java.io.File tempFile = java.io.File.createTempFile("chat", ".txt");
        Files.write(tempFile.toPath(), "attachment content".getBytes());
        com.cc01cc.p.xihe.cp.entity.File file = new com.cc01cc.p.xihe.cp.entity.File(userId, "chat.txt", tempFile.getAbsolutePath());
        file.setWorkspaceId(workspaceId);
        file.setSessionId(sessionId);
        file.setMimeType("text/plain");
        file.setSizeBytes(tempFile.length());
        file = fileRepository.save(file);

        String sseBody = "event: token\ndata: {\"content\":\"hello\"}\n\n"
                + "event: done\ndata: {\"type\":\"done\",\"outcome\":\"success\"}\n\n";
        agentServer.createContext("/internal/v1/agent/chat", exchange -> {
            try {
                exchange.getResponseHeaders().set("Content-Type", MediaType.TEXT_EVENT_STREAM_VALUE);
                exchange.sendResponseHeaders(200, 0);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(sseBody.getBytes());
                }
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        });

        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "content", "Message with attachment",
                "workspaceId", workspaceId,
                "userId", userId,
                "attachments", List.of(file.getId())
        );
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(request, headers);

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST, entity, Map.class);

        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        assertEquals("accepted", response.getBody().get("status"));

        // Wait for async persistence
        List<Message> messages = pollMessages(5000);
        assertFalse(messages.isEmpty());
        Message userMsg = messages.stream().filter(m -> m.getRole() == MessageRole.USER).findFirst().orElseThrow();
        assertEquals("Message with attachment", userMsg.getContent());
        assertNotNull(userMsg.getAttachments());
        assertTrue(userMsg.getAttachments().contains(file.getId().toString()));

        com.cc01cc.p.xihe.cp.entity.File updated = fileRepository.findById(file.getId()).orElseThrow();
        assertEquals(userMsg.getId().toString(), updated.getMessageId());

        Message assistantMsg = messages.stream().filter(m -> m.getRole() == MessageRole.ASSISTANT).findFirst().orElse(null);
        assertNotNull(assistantMsg, "Assistant reply should be persisted");
        assertEquals("hello", assistantMsg.getContent());
        ChatRun run = chatRunRepository.findById(UUID.fromString((String) response.getBody().get("runId"))).orElseThrow();
        assertEquals("succeeded", run.getStatus());
        assertEquals("success", run.getTerminalOutcome());
        assertEquals(userMsg.getId().toString(), run.getUserMessageId());
        assertEquals(assistantMsg.getId().toString(), run.getAssistantMessageId());
        String operationId = (String) response.getBody().get("operationId");
        assertNotNull(operationId);
        assertEquals(operationId, sessionOperationRepository.findByRunId(run.getId().toString()).orElseThrow().getId().toString());
        assertEquals("completed", sessionOperationRepository.findByRunId(run.getId().toString()).orElseThrow().getStatus());
    }

    @Test
    void chat_whenLlmIsNotReady_returns503BeforePersisting() {
        AGENT_HEALTH.set("{\"status\":\"degraded\",\"liveness\":\"up\",\"llmReady\":\"missing_credentials\",\"configRevision\":\"test-revision\"}");
        try {
            healthMonitor.pollHealth();
            long before = messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId).size();

            Map<String, Object> request = Map.of(
                    "sessionId", sessionId,
                    "content", "This must not be persisted",
                    "workspaceId", workspaceId,
                    "userId", userId
            );
            HttpHeaders headers = new HttpHeaders();
            headers.setBearerAuth(authToken);
            headers.setContentType(MediaType.APPLICATION_JSON);
            RestTemplate noErrorClient = new RestTemplate();
            noErrorClient.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
                @Override
                public boolean hasError(HttpStatusCode statusCode) {
                    return false;
                }
            });
            ResponseEntity<Map> response = noErrorClient.exchange(
                    baseUrl + "/api/v1/chat", HttpMethod.POST,
                    new HttpEntity<>(request, headers), Map.class);

            assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode());
            assertEquals("LLM_NOT_CONFIGURED", response.getBody().get("code"));
            assertEquals(before, messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId).size());
        } finally {
            AGENT_HEALTH.set("{\"status\":\"ok\",\"liveness\":\"up\",\"llmReady\":\"ready\",\"configRevision\":\"test-revision\"}");
            AGENT_AVAILABLE.set(true);
            healthMonitor.pollHealth();
        }
    }

    @Test
    void chat_whenAgentIsDownAndLastReadinessWasNotReady_doesNotQueue() {
        AGENT_HEALTH.set("{\"status\":\"degraded\",\"liveness\":\"up\",\"llmReady\":\"missing_credentials\",\"configRevision\":\"test-revision\"}");
        try {
            healthMonitor.pollHealth();
            AGENT_AVAILABLE.set(false);
            healthMonitor.pollHealth();
            long before = messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId).size();

            Map<String, Object> request = Map.of(
                    "sessionId", sessionId,
                    "content", "This must not be queued",
                    "workspaceId", workspaceId,
                    "userId", userId
            );
            HttpHeaders headers = new HttpHeaders();
            headers.setBearerAuth(authToken);
            headers.setContentType(MediaType.APPLICATION_JSON);
            RestTemplate noErrorClient = new RestTemplate();
            noErrorClient.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
                @Override
                public boolean hasError(HttpStatusCode statusCode) {
                    return false;
                }
            });

            ResponseEntity<Map> response = noErrorClient.exchange(
                    baseUrl + "/api/v1/chat", HttpMethod.POST,
                    new HttpEntity<>(request, headers), Map.class);

            assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode());
            assertEquals("LLM_NOT_CONFIGURED", response.getBody().get("code"));
            assertEquals(before, messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId).size());
        } finally {
            AGENT_HEALTH.set("{\"status\":\"ok\",\"liveness\":\"up\",\"llmReady\":\"ready\",\"configRevision\":\"test-revision\"}");
            AGENT_AVAILABLE.set(true);
            healthMonitor.pollHealth();
        }
    }

    @Test
    void chat_repeatedIdempotencyKeyDoesNotStartSecondRun() throws IOException, InterruptedException {
        AtomicReference<Integer> agentCalls = new AtomicReference<>(0);
        agentServer.createContext("/internal/v1/agent/chat", exchange -> {
            agentCalls.updateAndGet(value -> value + 1);
            byte[] body = ("event: token\ndata: {\"content\":\"once\"}\n\n"
                    + "event: done\ndata: {\"type\":\"done\",\"outcome\":\"success\"}\n\n")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", MediaType.TEXT_EVENT_STREAM_VALUE);
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream output = exchange.getResponseBody()) {
                output.write(body);
            }
        });

        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "content", "Idempotent message",
                "workspaceId", workspaceId,
                "userId", userId
        );
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("Idempotency-Key", "idempotency-test-key");

        ResponseEntity<Map> first = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST,
                new HttpEntity<>(request, headers), Map.class);
        ResponseEntity<Map> second = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST,
                new HttpEntity<>(request, headers), Map.class);

        assertEquals(HttpStatus.ACCEPTED, first.getStatusCode());
        assertEquals(HttpStatus.ACCEPTED, second.getStatusCode());
        assertEquals(first.getBody().get("runId"), second.getBody().get("runId"));
        assertEquals(first.getBody().get("operationId"), second.getBody().get("operationId"));
        Thread.sleep(500);
        assertEquals(1, agentCalls.get());
        assertEquals("succeeded", chatRunRepository.findById(UUID.fromString((String) first.getBody().get("runId"))).orElseThrow().getStatus());

        Map<String, Object> conflictingRequest = Map.of(
                "sessionId", sessionId,
                "content", "A different payload",
                "workspaceId", workspaceId,
                "userId", userId
        );
        ResponseEntity<Map> conflict = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST,
                new HttpEntity<>(conflictingRequest, headers), Map.class);
        assertEquals(HttpStatus.CONFLICT, conflict.getStatusCode());
        assertEquals("IDEMPOTENCY_KEY_CONFLICT", conflict.getBody().get("code"));
    }

    @Test
    void chat_toolEventsCreateLedgerItemAndAgentAttempt() throws IOException, InterruptedException {
        String toolCallId = UUID.randomUUID().toString();
        String sseBody = "event: tool_call\ndata: {\"type\":\"tool_call\",\"tool\":\"read_file\",\"arguments\":{\"path\":\"README.md\"},\"run_id\":\""
                + toolCallId + "\"}\n\n"
                + "event: tool_result\ndata: {\"type\":\"tool_result\",\"tool\":\"read_file\",\"result\":\"content\",\"run_id\":\""
                + toolCallId + "\"}\n\n"
                + "event: token\ndata: {\"content\":\"done\"}\n\n"
                + "event: done\ndata: {\"type\":\"done\",\"outcome\":\"success\"}\n\n";
        agentServer.createContext("/internal/v1/agent/chat", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", MediaType.TEXT_EVENT_STREAM_VALUE);
            exchange.sendResponseHeaders(200, sseBody.getBytes(StandardCharsets.UTF_8).length);
            try (OutputStream output = exchange.getResponseBody()) {
                output.write(sseBody.getBytes(StandardCharsets.UTF_8));
            }
        });

        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "content", "Read a file",
                "workspaceId", workspaceId,
                "userId", userId
        );
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST,
                new HttpEntity<>(request, headers), Map.class);

        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        pollMessages(5000);
        UUID operationId = UUID.fromString((String) response.getBody().get("operationId"));
        Map<String, Object> trace = operationService.getOperationTrace(operationId);
        List<?> items = (List<?>) trace.get("items");
        List<?> attempts = (List<?>) trace.get("attempts");
        assertEquals(1, items.size());
        assertEquals("completed", ((com.cc01cc.p.xihe.cp.entity.OperationItem) items.get(0)).getStatus());
        assertEquals(1, attempts.size());
        assertEquals("succeeded", ((com.cc01cc.p.xihe.cp.entity.OperationAttempt) attempts.get(0)).getStatus());
    }

    @Test
    void chat_whenAgentStreamEndsWithoutDone_marksRunAmbiguousAndDoesNotRetry() throws IOException, InterruptedException {
        AtomicReference<Integer> agentCalls = new AtomicReference<>(0);
        agentServer.createContext("/internal/v1/agent/chat", exchange -> {
            agentCalls.updateAndGet(value -> value + 1);
            byte[] body = "event: token\ndata: {\"content\":\"possibly charged\"}\n\n"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", MediaType.TEXT_EVENT_STREAM_VALUE);
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream output = exchange.getResponseBody()) {
                output.write(body);
            }
        });

        String idempotencyKey = "ambiguous-stream-key";
        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "content", "May have executed",
                "workspaceId", workspaceId,
                "userId", userId
        );
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("Idempotency-Key", idempotencyKey);

        ResponseEntity<Map> first = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST,
                new HttpEntity<>(request, headers), Map.class);
        assertEquals(HttpStatus.ACCEPTED, first.getStatusCode());

        List<Message> messages = pollMessages(5000);
        assertTrue(messages.stream().anyMatch(message -> "possibly charged".equals(message.getContent())));
        ChatRun run = chatRunRepository.findById(UUID.fromString((String) first.getBody().get("runId"))).orElseThrow();
        assertEquals("ambiguous", run.getStatus());
        assertEquals("ambiguous", run.getTerminalOutcome());

        ResponseEntity<Map> duplicate = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST,
                new HttpEntity<>(request, headers), Map.class);
        assertEquals(HttpStatus.ACCEPTED, duplicate.getStatusCode());
        assertEquals(first.getBody().get("runId"), duplicate.getBody().get("runId"));
        assertEquals(1, agentCalls.get());
    }

    @Test
    void chat_forwardsAttachmentsToAgent() throws IOException, InterruptedException {
        java.io.File tempFile = java.io.File.createTempFile("agent", ".png");
        Files.write(tempFile.toPath(), "img".getBytes());
        com.cc01cc.p.xihe.cp.entity.File file = new com.cc01cc.p.xihe.cp.entity.File(userId, "agent.png", tempFile.getAbsolutePath());
        file.setWorkspaceId(workspaceId);
        file.setSessionId(sessionId);
        file.setMimeType("image/png");
        file.setSizeBytes(tempFile.length());
        file = fileRepository.save(file);

        final String[] capturedBody = new String[1];
        final String[] capturedUserId = new String[1];
        final String[] capturedWorkspaceId = new String[1];
        final String[] capturedSessionId = new String[1];
        agentServer.createContext("/internal/v1/agent/chat", exchange -> {
            try {
                capturedBody[0] = new String(exchange.getRequestBody().readAllBytes());
                capturedUserId[0] = exchange.getRequestHeaders().getFirst("X-User-Id");
                capturedWorkspaceId[0] = exchange.getRequestHeaders().getFirst("X-Workspace-Id");
                capturedSessionId[0] = exchange.getRequestHeaders().getFirst("X-Session-Id");
                exchange.getResponseHeaders().set("Content-Type", MediaType.TEXT_EVENT_STREAM_VALUE);
                exchange.sendResponseHeaders(200, 0);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write("data: {\"content\":\"ok\"}\n\n".getBytes());
                }
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        });

        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "content", "Please analyze",
                "workspaceId", workspaceId,
                "userId", userId,
                "attachments", List.of(file.getId())
        );
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(request, headers);

        restTemplate.exchange(baseUrl + "/api/v1/chat", HttpMethod.POST, entity, Map.class);

        // Wait for request to be captured
        long deadline = System.currentTimeMillis() + 5000;
        while (capturedBody[0] == null && System.currentTimeMillis() < deadline) {
            Thread.sleep(100);
        }
        assertNotNull(capturedBody[0], "Agent request body should be captured");
        Map<String, Object> agentRequest = objectMapper.readValue(capturedBody[0], Map.class);
        assertTrue(agentRequest.containsKey("attachments"));
        List<Map<String, Object>> attachments = (List<Map<String, Object>>) agentRequest.get("attachments");
        assertEquals(1, attachments.size());
        assertEquals(file.getId().toString(), attachments.get(0).get("fileId"));
        assertEquals("/api/v1/files/" + file.getId(), attachments.get(0).get("url"));
        assertEquals(userId, agentRequest.get("userId"));
        assertEquals(userId, capturedUserId[0]);
        assertEquals(workspaceId, agentRequest.get("workspaceId"));
        assertEquals(workspaceId, capturedWorkspaceId[0]);
        assertEquals(sessionId, capturedSessionId[0]);
    }

    @TestConfiguration
    static class TestMockConfig {

        @Bean
        @Primary
        SseEmitterManager testSseEmitterManager() {
            return Mockito.mock(SseEmitterManager.class);
        }
    }

    private List<Message> pollMessages(long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            List<Message> messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId);
            if (messages.size() >= 2) {
                return messages;
            }
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        return messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId);
    }

    @Test
    void chat_withUsageEvent_persistsExtensionAndWritesTokenCount() throws IOException {
        // PLAN-294 M1 (decisions #13/#14): the relay must intercept the
        // agent's usage event, persist it as an llm_usage extension, and
        // write chat_runs.token_count from usage.totalTokens instead of the
        // SSE chunk counter. This path was silently blocked by the
        // operation_items.kind CHECK until V10 — guard it here.
        String sseBody = "event: token\ndata: {\"content\":\"hi\"}\n\n"
                + "event: usage\ndata: {\"usage\":{\"inputTokens\":120,\"outputTokens\":30,\"totalTokens\":150,"
                + "\"estimatedInputTokens\":140,\"source\":\"real\"}}\n\n"
                + "event: done\ndata: {\"type\":\"done\",\"outcome\":\"success\"}\n\n";
        agentServer.createContext("/internal/v1/agent/chat", exchange -> {
            try {
                exchange.getResponseHeaders().set("Content-Type", MediaType.TEXT_EVENT_STREAM_VALUE);
                exchange.sendResponseHeaders(200, 0);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(sseBody.getBytes());
                }
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        });

        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "content", "usage persistence probe",
                "workspaceId", workspaceId,
                "userId", userId);
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST, new HttpEntity<>(request, headers), Map.class);
        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());

        String runId = (String) response.getBody().get("runId");
        org.awaitility.Awaitility.await().atMost(java.time.Duration.ofSeconds(5)).untilAsserted(() -> {
            ChatRun run = chatRunRepository.findById(UUID.fromString(runId)).orElseThrow();
            assertEquals("succeeded", run.getStatus());
            // Real totalTokens (150), not the SSE chunk count (1 token event).
            assertEquals(150, run.getTokenCount());

            UUID operationId = sessionOperationRepository.findByRunId(runId).orElseThrow().getId();
            var items = operationItemRepository.findByOperationIdOrderBySequenceAsc(operationId.toString());
            var usageItem = items.stream()
                    .filter(i -> "llm_usage".equals(i.getKind()))
                    .findFirst().orElseThrow();
            var extension = operationExtensionRepository
                    .findByItemIdAndExtensionKindAndSchemaVersion(usageItem.getId().toString(), "llm_usage", 1)
                    .orElseThrow();
            assertTrue(extension.getPayload().contains("source"), "usage extension payload must carry source tag");
        });
    }
}
