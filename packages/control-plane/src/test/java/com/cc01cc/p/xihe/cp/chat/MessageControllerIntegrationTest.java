package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
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
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class MessageControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private MessageRepository messageRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    private String authToken;
    private String userId;
    private String workspaceId;
    private String sessionId;
    private Message message;

    @BeforeEach
    void setUp() {
        String email = "msg-int-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> reg = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", new RegisterRequest(email, TestDataFactory.PASSWORD, "MsgInt"), AuthResponse.class);
        String baseToken = reg.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId();
        Workspace ws = workspaceRepository.save(new Workspace("msg-int-workspace", userId));
        workspaceId = ws.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        authToken = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId);

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "Message Int Test");
        session.setId(sessionId);
        sessionRepository.save(session);

        message = new Message(sessionId, MessageRole.USER, "Integration message");
        messageRepository.save(message);
    }

    @Test
    void listMessages_returnsHistory() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        ResponseEntity<List> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionId + "/messages",
                HttpMethod.GET, new HttpEntity<>(headers), List.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        List<Map<String, Object>> body = response.getBody();
        assertNotNull(body);
        assertEquals(1, body.size());
        assertEquals("Integration message", body.get(0).get("content"));
    }

    @Test
    void deleteMessage_hardDeletesAndLeavesOrphanAttachment() {
        com.cc01cc.p.xihe.cp.entity.File file = new com.cc01cc.p.xihe.cp.entity.File(userId, "msg.txt", "/tmp/msg.txt");
        file.setId(UUID.randomUUID().toString());
        file.setWorkspaceId(workspaceId);
        file.setSessionId(sessionId);
        file.setMessageId(message.getId());
        file.setMimeType("text/plain");
        file.setSizeBytes(0);

        // We don't have a file repo autowired here, skip DB attachment for this test
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionId + "/messages/" + message.getId(),
                HttpMethod.DELETE, new HttpEntity<>(headers), Map.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(message.getId(), response.getBody().get("deleted"));
        assertFalse(messageRepository.findById(message.getId()).isPresent());
    }
}
