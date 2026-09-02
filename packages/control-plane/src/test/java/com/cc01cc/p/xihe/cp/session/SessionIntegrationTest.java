package com.cc01cc.p.xihe.cp.session;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.context.repository.ContextProjectionRepository;
import com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

class SessionIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private MessageRepository messageRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private SessionService sessionService;

    @Autowired
    private EventStoreRepository eventStoreRepository;

    @Autowired
    private ContextProjectionRepository contextProjectionRepository;

    @Autowired
    private SseEmitterManager sseEmitterManager;

    private String authToken;
    private String userId;
    private String workspaceId;

    @BeforeEach
    void setUp() {
        String email = "session-int-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "SessionIntTest");
        ResponseEntity<AuthResponse> regResponse = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        authToken = regResponse.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId();
        // The default workspace is created via the auth flow.
        var defaultWorkspace = workspaceRepository.findActiveByMemberUserId(userId).stream().findFirst();
        workspaceId = defaultWorkspace.orElseThrow().getId();
        // Backfill membership (auth flow already inserts OWNER; ensure role is set).
        if (workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(workspaceId, userId).isEmpty()) {
            workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        }

        when(sseEmitterManager.hasEmitter(anyString())).thenReturn(true);
    }

    @Test
    void createSession_returnsNewSession() {
        Session session = new Session(workspaceId, userId, "Test Session");
        session.setId(UUID.randomUUID().toString());

        Session saved = sessionRepository.save(session);

        assertNotNull(saved.getId());
        assertEquals(workspaceId, saved.getWorkspaceId());
        assertEquals(userId, saved.getUserId());
        assertEquals("Test Session", saved.getTitle());
        assertFalse(saved.isArchived());
        assertNotNull(saved.getCreatedAt());
        assertNotNull(saved.getUpdatedAt());
    }

    @Test
    void listSessions_returnsUserSessions() {
        String sid1 = UUID.randomUUID().toString();
        String sid2 = UUID.randomUUID().toString();

        Session s1 = new Session(workspaceId, userId, "Session A");
        s1.setId(sid1);
        sessionRepository.save(s1);

        Session s2 = new Session(workspaceId, userId, "Session B");
        s2.setId(sid2);
        sessionRepository.save(s2);

        List<Session> sessions = sessionRepository.findByUserIdAndArchivedFalseOrderByCreatedAtDesc(userId);

        assertTrue(sessions.size() >= 2);
        assertTrue(sessions.stream().anyMatch(s -> "Session A".equals(s.getTitle())));
        assertTrue(sessions.stream().anyMatch(s -> "Session B".equals(s.getTitle())));
    }

    @Test
    void renameSession_updatesTitle() {
        Session session = new Session(workspaceId, userId, "Original Title");
        session.setId(UUID.randomUUID().toString());
        sessionRepository.save(session);

        Session found = sessionRepository.findById(session.getId()).orElseThrow();
        found.setTitle("Renamed Title");
        sessionRepository.save(found);

        Session updated = sessionRepository.findById(session.getId()).orElseThrow();
        assertEquals("Renamed Title", updated.getTitle());
    }

    @Test
    void deleteSession_viaService_removesRelatedRows() {
        Session session = sessionService.create(userId, workspaceId, "To Be Deleted", null, null);
        String sessionId = session.getId();
        messageRepository.save(new Message(sessionId, MessageRole.USER, "hello"));
        sessionService.delete(sessionId, userId, workspaceId);

        assertFalse(sessionRepository.findById(sessionId).isPresent());
        assertTrue(messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId).isEmpty());
    }

    @Test
    void deleteSession_endpointReturns204() {
        Session session = sessionService.create(userId, workspaceId, "Delete Endpoint", null, null);
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        ResponseEntity<Void> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + session.getId(),
                HttpMethod.DELETE, new HttpEntity<>(headers), Void.class);
        assertEquals(HttpStatus.NO_CONTENT, response.getStatusCode());
        assertFalse(sessionRepository.findById(session.getId()).isPresent());
    }

    @Test
    void listSessionsEndpoint_returnsOwnSessions() {
        Session s1 = sessionService.create(userId, workspaceId, "Listed A", null, null);
        Session s2 = sessionService.create(userId, workspaceId, "Listed B", null, null);
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions", HttpMethod.GET,
                new HttpEntity<>(headers), Map.class);
        assertEquals(HttpStatus.OK, response.getStatusCode());
        List<Map<String, Object>> items = (List<Map<String, Object>>) response.getBody().get("sessions");
        assertTrue(items.stream().anyMatch(item -> s1.getId().equals(item.get("id"))));
        assertTrue(items.stream().anyMatch(item -> s2.getId().equals(item.get("id"))));
    }

    @Test
    void sessionEndpoint_returns403ForCrossUser() {
        Session s1 = sessionService.create(userId, workspaceId, "Mine", null, null);
        String otherEmail = "other-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        String password = TestDataFactory.PASSWORD;
        restTemplate.postForEntity(baseUrl + "/api/v1/auth/register",
                new RegisterRequest(otherEmail, password, "Other"), AuthResponse.class);
        String otherToken = restTemplate.postForEntity(baseUrl + "/api/v1/auth/login",
                Map.of("email", otherEmail, "password", password), Map.class)
                .getBody().get("accessToken").toString();
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(otherToken);
        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + s1.getId(),
                HttpMethod.GET, new HttpEntity<>(headers), Map.class);
        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
    }

    @Test
    void sessionEndpoint_returnsOwnSession() {
        Session s1 = sessionService.create(userId, workspaceId, "My Session", null, null);
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(authToken);
        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/sessions/" + s1.getId(),
                HttpMethod.GET, new HttpEntity<>(headers), Map.class);
        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(s1.getId(), response.getBody().get("id"));
    }

    @Test
    void eventsEndpoint_rejectsSessionOwnedByAnotherUser() {
        Session session = sessionService.create(userId, workspaceId, "Private Events", null, null);
        String otherEmail = "events-other-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        restTemplate.postForEntity(baseUrl + "/api/v1/auth/register",
                new RegisterRequest(otherEmail, TestDataFactory.PASSWORD, "Other"), AuthResponse.class);
        String otherToken = restTemplate.postForEntity(baseUrl + "/api/v1/auth/login",
                Map.of("email", otherEmail, "password", TestDataFactory.PASSWORD), Map.class)
                .getBody().get("accessToken").toString();

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(otherToken);
        headers.setAccept(List.of(org.springframework.http.MediaType.TEXT_EVENT_STREAM));
        ResponseEntity<Map> response = restTemplate.exchange(
                baseUrl + "/api/v1/events?sessionId=" + session.getId(),
                HttpMethod.GET, new HttpEntity<>(headers), Map.class);

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
    }

    @Test
    void switchSession_loadsCorrectMessages() {
        String sid1 = UUID.randomUUID().toString();
        String sid2 = UUID.randomUUID().toString();

        Session s1 = new Session(workspaceId, userId, "Session One");
        s1.setId(sid1);
        sessionRepository.save(s1);

        Session s2 = new Session(workspaceId, userId, "Session Two");
        s2.setId(sid2);
        sessionRepository.save(s2);

        messageRepository.save(new Message(sid1, MessageRole.USER, "Message in session 1"));
        messageRepository.save(new Message(sid1, MessageRole.ASSISTANT, "Reply in session 1"));
        messageRepository.save(new Message(sid2, MessageRole.USER, "Message in session 2"));

        List<Message> session1Messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(sid1);
        List<Message> session2Messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(sid2);

        assertEquals(2, session1Messages.size());
        assertEquals("Message in session 1", session1Messages.get(0).getContent());
        assertEquals("Reply in session 1", session1Messages.get(1).getContent());

        assertEquals(1, session2Messages.size());
        assertEquals("Message in session 2", session2Messages.get(0).getContent());
    }

    @Test
    void sessionIsolation_betweenUsers() {
        String emailB = "session-int-b-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        restTemplate.postForEntity(baseUrl + "/api/v1/auth/register",
                new RegisterRequest(emailB, TestDataFactory.PASSWORD, "UserB"), AuthResponse.class);

        User userB = userRepository.findByEmail(emailB).orElseThrow();
        String userIdB = userB.getId();

        Session sessionA = new Session(workspaceId, userId, "User A Session");
        sessionA.setId(UUID.randomUUID().toString());
        sessionRepository.save(sessionA);

        Session sessionB = new Session(workspaceId, userIdB, "User B Session");
        sessionB.setId(UUID.randomUUID().toString());
        sessionRepository.save(sessionB);

        List<Session> userASessions = sessionRepository.findByUserIdAndArchivedFalseOrderByCreatedAtDesc(userId);
        List<Session> userBSessions = sessionRepository.findByUserIdAndArchivedFalseOrderByCreatedAtDesc(userIdB);

        assertTrue(userASessions.stream().anyMatch(s -> "User A Session".equals(s.getTitle())));
        assertTrue(userBSessions.stream().anyMatch(s -> "User B Session".equals(s.getTitle())));

        assertTrue(userASessions.stream().noneMatch(s -> "User B Session".equals(s.getTitle())));
        assertTrue(userBSessions.stream().noneMatch(s -> "User A Session".equals(s.getTitle())));
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
