package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.*;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

class ChatIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private SseEmitterManager sseEmitterManager;

    @Autowired
    private MessageRepository messageRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    private String authToken;
    private String userId;
    private String workspaceId;

    @BeforeEach
    void setUp() {
        String email = "chat-int-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, "password123", "ChatIntTest");
        ResponseEntity<AuthResponse> regResponse = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        authToken = regResponse.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId();
        Workspace ws = workspaceRepository.save(new Workspace("test-workspace", userId));
        workspaceId = ws.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));

        when(sseEmitterManager.hasEmitter(anyString())).thenReturn(true);
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
    }

    @Test
    void messageIsPersistedToDatabase() {
        String sessionId = "persist-session-" + UUID.randomUUID().toString().substring(0, 8);
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

        List<Message> messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId);
        assertFalse(messages.isEmpty());
        assertEquals(1, messages.size());

        Message msg = messages.get(0);
        assertEquals("This message must be persisted", msg.getContent());
        assertEquals(MessageRole.USER, msg.getRole());
        assertEquals(sessionId, msg.getSessionId());
        assertNotNull(msg.getId());
        assertNotNull(msg.getCreatedAt());
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
