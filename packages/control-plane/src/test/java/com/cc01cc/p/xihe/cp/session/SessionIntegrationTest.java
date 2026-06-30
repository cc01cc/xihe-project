package com.cc01cc.p.xihe.cp.session;

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
import com.cc01cc.p.xihe.cp.chat.SseEmitterManager;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;

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
    private SseEmitterManager sseEmitterManager;

    private String authToken;
    private String userId;
    private String workspaceId;

    @BeforeEach
    void setUp() {
        String email = "session-int-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, "password123", "SessionIntTest");
        ResponseEntity<AuthResponse> regResponse = restTemplate.postForEntity(
                baseUrl + "/auth/register", register, AuthResponse.class);
        authToken = regResponse.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId();
        Workspace ws = workspaceRepository.save(new Workspace("session-test-workspace", userId));
        workspaceId = ws.getId();

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

        assertEquals(2, sessions.size());
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
    void deleteSession_removesSession() {
        Session session = new Session(workspaceId, userId, "To Be Deleted");
        session.setId(UUID.randomUUID().toString());
        sessionRepository.save(session);

        String sessionId = session.getId();
        assertTrue(sessionRepository.findById(sessionId).isPresent());

        sessionRepository.deleteById(sessionId);

        assertFalse(sessionRepository.findById(sessionId).isPresent());
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
        RegisterRequest registerB = new RegisterRequest(emailB, "password123", "UserB");
        restTemplate.postForEntity(baseUrl + "/auth/register", registerB, AuthResponse.class);

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

        assertEquals(1, userASessions.size());
        assertEquals("User A Session", userASessions.get(0).getTitle());

        assertEquals(1, userBSessions.size());
        assertEquals("User B Session", userBSessions.get(0).getTitle());

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
