package com.cc01cc.p.xihe.cp.auth;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.AuditLog;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.files.ChatAttachmentService;
import com.cc01cc.p.xihe.cp.files.dto.BatchUploadResult;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.service.ImportService;
import com.cc01cc.p.xihe.cp.repository.AuditLogRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.mock.web.MockMultipartFile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class GrantDefaultBootstrapIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private AuthService authService;

    @Autowired
    private GrantDefaultService grantDefaultService;

    @Autowired
    private ImportService importService;

    @Autowired
    private com.cc01cc.p.xihe.cp.service.SessionService sessionService;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private MessageRepository messageRepository;

    @Autowired
    private AuthorizationGrantRepository grantRepository;

    @Autowired
    private ChatAttachmentService chatAttachmentService;

    @Autowired
    private AuditLogRepository auditLogRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    private String userId;
    private String workspaceId;
    private String sessionId;
    private final List<UUID> grantIds = new ArrayList<>();
    private final List<UUID> auditIds = new ArrayList<>();
    private final List<UUID> importedSessionIds = new ArrayList<>();

    @AfterEach
    void cleanFixtures() {
        if (sessionId != null) {
            chatAttachmentService.deleteSessionAttachments(sessionId);
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    "agent", UUID.fromString(sessionId)));
            sessionRepository.deleteById(UUID.fromString(sessionId));
        }
        for (UUID importedSessionId : importedSessionIds) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("agent", importedSessionId));
            sessionRepository.deleteById(importedSessionId);
        }
        if (userId != null) {
            grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId(
                    "user", UUID.fromString(userId)));
            auditLogRepository.findByUserIdOrderByCreatedAtDesc(userId).stream()
                    .filter(row -> "authorization_default_grant_created".equals(row.getAction()))
                    .map(AuditLog::getId)
                    .forEach(auditLogRepository::deleteById);
        }
        grantRepository.deleteAllById(grantIds);
        auditLogRepository.deleteAllById(auditIds);
        if (workspaceId != null) {
            workspaceRepository.deleteById(UUID.fromString(workspaceId));
        }
        if (userId != null) {
            userRepository.deleteById(UUID.fromString(userId));
        }
    }

    @Test
    void userAndRootSessionCreationMaterializeAuditedDefaultGrantsIdempotently() {
        String email = "grant-default-" + UUID.randomUUID() + "@test.com";
        AuthResponse registered = authService.register(new RegisterRequest(email, "grant-test-password", "Grant test"));
        userId = registered.getUser().getId();
        workspaceId = registered.getWorkspaceId();
        User user = userRepository.findById(UUID.fromString(userId)).orElseThrow();
        User seededAdmin = userRepository.findByEmail("admin@xihe.local").orElseThrow();
        AuthorizationGrant adminDefault = grantRepository.findAll().stream()
                .filter(grant -> "user".equals(grant.getSubjectType())
                        && seededAdmin.getId().equals(grant.getSubjectId())
                        && "default".equals(grant.getSource()))
                .findFirst().orElseThrow();
        assertEquals(6, adminDefault.getPermissions().size(), "DataSeeder materializes the ADMIN default matrix");
        User admin = userRepository.findByEmail("admin@xihe.local").orElseThrow();
        assertEquals(6, grantRepository.findAll().stream()
                .filter(grant -> "user".equals(grant.getSubjectType())
                        && admin.getId().equals(grant.getSubjectId())
                        && "default".equals(grant.getSource()))
                .findFirst().orElseThrow().getPermissions().size(), "ADMIN default includes credential");

        Session session = sessionService.create(userId, workspaceId, "Grant test Session", null, null);
        sessionId = session.getId().toString();

        List<AuthorizationGrant> userDefaults = grantRepository.findAll().stream()
                .filter(grant -> "user".equals(grant.getSubjectType())
                        && user.getId().equals(grant.getSubjectId())
                        && "default".equals(grant.getSource()))
                .toList();
        List<AuthorizationGrant> sessionDefaults = grantRepository.findAll().stream()
                .filter(grant -> "agent".equals(grant.getSubjectType())
                        && session.getId().equals(grant.getSubjectId())
                        && "default".equals(grant.getSource()))
                .toList();
        assertEquals(1, userDefaults.size());
        assertEquals(1, sessionDefaults.size());
        assertEquals("read", userDefaults.get(0).getReadState());
        assertEquals("read", sessionDefaults.get(0).getReadState());
        assertEquals(5, userDefaults.get(0).getPermissions().size(), "USER default excludes credential");
        assertEquals(5, sessionDefaults.get(0).getPermissions().size());

        grantIds.add(userDefaults.get(0).getId());
        grantIds.add(sessionDefaults.get(0).getId());
        List<AuditLog> auditRows = auditLogRepository.findByUserIdOrderByCreatedAtDesc(userId).stream()
                .filter(row -> "authorization_default_grant_created".equals(row.getAction()))
                .toList();
        assertEquals(2, auditRows.size(), "account and Agent-instance defaults must be audited");
        auditRows.forEach(row -> auditIds.add(row.getId()));

        grantDefaultService.ensureUserDefault(user);
        grantDefaultService.ensureAgentSessionDefault(session);
        assertEquals(1L, grantRepository.countBySubjectTypeAndSubjectIdAndSource(
                "user", user.getId(), "default"));
        assertEquals(1L, grantRepository.countBySubjectTypeAndSubjectIdAndSource(
                "agent", session.getId(), "default"));
        assertEquals(2, auditLogRepository.findByUserIdOrderByCreatedAtDesc(userId).stream()
                .filter(row -> "authorization_default_grant_created".equals(row.getAction())).count());
    }

    @Test
    void attachmentUploadCreatesRootSessionAndDefaultAgentGrant() throws IOException {
        String email = "grant-attachment-" + UUID.randomUUID() + "@test.com";
        AuthResponse registered = authService.register(new RegisterRequest(email, "grant-test-password", "Attachment grant test"));
        userId = registered.getUser().getId();
        workspaceId = registered.getWorkspaceId();
        sessionId = UUID.randomUUID().toString();

        BatchUploadResult upload = chatAttachmentService.upload(sessionId,
                List.of(new MockMultipartFile("files", "attachment.txt", "text/plain",
                        "test content".getBytes(StandardCharsets.UTF_8))),
                userId, workspaceId);

        assertEquals(1, upload.getSuccess().size());
        Session session = sessionRepository.findById(UUID.fromString(sessionId)).orElseThrow();
        assertNull(session.getKind(), "attachment upload creates a root Session");
        assertEquals(1L, grantRepository.countBySubjectTypeAndSubjectIdAndSource(
                "agent", session.getId(), "default"));
        grantRepository.findAll().stream()
                .filter(grant -> ("user".equals(grant.getSubjectType())
                        && UUID.fromString(userId).equals(grant.getSubjectId())
                        || "agent".equals(grant.getSubjectType()) && session.getId().equals(grant.getSubjectId()))
                        && "default".equals(grant.getSource()))
                .map(AuthorizationGrant::getId)
                .forEach(grantIds::add);
        auditLogRepository.findByUserIdOrderByCreatedAtDesc(userId).stream()
                .filter(row -> "authorization_default_grant_created".equals(row.getAction()))
                .forEach(row -> auditIds.add(row.getId()));
    }

    @Test
    void importCommitsSuccessfulChatsAndRollsBackOnlyFailedChat() {
        AuthResponse registered = authService.register(new RegisterRequest(
                "grant-import-" + UUID.randomUUID() + "@test.com", "grant-test-password", "Import grant test"));
        userId = registered.getUser().getId();
        workspaceId = registered.getWorkspaceId();
        UUID goodSessionId = UUID.randomUUID();
        UUID badSessionId = UUID.randomUUID();
        UUID laterSessionId = UUID.randomUUID();
        importedSessionIds.add(goodSessionId);
        importedSessionIds.add(badSessionId);
        importedSessionIds.add(laterSessionId);
        String json = """
                {"chats":[
                  {"id":"%s","title":"Good","createdAt":"2024-01-01T00:00:00Z","messages":[]},
                  {"id":"%s","title":"Bad","createdAt":"2024-01-01T00:00:00Z","messages":[
                    {"role":"user","content":"saved before later failure","createdAt":"2024-01-01T00:00:00Z"},
                    {"role":"unknown","content":"bad role","createdAt":"2024-01-01T00:00:00Z"}
                  ]},
                  {"id":"%s","title":"Later","createdAt":"2024-01-01T00:00:00Z","messages":[]}
                ]}
                """.formatted(goodSessionId, badSessionId, laterSessionId);

        ImportService.ImportResult result = importService.importChats(json, userId, workspaceId);

        assertEquals(2, result.getImported());
        assertEquals(0, result.getSkipped());
        assertNotNull(result.getLastError());
        assertEquals(goodSessionId, sessionRepository.findById(goodSessionId).orElseThrow().getId());
        assertFalse(sessionRepository.findById(badSessionId).isPresent(),
                "failed chat Session must roll back with its message insert");
        assertEquals(0, messageRepository.findBySessionIdOrderByCreatedAtAsc(badSessionId.toString()).size(),
                "messages saved before a later message failure must roll back");
        assertTrue(sessionRepository.findById(laterSessionId).isPresent(),
                "a failed chat must not prevent later chats from importing");
        assertEquals(1L, grantRepository.countBySubjectTypeAndSubjectIdAndSource(
                "agent", goodSessionId, "default"));
        assertEquals(0L, grantRepository.countBySubjectTypeAndSubjectIdAndSource(
                "agent", badSessionId, "default"));
        assertEquals(1L, grantRepository.countBySubjectTypeAndSubjectIdAndSource(
                "agent", laterSessionId, "default"));
    }

    @Test
    void concurrentDefaultEnsureCreatesOneGrantAndOneAudit() throws Exception {
        AuthResponse registered = authService.register(new RegisterRequest(
                "grant-concurrent-" + UUID.randomUUID() + "@test.com", "grant-test-password", "Concurrent grant test"));
        userId = registered.getUser().getId();
        workspaceId = registered.getWorkspaceId();
        Session session = new Session(workspaceId, userId, "Concurrent default grant Session");
        session.setId(UUID.randomUUID());
        session = sessionRepository.saveAndFlush(session);
        sessionId = session.getId().toString();
        User user = userRepository.findById(UUID.fromString(userId)).orElseThrow();
        grantRepository.deleteAll(grantRepository.findBySubjectTypeAndSubjectId("user", user.getId()));
        CountDownLatch start = new CountDownLatch(1);

        try (ExecutorService executor = Executors.newFixedThreadPool(4)) {
            Session target = session;
            var firstSessionEnsure = executor.submit(() -> {
                start.await();
                grantDefaultService.ensureAgentSessionDefault(target);
                return null;
            });
            var secondSessionEnsure = executor.submit(() -> {
                start.await();
                grantDefaultService.ensureAgentSessionDefault(target);
                return null;
            });
            var firstUserEnsure = executor.submit(() -> {
                start.await();
                grantDefaultService.ensureUserDefault(user);
                return null;
            });
            var secondUserEnsure = executor.submit(() -> {
                start.await();
                grantDefaultService.ensureUserDefault(user);
                return null;
            });
            start.countDown();
            firstSessionEnsure.get(10, TimeUnit.SECONDS);
            secondSessionEnsure.get(10, TimeUnit.SECONDS);
            firstUserEnsure.get(10, TimeUnit.SECONDS);
            secondUserEnsure.get(10, TimeUnit.SECONDS);
        }

        assertEquals(1L, grantRepository.countBySubjectTypeAndSubjectIdAndSource(
                "agent", session.getId(), "default"));
        AuthorizationGrant sessionGrant = grantRepository.findBySubjectTypeAndSubjectId("agent", session.getId())
                .stream().filter(grant -> "default".equals(grant.getSource())).findFirst().orElseThrow();
        assertEquals(1, auditLogRepository.findByUserIdOrderByCreatedAtDesc(userId).stream()
                .filter(row -> "authorization_default_grant_created".equals(row.getAction()))
                .filter(row -> sessionGrant.getId().toString().equals(row.getResourceId()))
                .count());
        assertEquals(1L, grantRepository.countBySubjectTypeAndSubjectIdAndSource(
                "user", user.getId(), "default"));
        AuthorizationGrant userGrant = grantRepository.findBySubjectTypeAndSubjectId("user", user.getId())
                .stream().filter(grant -> "default".equals(grant.getSource())).findFirst().orElseThrow();
        assertEquals(1, auditLogRepository.findByUserIdOrderByCreatedAtDesc(userId).stream()
                .filter(row -> "authorization_default_grant_created".equals(row.getAction()))
                .filter(row -> userGrant.getId().toString().equals(row.getResourceId()))
                .count());
    }
}
