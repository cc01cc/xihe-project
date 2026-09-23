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
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
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
import com.cc01cc.p.xihe.cp.repository.LedgerOperationRepository;
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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.mockito.ArgumentCaptor;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
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
    private LedgerOperationRepository ledgerOperationRepository;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.OperationItemRepository operationItemRepository;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.OperationExtensionRepository operationExtensionRepository;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.ConfigJpaRepository configJpaRepository;

    @Autowired
    private OperationService operationService;

    @Autowired
    private ApprovalService approvalService;

    @Autowired
    private SseEmitterManager sseEmitterManager;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @Autowired
    private HealthMonitor healthMonitor;

    @MockitoSpyBean
    private AnswererChain answererChain;

    @MockitoSpyBean
    private ApprovalAgentClient approvalAgentClient;

    /** PLAN-0338: terminal transitions must request a Run slice capture. */
    @MockitoSpyBean
    private com.cc01cc.p.xihe.cp.service.RunCheckpointService runCheckpointService;

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
            agentServer.setExecutor(java.util.concurrent.Executors.newCachedThreadPool());
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
        assertEquals(operationId, ledgerOperationRepository.findByRunId(run.getId().toString()).orElseThrow().getId().toString());
        assertEquals("completed", ledgerOperationRepository.findByRunId(run.getId().toString()).orElseThrow().getStatus());
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
        // PLAN-0338：终态还会异步追加 checkpoint 切片标记（kind=checkpoint），
        // 本用例只断言 tool 事实条目。
        List<?> items = ((List<?>) trace.get("items")).stream()
                .filter(item -> "tool_call".equals(
                        ((com.cc01cc.p.xihe.cp.entity.OperationItem) item).getKind()))
                .toList();
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

    // ── PLAN-0308 M1 T1.9：run 请求 per-call 超时（`toolTimeouts`） ─────────────

    @Test
    void chat_rejectsInvalidToolTimeoutsBeforeAnyRunSideEffect() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);

        for (Object bad : List.of(86400, 601, 31, 0, -5, "abc", 12.5)) {
            Map<String, Object> request = new java.util.HashMap<>();
            request.put("sessionId", sessionId);
            request.put("content", "run a long command");
            request.put("toolTimeouts", Map.of("execute_command", bad));
            ResponseEntity<Map> response = restTemplate.exchange(
                    baseUrl + "/api/v1/chat", HttpMethod.POST,
                    new HttpEntity<>(request, headers), Map.class);

            assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode(), "value " + bad);
            assertEquals("INVALID_REQUEST", response.getBody().get("code"), "value " + bad);
        }

        Map<String, Object> wrongType = new java.util.HashMap<>();
        wrongType.put("sessionId", sessionId);
        wrongType.put("content", "run a long command");
        wrongType.put("toolTimeouts", List.of(20));
        ResponseEntity<Map> wrongTypeResponse = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST,
                new HttpEntity<>(wrongType, headers), Map.class);
        assertEquals(HttpStatus.BAD_REQUEST, wrongTypeResponse.getStatusCode());
        assertEquals("INVALID_REQUEST", wrongTypeResponse.getBody().get("code"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void chat_forwardsPerCallToolTimeoutsToAgentPayload() throws IOException, InterruptedException {
        final String[] capturedBody = new String[1];
        agentServer.createContext("/internal/v1/agent/chat", exchange -> {
            try {
                capturedBody[0] = new String(exchange.getRequestBody().readAllBytes());
                exchange.getResponseHeaders().set("Content-Type", MediaType.TEXT_EVENT_STREAM_VALUE);
                exchange.sendResponseHeaders(200, 0);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write("event: done\ndata: {\"type\":\"done\",\"outcome\":\"success\"}\n\n"
                            .getBytes(StandardCharsets.UTF_8));
                }
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        });

        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "content", "run a long command",
                "toolMode", "workspace",
                "toolTimeouts", Map.of("execute_command", 20));
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);

        restTemplate.exchange(baseUrl + "/api/v1/chat", HttpMethod.POST,
                new HttpEntity<>(request, headers), Map.class);

        long deadline = System.currentTimeMillis() + 5000;
        while (capturedBody[0] == null && System.currentTimeMillis() < deadline) {
            Thread.sleep(100);
        }
        assertNotNull(capturedBody[0], "Agent request body should be captured");
        Map<String, Object> agentRequest = objectMapper.readValue(capturedBody[0], Map.class);

        Map<String, Object> waits = (Map<String, Object>) agentRequest.get("toolWaits");
        Map<String, Object> origins = (Map<String, Object>) agentRequest.get("toolWaitOrigins");
        Map<String, Object> rawTimeouts = (Map<String, Object>) agentRequest.get("toolTimeouts");
        assertNotNull(waits, "payload must carry toolWaits");
        assertEquals(24, ((Number) waits.get("execute_command")).intValue(),
                "Agent wait = per-call 20 + 4");
        assertEquals("per-call", origins.get("execute_command"));
        assertEquals(20, ((Number) rawTimeouts.get("execute_command")).intValue(),
                "raw per-call value travels for the inbound header");
    }

    @Test
    @SuppressWarnings("unchecked")
    void chat_enrichesLiveApprovalRequestWithPolicySummary() throws IOException {
        String requestId = UUID.randomUUID().toString();
        String sseBody = "event: approval_request\n"
                + "data: {\"requestId\":\"" + requestId + "\",\"tool\":\"write_file\","
                + "\"action\":\"Execute write_file\","
                + "\"details\":\"{\\\"tool\\\":\\\"write_file\\\",\\\"arguments\\\":{\\\"path\\\":\\\"secret.md\\\"}}\","
                + "\"expiresAt\":\"2099-01-01T00:00:00Z\",\"agentOnly\":\"discard\"}\n\n";
        agentServer.createContext("/internal/v1/agent/chat", exchange -> {
            try {
                exchange.getResponseHeaders().set("Content-Type", MediaType.TEXT_EVENT_STREAM_VALUE);
                exchange.sendResponseHeaders(200, sseBody.getBytes(StandardCharsets.UTF_8).length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(sseBody.getBytes(StandardCharsets.UTF_8));
                }
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        });

        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "content", "Please write the file",
                "workspaceId", workspaceId,
                "userId", userId);
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST,
                new HttpEntity<>(request, headers), Map.class);
        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());

        ArgumentCaptor<Object> payload = ArgumentCaptor.forClass(Object.class);
        verify(sseEmitterManager, timeout(5000)).send(eq(sessionId), eq("approval_request"), payload.capture());
        Map<String, Object> event = (Map<String, Object>) payload.getValue();
        Map<String, Object> policy = (Map<String, Object>) event.get("policy");
        assertEquals(requestId, event.get("requestId"));
        assertEquals("ask", policy.get("effect"));
        assertEquals("builtin", policy.get("sourceLayer"));
        assertEquals("write", policy.get("actionClass"));
        assertEquals("structured", policy.get("shape"));
        assertTrue(policy.get("reason") instanceof String reason && !reason.isBlank());
        assertFalse(policy.toString().contains("secret.md"));
        var ledgerItem = operationService.findItemByApprovalRequestId(requestId);
        assertNotNull(ledgerItem);
        assertFalse(ledgerItem.getArgumentsPreview().contains("\"policy\""));
        Map<String, Object> replay = approvalService.replayPending(sessionId, userId, workspaceId).stream()
                .filter(item -> requestId.equals(item.get("requestId")))
                .findFirst().orElseThrow();
        assertEquals(event.keySet(), replay.keySet());
        assertEquals("pending", event.get("state"));
        assertEquals(Boolean.FALSE, event.get("replayed"));
        assertEquals(Boolean.TRUE, replay.get("replayed"));
        assertFalse(event.containsKey("agentOnly"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void chat_answererRejectDoesNotParkTheRunOrPushACard() throws IOException {
        String requestId = UUID.randomUUID().toString();
        String sseBody = "event: approval_request\n"
                + "data: {\"requestId\":\"" + requestId + "\",\"tool\":\"write_file\","
                + "\"action\":\"Execute write_file\",\"details\":\"preview\","
                + "\"expiresAt\":\"2099-01-01T00:00:00Z\"}\n\n"
                + "event: probe\ndata: {\"marker\":true}\n\n"
                + "event: done\ndata: {\"type\":\"done\",\"outcome\":\"success\"}\n\n";
        agentServer.createContext("/internal/v1/agent/chat", exchange -> {
            try {
                exchange.getResponseHeaders().set("Content-Type", MediaType.TEXT_EVENT_STREAM_VALUE);
                exchange.sendResponseHeaders(200, sseBody.getBytes(StandardCharsets.UTF_8).length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(sseBody.getBytes(StandardCharsets.UTF_8));
                }
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        });
        doReturn(Map.of("status", "accepted")).when(approvalAgentClient)
                .respond(anyString(), anyBoolean(), anyString(), any());
        doReturn(new AnswererChain.Resolution(AutoReviewAnswerer.ID,
                ApprovalAnswerer.Outcome.DENY, "denied by review"))
                .when(answererChain).resolve(any());

        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "content", "Please write the file",
                "workspaceId", workspaceId,
                "userId", userId);
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST,
                new HttpEntity<>(request, headers), Map.class);
        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());

        // T1.9: the blocked Agent waiter is notified exactly like a user rejection...
        verify(approvalAgentClient, timeout(5000)).respond(
                eq(requestId), eq(false), eq("reject"), eq("denied by review"));
        // ...and the relay keeps going: the probe event is processed after the approval
        // event on the same relay thread, so the park decision has already been made.
        verify(sseEmitterManager, timeout(5000)).send(eq(sessionId), eq("probe"), any());
        verify(sseEmitterManager, never()).send(eq(sessionId), eq("approval_request"), any());

        ChatRun run = chatRunRepository.findById(UUID.fromString((String) response.getBody().get("runId")))
                .orElseThrow();
        assertNotEquals("awaiting_approval", run.getStatus(),
                "an answerer-rejected ask must not park the run");
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

            UUID operationId = ledgerOperationRepository.findByRunId(runId).orElseThrow().getId();
            var items = operationItemRepository.findByOperationIdOrderBySequenceAsc(operationId.toString());
            var usageItem = items.stream()
                    .filter(i -> "llm_usage".equals(i.getKind()))
                    .findFirst().orElseThrow();
            var extension = operationExtensionRepository
                    .findByItemIdAndExtensionKindAndSchemaVersion(usageItem.getId().toString(), "llm_usage", 1)
                    .orElseThrow();
            assertTrue(extension.getPayload().contains("source"), "usage extension payload must carry source tag");
            // 2026-09-13 E2E（V11）：usage 条目写完即 completed，不得残留 pending。
            assertEquals("completed", usageItem.getStatus());
        });
    }

    @Test
    void chat_withUsageEvent_mapsCostFromPricingAndRelaysToUi() throws IOException {
        // PLAN-0343 T1.2 (decisions #7/#9/#11): the relay must map cost at the
        // run-terminal snapshot (persistUsageExtension), store the enriched
        // payload verbatim, and relay the mapped usage event to the UI SSE.
        com.cc01cc.p.xihe.cp.entity.ConfigEntity pricing = new com.cc01cc.p.xihe.cp.entity.ConfigEntity();
        pricing.setLayer("instance");
        pricing.setDomain("pricing");
        pricing.setConfigKey("models");
        pricing.setConfigValue("{\"deepseek/deepseek-v4-flash\":{\"inputPerMTok\":0.27,\"outputPerMTok\":1.10,\"currency\":\"USD\"}}");
        configJpaRepository.save(pricing);

        String sseBody = "event: token\ndata: {\"content\":\"hi\"}\n\n"
                + "event: usage\ndata: {\"usage\":{\"inputTokens\":120,\"outputTokens\":30,\"totalTokens\":150,"
                + "\"estimatedInputTokens\":0,\"source\":\"real\",\"model\":\"deepseek/deepseek-v4-flash\"}}\n\n"
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
                "content", "usage cost mapping probe",
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
            UUID operationId = ledgerOperationRepository.findByRunId(runId).orElseThrow().getId();
            var items = operationItemRepository.findByOperationIdOrderBySequenceAsc(operationId.toString());
            var usageItem = items.stream()
                    .filter(i -> "llm_usage".equals(i.getKind()))
                    .findFirst().orElseThrow();
            var extension = operationExtensionRepository
                    .findByItemIdAndExtensionKindAndSchemaVersion(usageItem.getId().toString(), "llm_usage", 1)
                    .orElseThrow();
            assertTrue(extension.getPayload().contains("\"costSource\":\"price_table\""),
                    "mapped payload must carry costSource=price_table");
            assertTrue(extension.getPayload().contains("\"cost\":0.0"), "mapped payload must carry computed cost");
            assertTrue(extension.getPayload().contains("deepseek/deepseek-v4-flash"),
                    "mapped payload must carry the model key");
        });
    }

    @Test
    void chat_withUnmappedModel_writesNullCostAndUnmappedSource() throws IOException {
        // PLAN-0343 V2 (I2): no pricing entry → cost stays null (never 0),
        // costSource=unmapped; the row is still persisted (never dropped).
        String sseBody = "event: token\ndata: {\"content\":\"hi\"}\n\n"
                + "event: usage\ndata: {\"usage\":{\"inputTokens\":10,\"outputTokens\":5,\"totalTokens\":15,"
                + "\"estimatedInputTokens\":0,\"source\":\"estimated\",\"model\":\"openai/gpt-4o\"}}\n\n"
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
                "content", "usage unmapped probe",
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
            UUID operationId = ledgerOperationRepository.findByRunId(runId).orElseThrow().getId();
            var items = operationItemRepository.findByOperationIdOrderBySequenceAsc(operationId.toString());
            var usageItem = items.stream()
                    .filter(i -> "llm_usage".equals(i.getKind()))
                    .findFirst().orElseThrow();
            var extension = operationExtensionRepository
                    .findByItemIdAndExtensionKindAndSchemaVersion(usageItem.getId().toString(), "llm_usage", 1)
                    .orElseThrow();
            assertTrue(extension.getPayload().contains("\"costSource\":\"unmapped\""),
                    "unmapped model must carry costSource=unmapped");
            assertTrue(extension.getPayload().contains("\"cost\":null"),
                    "unmapped model must carry cost=null (never 0)");
            assertTrue(extension.getPayload().contains("model not in pricing config"),
                    "unmapped row must carry a costNote reason");
        });
    }

    // ── PLAN-0338：终态路径的 Run 切片捕获触发 ────────────────────────

    @Test
    void chat_terminalSuccessRequestsCheckpointSeal() throws IOException {
        String sseBody = "event: token\ndata: {\"content\":\"ok\"}\n\n"
                + "event: done\ndata: {\"type\":\"done\",\"outcome\":\"success\"}\n\n";
        agentServer.createContext("/internal/v1/agent/chat", exchange -> {
            try {
                exchange.getResponseHeaders().set("Content-Type", MediaType.TEXT_EVENT_STREAM_VALUE);
                exchange.sendResponseHeaders(200, sseBody.getBytes(StandardCharsets.UTF_8).length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(sseBody.getBytes(StandardCharsets.UTF_8));
                }
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        });

        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "content", "seal on success",
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
        });
        verify(runCheckpointService, timeout(5000)).requestCapture(runId);
    }

    @Test
    void chat_streamingMarkedApprovalThenToolCompletionReachesSuccessTerminalAndSeals() {
        CountDownLatch releaseStream = new CountDownLatch(1);
        doReturn(Map.of("status", "accepted")).when(approvalAgentClient)
                .respond(anyString(), anyBoolean(), anyString(), any());
        String toolCallId = UUID.randomUUID().toString();
        String pendingApprovalId = UUID.randomUUID().toString();
        agentServer.createContext("/internal/v1/agent/chat", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", MediaType.TEXT_EVENT_STREAM_VALUE);
            exchange.sendResponseHeaders(200, 0);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(("event: token\ndata: {\"content\":\"first\"}\n\n"
                        + "event: approval_request\n"
                        + "data: {\"requestId\":\"" + pendingApprovalId + "\",\"tool\":\"write_file\","
                        + "\"action\":\"Execute write_file\",\"details\":\"preview\","
                        + "\"expiresAt\":\"2099-01-01T00:00:00Z\"}\n\n")
                        .getBytes(StandardCharsets.UTF_8));
                out.flush();
                try {
                    releaseStream.await(15, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                out.write(("event: tool_call\n"
                        + "data: {\"type\":\"tool_call\",\"tool\":\"write_file\","
                        + "\"arguments\":{\"path\":\"a.txt\"},\"run_id\":\"" + toolCallId + "\"}\n\n"
                        + "event: tool_result\n"
                        + "data: {\"type\":\"tool_result\",\"tool\":\"write_file\",\"result\":\"ok\","
                        + "\"run_id\":\"" + toolCallId + "\"}\n\n"
                        + "event: token\ndata: {\"content\":\"done\"}\n\n"
                        + "event: done\ndata: {\"type\":\"done\",\"outcome\":\"success\"}\n\n")
                        .getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
        });

        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "content", "stream then approve",
                "workspaceId", workspaceId,
                "userId", userId);
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST, new HttpEntity<>(request, headers), Map.class);
        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        String runId = (String) response.getBody().get("runId");
        String operationId = (String) response.getBody().get("operationId");

        try {
            org.awaitility.Awaitility.await().atMost(java.time.Duration.ofSeconds(5)).untilAsserted(() -> {
                assertEquals("awaiting_approval",
                        chatRunRepository.findById(UUID.fromString(runId)).orElseThrow().getStatus());
            });
            verify(sseEmitterManager, timeout(5000).atLeastOnce()).send(eq(sessionId), eq("token"), any());
            verify(sseEmitterManager, timeout(5000)).send(eq(sessionId), eq("approval_request"), any());

            String approvalRequestId = approvalService.findActiveForRun(runId, userId, workspaceId).stream()
                    .map(row -> (String) row.get("requestId"))
                    .findFirst()
                    .orElseThrow();
            ResponseEntity<Map> decision = restTemplate.exchange(
                    baseUrl + "/api/v1/chat/approvals/" + approvalRequestId + "/decision",
                    HttpMethod.POST, new HttpEntity<>(Map.of("approved", true), headers), Map.class);
            assertEquals(HttpStatus.OK, decision.getStatusCode());

            assertEquals("running",
                    chatRunRepository.findById(UUID.fromString(runId)).orElseThrow().getStatus());
            assertEquals("running",
                    ledgerOperationRepository.findById(UUID.fromString(operationId)).orElseThrow().getStatus());
        } finally {
            releaseStream.countDown();
        }

        org.awaitility.Awaitility.await().atMost(java.time.Duration.ofSeconds(5)).untilAsserted(() -> {
            assertEquals("succeeded",
                    chatRunRepository.findById(UUID.fromString(runId)).orElseThrow().getStatus());
        });
        assertEquals("completed",
                ledgerOperationRepository.findById(UUID.fromString(operationId)).orElseThrow().getStatus());
        verify(runCheckpointService, timeout(5000)).requestCapture(runId);
        List<?> toolItems = operationItemRepository.findByOperationIdOrderBySequenceAsc(operationId).stream()
                .filter(item -> "tool_call".equals(
                        ((com.cc01cc.p.xihe.cp.entity.OperationItem) item).getKind()))
                .toList();
        assertEquals(1, toolItems.size());
        assertEquals("completed",
                ((com.cc01cc.p.xihe.cp.entity.OperationItem) toolItems.get(0)).getStatus());
    }

    @Test
    void chat_terminalSuccessWhileAwaitingApprovalStillTransitionsAndSeals() {
        String pendingApprovalId = UUID.randomUUID().toString();
        String sseBody = "event: token\ndata: {\"content\":\"first\"}\n\n"
                + "event: approval_request\n"
                + "data: {\"requestId\":\"" + pendingApprovalId + "\",\"tool\":\"write_file\","
                + "\"action\":\"Execute write_file\",\"details\":\"preview\","
                + "\"expiresAt\":\"2099-01-01T00:00:00Z\"}\n\n"
                + "event: token\ndata: {\"content\":\"second\"}\n\n"
                + "event: done\ndata: {\"type\":\"done\",\"outcome\":\"success\"}\n\n";
        agentServer.createContext("/internal/v1/agent/chat", exchange -> {
            exchange.getResponseHeaders().set("Content-Type", MediaType.TEXT_EVENT_STREAM_VALUE);
            exchange.sendResponseHeaders(200, sseBody.getBytes(StandardCharsets.UTF_8).length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(sseBody.getBytes(StandardCharsets.UTF_8));
            }
        });

        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "content", "terminal while awaiting approval",
                "workspaceId", workspaceId,
                "userId", userId);
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST, new HttpEntity<>(request, headers), Map.class);
        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        String runId = (String) response.getBody().get("runId");
        String operationId = (String) response.getBody().get("operationId");

        verify(sseEmitterManager, timeout(5000)).send(eq(sessionId), eq("approval_request"), any());
        org.awaitility.Awaitility.await().atMost(java.time.Duration.ofSeconds(5)).untilAsserted(() -> {
            assertEquals("succeeded",
                    chatRunRepository.findById(UUID.fromString(runId)).orElseThrow().getStatus());
        });
        assertEquals("completed",
                ledgerOperationRepository.findById(UUID.fromString(operationId)).orElseThrow().getStatus());
        verify(runCheckpointService, timeout(5000)).requestCapture(runId);
    }

    @Test
    void chat_agentErrorTerminalPathRequestsCheckpointSeal() throws IOException {
        agentServer.createContext("/internal/v1/agent/chat", exchange -> {
            byte[] body = "{\"code\":\"LLM_PROVIDER_UNREACHABLE\"}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", MediaType.APPLICATION_JSON_VALUE);
            exchange.sendResponseHeaders(502, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });

        Map<String, Object> request = Map.of(
                "sessionId", sessionId,
                "content", "seal on agent error",
                "workspaceId", workspaceId,
                "userId", userId);
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat", HttpMethod.POST, new HttpEntity<>(request, headers), Map.class);
        assertEquals(HttpStatus.ACCEPTED, response.getStatusCode());
        String runId = (String) response.getBody().get("runId");

        verify(runCheckpointService, timeout(5000)).requestCapture(runId);
    }

    @Test
    void cancelRunTerminalPathRequestsCheckpointSeal() {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), sessionId, userId, workspaceId,
                "cancel-idem-" + UUID.randomUUID(), "hash", "openai", "gpt-test", "none", "running");
        chatRunRepository.save(run);

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/chat/runs/" + run.getId() + "/cancel", HttpMethod.POST,
                new HttpEntity<>(Map.of("reason", "user_requested"), headers), Map.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("cancel_accepted", response.getBody().get("status"));
        assertEquals("cancelled", chatRunRepository.findById(run.getId()).orElseThrow().getStatus());
        verify(runCheckpointService, timeout(5000)).requestCapture(run.getId().toString());
    }
}
