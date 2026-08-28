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
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

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
    private SseEmitterManager sseEmitterManager;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @LocalServerPort
    private int serverPort;

    private static HttpServer agentServer;
    private static int agentPort;

    private String authToken;
    private String userId;
    private String workspaceId;
    private String sessionId;

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        try {
            agentServer = HttpServer.create(new InetSocketAddress(0), 0);
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

        String email = "chat-ctrl-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> reg = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", new RegisterRequest(email, "Test1234!", "ChatCtrl"), AuthResponse.class);
        authToken = reg.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId();
        Workspace ws = workspaceRepository.save(new Workspace("chat-test-workspace", userId));
        workspaceId = ws.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        authToken = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId);

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "Chat Test");
        session.setId(sessionId);
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

        String sseBody = "data: {\"content\":\"hello\"}\n\n";
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
        assertTrue(userMsg.getAttachments().contains(file.getId()));

        com.cc01cc.p.xihe.cp.entity.File updated = fileRepository.findById(file.getId()).orElseThrow();
        assertEquals(userMsg.getId(), updated.getMessageId());

        Message assistantMsg = messages.stream().filter(m -> m.getRole() == MessageRole.ASSISTANT).findFirst().orElse(null);
        assertNotNull(assistantMsg, "Assistant reply should be persisted");
        assertEquals("hello", assistantMsg.getContent());
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
        agentServer.createContext("/internal/v1/agent/chat", exchange -> {
            try {
                capturedBody[0] = new String(exchange.getRequestBody().readAllBytes());
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
        assertEquals(file.getId(), attachments.get(0).get("fileId"));
        assertEquals("/api/v1/files/" + file.getId(), attachments.get(0).get("url"));
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
}
