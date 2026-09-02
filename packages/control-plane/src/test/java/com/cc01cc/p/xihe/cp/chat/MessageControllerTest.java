package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.*;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.client.RestTemplate;
import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
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
@ActiveProfiles("h2")
class MessageControllerTest extends AbstractH2Test {

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

    @LocalServerPort
    private int serverPort;

    private String authToken;
    private String userId;
    private String workspaceId;
    private String sessionId;
    private Message message;

    @BeforeEach
    void setUp() {
        this.baseUrl = "http://localhost:" + serverPort;
        this.restTemplate = new RestTemplate();
        restTemplate.setErrorHandler(new org.springframework.web.client.DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.client.ClientHttpResponse response) throws java.io.IOException {
                HttpStatus status = HttpStatus.resolve(response.getStatusCode().value());
                return status != null && status.is5xxServerError();
            }
        });

        String email = "msg-ctrl-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> reg = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", new RegisterRequest(email, TestDataFactory.PASSWORD, "MsgCtrl"), AuthResponse.class);
        String baseToken = reg.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId();
        Workspace ws = workspaceRepository.save(new Workspace("msg-test-workspace", userId));
        workspaceId = ws.getId();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));

        authToken = jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId);

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "Message Test");
        session.setId(sessionId);
        sessionRepository.save(session);

        message = new Message(sessionId, MessageRole.USER, "Hello");
        messageRepository.save(message);
    }

    @Test
    void listMessages_returnsMessagesForSession() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        HttpEntity<Void> request = new HttpEntity<>(headers);

        ResponseEntity<List> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionId + "/messages",
                HttpMethod.GET, request, List.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        List<Map<String, Object>> body = response.getBody();
        assertNotNull(body);
        assertEquals(1, body.size());
        assertEquals("Hello", body.get(0).get("content"));
        assertEquals("USER", body.get(0).get("role"));
        assertNotNull(body.get(0).get("attachments"));
    }

    @Test
    void deleteMessage_removesMessage() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        HttpEntity<Void> request = new HttpEntity<>(headers);

        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + sessionId + "/messages/" + message.getId(),
                HttpMethod.DELETE, request, Map.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(message.getId(), response.getBody().get("deleted"));
        assertFalse(messageRepository.findById(message.getId()).isPresent());
    }

    @Test
    void listMessages_withoutAuth_returns401() {
        ResponseEntity<Map> response = restTemplate.getForEntity(
                baseUrl + "/api/v1/sessions/" + sessionId + "/messages", Map.class);
        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
    }
}
