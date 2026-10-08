package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.UUID;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;

class ChatSubmissionServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private ChatSubmissionService submissionService;

    @Autowired
    private BranchPathService branchPathService;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @org.springframework.test.context.bean.override.mockito.MockitoSpyBean
    private MessageRepository messageRepository;

    @Autowired
    private McpInvocationRepository mcpInvocationRepository;

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
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private ChatRunTerminalService terminalService;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private ObjectMapper objectMapper;


    @Test
    void messageWriteFailureRollsBackChatRunAndSessionBinding() {
        User user = userRepository.save(new User(
                "chat-submit-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "Chat Submit"));
        Workspace workspace = workspaceRepository.save(new Workspace("Chat Submit Workspace", user.getId().toString()));
        Session session = new Session(workspace.getId().toString(), user.getId().toString(), "Chat Submit Session");
        session.setId(UUID.randomUUID());
        Session persistedSession = sessionRepository.save(session);

        String runId = UUID.randomUUID().toString();
        // PLAN-0464 T1.1: startOperation is gone; the failure point after the
        // ChatRun insert is now the user-message write in the same transaction.
        doThrow(new IllegalStateException("forced message failure"))
                .when(messageRepository)
                .save(any(Message.class));

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
    void userDirectInvocationSessionCannotBeBoundToAnAgent() {
        User user = userRepository.save(new User(
                "chat-user-ledger-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "User ledger test"));
        Workspace workspace = workspaceRepository.save(new Workspace("User Ledger Workspace", user.getId().toString()));
        Session session = saveEmptySession(user, workspace, "User direct operation");
        AgentPrincipal principal = savePrincipal(user);
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));
        McpInvocation invocation = new McpInvocation();
        invocation.setId(UUID.randomUUID());
        invocation.setSessionId(session.getId().toString());
        invocation.setWorkspaceId(workspace.getId().toString());
        invocation.setUserId(user.getId().toString());
        invocation.setToolCallId(UUID.randomUUID().toString());
        invocation.setToolName("write_file");
        invocation.setSource(McpInvocation.SOURCE_DIRECT_USER);
        invocation.setStatus(McpInvocation.STATUS_ACTIVE);
        invocation.setArgumentsPreview("{}");
        mcpInvocationRepository.saveAndFlush(invocation);

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
                user.getId().toString(), "tool.called", Map.of("tool", "read_file"));

        String runId = UUID.randomUUID().toString();
        CpApiException rejected = assertThrows(CpApiException.class, () -> submit(runId, session,
                user, workspace, "not allowed", principal.getId().toString()));

        assertEquals("SESSION_PRINCIPAL_BINDING_CONFLICT", rejected.getCode());
        assertNull(sessionRepository.findById(session.getId()).orElseThrow().getAgentPrincipalId());
        assertFalse(chatRunRepository.findById(UUID.fromString(runId)).isPresent());
    }

    /**
     * 守卫绕过反向验证：直接调用服务层（不经 ChatController 的 activeRuns 单飞守卫），
     * 对同一 Session 的第二次 create 必须在 Session 行锁内被 CHAT_IN_PROGRESS 拒绝。
     * 两次 submit 的 runId 不同，因此幂等 key（"idem-" + runId）也不同——这道拒绝只能
     * 来自锁内在途复查；若缺少该检查，本用例会建出两条 ChatRun。
     */
    @Test
    void secondCreateWhileRunInFlightIsRejectedInsideSessionRowLock() {
        User user = userRepository.save(new User(
                "chat-inflight-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "In-flight test"));
        Workspace workspace = workspaceRepository.save(new Workspace("Chat In-flight Workspace", user.getId().toString()));
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(workspace.getId().toString(),
                user.getId().toString(), WorkspaceRole.OWNER));
        Session session = new Session(workspace.getId().toString(), user.getId().toString(), "In-flight Session");
        session.setId(UUID.randomUUID());
        Session persistedSession = sessionRepository.saveAndFlush(session);
        AgentPrincipal principal = savePrincipal(user);
        sessionRepository.saveAndFlush(boundSession(persistedSession, principal));
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));

        ChatSubmissionService.Submission first = submit(UUID.randomUUID().toString(),
                persistedSession, user, workspace, "first message", principal.getId().toString());
        assertTrue(chatRunRepository.findById(first.run().getId()).isPresent());

        String rejectedRunId = UUID.randomUUID().toString();
        CpApiException conflict = assertThrows(CpApiException.class, () -> submit(rejectedRunId,
                persistedSession, user, workspace, "second message", principal.getId().toString()));
        assertEquals("CHAT_IN_PROGRESS", conflict.getCode());
        assertEquals(HttpStatus.CONFLICT, conflict.getStatus());

        String sessionId = persistedSession.getId().toString();
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM chat_runs WHERE CAST(session_id AS VARCHAR) = ?",
                Integer.class, sessionId));
        List<Message> messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId);
        assertEquals(1, messages.size());
        assertEquals("first message", messages.get(0).getContent());
        assertTrue(chatRunRepository.findById(UUID.fromString(rejectedRunId)).isEmpty());
    }

    @Test
    void createClaimsPendingInboxAndLaterRunDoesNotTakeItOver() throws Exception {
        PendingInboxFixture fixture = createPendingInboxFixture("claim");
        String firstRunId = UUID.randomUUID().toString();

        ChatSubmissionService.Submission first = submit(firstRunId, fixture.session(), fixture.user(),
                fixture.workspace(), "consume first inbox", fixture.principal().getId().toString());

        assertEquals(UUID.fromString(firstRunId), first.run().getId());
        assertEquals(firstRunId, claimedRunId(fixture.inboxId()),
                "pending Inbox must be claimed by the newly-created parent ChatRun in its create transaction");

        assertTrue(terminalService.terminalize(new ChatRunTerminalService.TerminalRequest(
                firstRunId, List.of("accepted"), "succeeded", "success", null, null,
                0, 0, ChatRunTerminalService.TerminalSource.STREAM, List.of())).committed());
        String laterRunId = UUID.randomUUID().toString();
        submit(laterRunId, fixture.session(), fixture.user(), fixture.workspace(),
                "later parent run", fixture.principal().getId().toString());

        assertEquals(firstRunId, claimedRunId(fixture.inboxId()),
                "a terminal/dispatch-failed claim is durable and never automatically transferred");
    }

    @Test
    void parentCreateRollbackLeavesPendingInboxUnclaimed() throws Exception {
        PendingInboxFixture fixture = createPendingInboxFixture("claim-rollback");
        String runId = UUID.randomUUID().toString();
        TransactionTemplate transaction = new TransactionTemplate(transactionManager);

        transaction.executeWithoutResult(status -> {
            submit(runId, fixture.session(), fixture.user(), fixture.workspace(),
                    "rollback parent create", fixture.principal().getId().toString());
            assertEquals(runId, claimedRunId(fixture.inboxId()),
                    "the claim is visible inside the parent create transaction before rollback");
            status.setRollbackOnly();
        });

        assertTrue(chatRunRepository.findById(UUID.fromString(runId)).isEmpty(),
                "the parent ChatRun creation must roll back");
        assertNull(claimedRunId(fixture.inboxId()), "the Inbox claim must roll back with the parent Run");
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
        assertFalse(mcpInvocationRepository.existsBySessionId(session.getId().toString()));
    }

    private ChatSubmissionService.Submission submit(String runId, Session session, User user,
                                                    Workspace workspace, String content) {
        return submit(runId, session, user, workspace, content, null);
    }

    private ChatSubmissionService.Submission submit(String runId, Session session, User user,
                                                     Workspace workspace, String content, String agentPrincipalId) {
        String branchId = branchPathService.ensureRootBranchId(session.getId().toString());
        if (agentPrincipalId != null) {
            return submissionService.create(runId, session.getId().toString(), user.getId().toString(),
                    workspace.getId().toString(), branchId, agentPrincipalId,
                    "idem-" + runId, "request-hash",
                    "provider", "model", "none", null, null, "lease-owner", UUID.randomUUID().toString(),
                    content, "[]", java.util.List.of());
        }
        return submissionService.create(runId, session.getId().toString(), user.getId().toString(),
                workspace.getId().toString(), branchId, "idem-" + runId, "request-hash", "provider", "model",
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

    private PendingInboxFixture createPendingInboxFixture(String prefix) throws Exception {
        User user = userRepository.save(new User(
                prefix + "-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "Inbox claim test"));
        Workspace workspace = workspaceRepository.save(new Workspace(prefix + "-workspace", user.getId().toString()));
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(workspace.getId().toString(),
                user.getId().toString(), WorkspaceRole.OWNER));
        AgentPrincipal principal = savePrincipal(user);
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));
        Session session = saveEmptySession(user, workspace, prefix + "-session");
        sessionRepository.saveAndFlush(boundSession(session, principal));

        UUID inboxId = UUID.randomUUID();
        UUID childSessionId = UUID.randomUUID();
        UUID childRunId = UUID.randomUUID();
        String payload = "{\"sessionId\":\"" + childSessionId + "\",\"runId\":\"" + childRunId
                + "\",\"state\":\"success\"}";
        jdbcTemplate.update("INSERT INTO inbox (id, to_session_id, type, ref, payload_pointer) "
                        + "VALUES (?, ?, 'child_terminal', ?, CAST(? AS jsonb))",
                inboxId, session.getId(), childRunId, payload);
        return new PendingInboxFixture(user, workspace, session, principal, inboxId);
    }

    private String claimedRunId(UUID inboxId) {
        return jdbcTemplate.queryForObject("SELECT injected_run_id::text FROM inbox WHERE id = CAST(? AS UUID)",
                String.class, inboxId);
    }

    private record PendingInboxFixture(User user, Workspace workspace, Session session,
                                       AgentPrincipal principal, UUID inboxId) {}
}
