package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.LedgerOperation;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.LedgerOperationRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.util.UUID;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verifyNoInteractions;

class ChatSubmissionServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private ChatSubmissionService submissionService;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private MessageRepository messageRepository;

    @Autowired
    private LedgerOperationRepository ledgerOperationRepository;

    @Autowired
    private EventStoreService eventStoreService;

    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;

    @Autowired
    private AuthorizationGrantRepository authorizationGrantRepository;

    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private ObjectMapper objectMapper;

    @MockitoBean
    private OperationService operationService;

    @Test
    void operationFailureRollsBackChatRunAndUserMessage() {
        User user = userRepository.save(new User(
                "chat-submit-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "Chat Submit"));
        Workspace workspace = workspaceRepository.save(new Workspace("Chat Submit Workspace", user.getId().toString()));
        Session session = new Session(workspace.getId().toString(), user.getId().toString(), "Chat Submit Session");
        session.setId(UUID.randomUUID());
        Session persistedSession = sessionRepository.save(session);

        String runId = UUID.randomUUID().toString();
        doThrow(new IllegalStateException("forced Ledger failure"))
                .when(operationService)
                .startOperation(any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any());

        AgentPrincipal principal = savePrincipal(user);
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(workspace.getId().toString(),
                user.getId().toString(), WorkspaceRole.OWNER));

        assertThrows(IllegalStateException.class, () -> submit(
                runId, persistedSession, user, workspace, "message", principal.getId().toString()));

        Session rolledBack = sessionRepository.findById(persistedSession.getId()).orElseThrow();
        assertNull(rolledBack.getAgentPrincipalId());
        assertNull(rolledBack.getAgentPermissionsSnapshot());
        assertTrue(chatRunRepository.findById(UUID.fromString(runId)).isEmpty());
        assertTrue(messageRepository.findBySessionIdOrderByCreatedAtAsc(persistedSession.getId().toString()).isEmpty());
    }

    @Test
    void createRejectsMissingDisabledOrUnboundPrincipalBeforeWritingRun() {
        User user = userRepository.save(new User(
                "chat-admission-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "Admission test"));
        Workspace workspace = workspaceRepository.save(new Workspace("Chat Admission Workspace", user.getId().toString()));
        Session session = new Session(workspace.getId().toString(), user.getId().toString(), "Admission Session");
        session.setId(UUID.randomUUID());
        Session persistedSession = sessionRepository.saveAndFlush(session);

        String missingPrincipalRunId = UUID.randomUUID().toString();
        CpApiException missing = assertThrows(CpApiException.class,
                () -> submit(missingPrincipalRunId, persistedSession, user, workspace, "rejected message"));
        assertEquals("FORBIDDEN", missing.getCode());
        assertTrue(chatRunRepository.findById(UUID.fromString(missingPrincipalRunId)).isEmpty());

        AgentPrincipal principal = savePrincipal(user);
        sessionRepository.saveAndFlush(boundSession(persistedSession, principal));
        String unboundPrincipalRunId = UUID.randomUUID().toString();
        assertRejectedWithoutWrites(unboundPrincipalRunId, persistedSession, user, workspace);

        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));
        principal.setDisabledAt(java.time.Instant.now());
        agentPrincipalRepository.saveAndFlush(principal);
        String disabledPrincipalRunId = UUID.randomUUID().toString();
        assertRejectedWithoutWrites(disabledPrincipalRunId, persistedSession, user, workspace);
        verifyNoInteractions(operationService);
    }

    @Test
    void firstChatBindsOnlyExplicitPrincipalAndStoresPrincipalWorkspaceIntersection() throws Exception {
        User user = userRepository.save(new User(
                "chat-first-bind-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "First bind test"));
        Workspace workspace = workspaceRepository.save(new Workspace("Chat First Bind Workspace", user.getId().toString()));
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(workspace.getId().toString(),
                user.getId().toString(), WorkspaceRole.OWNER));
        Session session = new Session(workspace.getId().toString(), user.getId().toString(), "Empty placeholder");
        session.setId(UUID.randomUUID());
        Session persistedSession = sessionRepository.saveAndFlush(session);
        AgentPrincipal principal = savePrincipal(user);
        addPrincipalGrant(principal, user, "read");
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.readTree(
                "[{\"actionClass\":\"read\"},{\"actionClass\":\"write\"}]")));

        String runId = UUID.randomUUID().toString();
        ChatSubmissionService.Submission submission = submit(runId, persistedSession, user, workspace,
                "first message", principal.getId().toString());

        assertEquals(UUID.fromString(runId), submission.run().getId());
        Session bound = sessionRepository.findById(persistedSession.getId()).orElseThrow();
        assertEquals(principal.getId().toString(), bound.getAgentPrincipalId());
        assertEquals(1, bound.getAgentPermissionsSnapshot().size());
        assertEquals("read", bound.getAgentPermissionsSnapshot().get(0).path("actionClass").asText());
        assertTrue(chatRunRepository.findById(UUID.fromString(runId)).isPresent());
        assertEquals(1, messageRepository.findBySessionIdOrderByCreatedAtAsc(persistedSession.getId().toString()).size());

        AgentPrincipal differentPrincipal = savePrincipal(user);
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(differentPrincipal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));
        String mismatchedRunId = UUID.randomUUID().toString();
        CpApiException mismatch = assertThrows(CpApiException.class, () -> submit(mismatchedRunId,
                persistedSession, user, workspace, "must not change identity", differentPrincipal.getId().toString()));
        assertEquals("SESSION_PRINCIPAL_MISMATCH", mismatch.getCode());
        assertTrue(chatRunRepository.findById(UUID.fromString(mismatchedRunId)).isEmpty());
        assertEquals(principal.getId().toString(),
                sessionRepository.findById(persistedSession.getId()).orElseThrow().getAgentPrincipalId());
    }

    @Test
    void historicalSessionWithMessagesCannotBeBoundToAnAgent() throws Exception {
        User user = userRepository.save(new User(
                "chat-history-bind-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "History bind test"));
        Workspace workspace = workspaceRepository.save(new Workspace("Chat History Workspace", user.getId().toString()));
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(workspace.getId().toString(),
                user.getId().toString(), WorkspaceRole.OWNER));
        Session session = new Session(workspace.getId().toString(), user.getId().toString(), "Imported history");
        session.setId(UUID.randomUUID());
        Session persistedSession = sessionRepository.saveAndFlush(session);
        messageRepository.saveAndFlush(new Message(persistedSession.getId().toString(), MessageRole.USER, "Old content"));
        AgentPrincipal principal = savePrincipal(user);
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));

        String runId = UUID.randomUUID().toString();
        CpApiException rejected = assertThrows(CpApiException.class, () -> submit(runId, persistedSession,
                user, workspace, "new content", principal.getId().toString()));

        assertEquals("SESSION_PRINCIPAL_BINDING_CONFLICT", rejected.getCode());
        Session unchanged = sessionRepository.findById(persistedSession.getId()).orElseThrow();
        assertNull(unchanged.getAgentPrincipalId());
        assertNull(unchanged.getAgentPermissionsSnapshot());
        assertTrue(chatRunRepository.findById(UUID.fromString(runId)).isEmpty());
        assertEquals(1, messageRepository.findBySessionIdOrderByCreatedAtAsc(persistedSession.getId().toString()).size());
    }

    @Test
    void userDirectLedgerSessionCannotBeBoundToAnAgent() {
        User user = userRepository.save(new User(
                "chat-user-ledger-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "User ledger test"));
        Workspace workspace = workspaceRepository.save(new Workspace("User Ledger Workspace", user.getId().toString()));
        Session session = saveEmptySession(user, workspace, "User direct operation");
        AgentPrincipal principal = savePrincipal(user);
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));
        LedgerOperation operation = new LedgerOperation();
        operation.setId(UUID.randomUUID());
        operation.setSessionId(session.getId().toString());
        operation.setWorkspaceId(workspace.getId().toString());
        operation.setUserId(user.getId().toString());
        operation.setKind("tool_call");
        operation.setSource("mcp");
        operation.setActorType("user");
        operation.setActorId(user.getId().toString());
        operation.setStatus("running");
        ledgerOperationRepository.saveAndFlush(operation);

        String runId = UUID.randomUUID().toString();
        CpApiException rejected = assertThrows(CpApiException.class, () -> submit(runId, session,
                user, workspace, "not allowed", principal.getId().toString()));

        assertEquals("SESSION_PRINCIPAL_BINDING_CONFLICT", rejected.getCode());
        assertNull(sessionRepository.findById(session.getId()).orElseThrow().getAgentPrincipalId());
        assertFalse(chatRunRepository.findById(UUID.fromString(runId)).isPresent());
    }

    @Test
    void toolContextEventSessionCannotBeBoundToAnAgent() {
        User user = userRepository.save(new User(
                "chat-tool-event-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "Tool event test"));
        Workspace workspace = workspaceRepository.save(new Workspace("Tool Event Workspace", user.getId().toString()));
        Session session = saveEmptySession(user, workspace, "User tool event");
        AgentPrincipal principal = savePrincipal(user);
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));
        eventStoreService.append(session.getId().toString(), workspace.getId().toString(),
                user.getId().toString(), "tool.started", Map.of("tool", "read_file"));

        String runId = UUID.randomUUID().toString();
        CpApiException rejected = assertThrows(CpApiException.class, () -> submit(runId, session,
                user, workspace, "not allowed", principal.getId().toString()));

        assertEquals("SESSION_PRINCIPAL_BINDING_CONFLICT", rejected.getCode());
        assertNull(sessionRepository.findById(session.getId()).orElseThrow().getAgentPrincipalId());
        assertFalse(chatRunRepository.findById(UUID.fromString(runId)).isPresent());
    }

    private Session saveEmptySession(User user, Workspace workspace, String title) {
        Session session = new Session(workspace.getId().toString(), user.getId().toString(), title);
        session.setId(UUID.randomUUID());
        return sessionRepository.saveAndFlush(session);
    }

    private void assertRejectedWithoutWrites(String runId, Session session, User user, Workspace workspace) {
        CpApiException error = assertThrows(CpApiException.class,
                () -> submit(runId, session, user, workspace, "rejected message"));
        assertEquals("FORBIDDEN", error.getCode());
        assertTrue(chatRunRepository.findById(UUID.fromString(runId)).isEmpty());
        assertTrue(messageRepository.findBySessionIdOrderByCreatedAtAsc(session.getId().toString()).isEmpty());
        assertTrue(ledgerOperationRepository.findBySessionIdOrderByCreatedAtDesc(session.getId().toString()).isEmpty());
    }

    private ChatSubmissionService.Submission submit(String runId, Session session, User user,
                                                    Workspace workspace, String content) {
        return submit(runId, session, user, workspace, content, null);
    }

    private ChatSubmissionService.Submission submit(String runId, Session session, User user,
                                                    Workspace workspace, String content, String agentPrincipalId) {
        if (agentPrincipalId != null) {
            return submissionService.create(runId, session.getId().toString(), user.getId().toString(),
                    workspace.getId().toString(), agentPrincipalId, "idem-" + runId, "request-hash",
                    "provider", "model", "none", null, null, "lease-owner", UUID.randomUUID().toString(),
                    content, "[]", java.util.List.of());
        }
        return submissionService.create(runId, session.getId().toString(), user.getId().toString(),
                workspace.getId().toString(), "idem-" + runId, "request-hash", "provider", "model",
                "none", null, null, "lease-owner", UUID.randomUUID().toString(), content, "[]", java.util.List.of());
    }

    private AgentPrincipal savePrincipal(User user) {
        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Chat admission principal");
        principal.setCreatedByUserId(user.getId().toString());
        var snapshot = objectMapper.createObjectNode();
        snapshot.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(snapshot);
        return agentPrincipalRepository.saveAndFlush(principal);
    }

    private void addPrincipalGrant(AgentPrincipal principal, User user, String actionClass) throws Exception {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setGranterType("user");
        grant.setGranterId(user.getId());
        grant.setSubjectType("agent_principal");
        grant.setSubjectId(principal.getId());
        grant.setSource("default");
        grant.setReadState("read");
        grant.setPermissions(objectMapper.readTree("[{\"actionClass\":\"" + actionClass + "\",\"resource\":\"*\"}]"));
        authorizationGrantRepository.saveAndFlush(grant);
    }

    private Session boundSession(Session session, AgentPrincipal principal) {
        session.setAgentPrincipalId(principal.getId().toString());
        session.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        return session;
    }
}
