package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.AuthorizationGrantRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
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
import static org.junit.jupiter.api.Assertions.assertNotNull;
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
    private com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository sessionParticipantRepository;

    @Autowired
    private com.cc01cc.p.xihe.cp.repository.ProviderConnectionRepository providerConnectionRepository;

    @Autowired
    private com.cc01cc.p.xihe.cp.service.ApiRequestTemplateService apiRequestTemplates;

    /** PLAN-0645: cap=1 is the rollback valve and must reproduce the frozen single-flight answer. */
    @Autowired
    private ConfigService configService;

    private Session saveBoundChatSession(Session session, User user) {
        ChatBindingTestSupport.bindNewChatConnection(
                session, providerConnectionRepository, apiRequestTemplates, user.getId().toString());
        return sessionRepository.saveAndFlush(session);
    }

    @Autowired
    private ChatRunRepository chatRunRepository;

    @org.springframework.test.context.bean.override.mockito.MockitoSpyBean
    private MessageRepository messageRepository;

    @Autowired
    private McpInvocationRepository mcpInvocationRepository;

    @Autowired
    private EventStoreService eventStoreService;

    @Autowired
    private MessageReadService messageReadService;

    @Autowired
    private AgentPrincipalRepository agentPrincipalRepository;

    @Autowired
    private AuthorizationGrantRepository authorizationGrantRepository;

    @Autowired
    private WorkspaceAgentRepository workspaceAgentRepository;

    @Autowired
    private WorkspaceFixture workspaceFixture;

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
        User user = userRepository.save(new User("chat-submit-" + UUID.randomUUID() + "@test.com", "hash", "Chat Submit"));
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Chat Submit Workspace", user.getId().toString());
        Session session = new Session(workspace.getId().toString(), user.getId().toString(), "Chat Submit Session");
        session.setId(UUID.randomUUID());
        Session persistedSession = saveBoundChatSession(session, user);

        String runId = UUID.randomUUID().toString();
        // PLAN-0464 T1.1: startOperation is gone; the failure point after the
        // ChatRun insert is now the user-message write in the same transaction.
        doThrow(new IllegalStateException("forced message failure"))
                .when(messageRepository)
                .save(any(Message.class));

        AgentPrincipal principal = savePrincipal(user);
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));
        workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), user.getId().toString(), WorkspaceRole.OWNER);

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
        User user = userRepository.save(new User("chat-admission-" + UUID.randomUUID() + "@test.com", "hash", "Admission test"));
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Chat Admission Workspace", user.getId().toString());
        Session session = new Session(workspace.getId().toString(), user.getId().toString(), "Admission Session");
        session.setId(UUID.randomUUID());
        Session persistedSession = saveBoundChatSession(session, user);

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
        // PLAN-0622 V15 (Lead ruling 2026-11-02): a disabled principal is a STATE CONFLICT (409
        // AGENT_PRINCIPAL_DISABLED), not a permission problem, so it must not be masked as 403.
        assertRejectedWithoutWrites(disabledPrincipalRunId, persistedSession, user, workspace,
                HttpStatus.CONFLICT, "AGENT_PRINCIPAL_DISABLED");
    }

    @Test
    void firstChatBindsOnlyExplicitPrincipalAndStoresPrincipalWorkspaceIntersection() throws Exception {
        User user = userRepository.save(new User("chat-first-bind-" + UUID.randomUUID() + "@test.com", "hash", "First bind test"));
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Chat First Bind Workspace", user.getId().toString());
        workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), user.getId().toString(), WorkspaceRole.OWNER);
        Session session = new Session(workspace.getId().toString(), user.getId().toString(), "Empty placeholder");
        session.setId(UUID.randomUUID());
        Session persistedSession = saveBoundChatSession(session, user);
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
        User user = userRepository.save(new User("chat-history-bind-" + UUID.randomUUID() + "@test.com", "hash", "History bind test"));
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Chat History Workspace", user.getId().toString());
        workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), user.getId().toString(), WorkspaceRole.OWNER);
        Session session = new Session(workspace.getId().toString(), user.getId().toString(), "Imported history");
        session.setId(UUID.randomUUID());
        Session persistedSession = saveBoundChatSession(session, user);
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
        User user = userRepository.save(new User("chat-user-ledger-" + UUID.randomUUID() + "@test.com", "hash", "User ledger test"));
        Workspace workspace = workspaceFixture.createOwnedWorkspace("User Ledger Workspace", user.getId().toString());
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
        User user = userRepository.save(new User("chat-tool-event-" + UUID.randomUUID() + "@test.com", "hash", "Tool event test"));
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Tool Event Workspace", user.getId().toString());
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
     * PLAN-0645 V3（cap=1 逐项等价）：把回滚开关切到 cap=1 后，直接调用服务层（不经
     * ChatController 的本地 claim），对同一 Session 的第二次 create 必须在 Session 行锁内被
     * CHAT_IN_PROGRESS 拒绝。两次 submit 的 runId 不同，因此幂等 key（"idem-" + runId）也不同
     * ——这道拒绝只能来自锁内计数门；若缺少该检查，本用例会建出两条 ChatRun。
     */
    @Test
    void secondCreateIsRejectedWhenTheSessionRunCapIsOne() {
        configService.putLayer("instance", "agent-runtime",
                Map.of("maxConcurrentRunsPerSession", "1"), "test", null, null);
        try {
            User user = userRepository.save(new User("chat-inflight-" + UUID.randomUUID() + "@test.com", "hash", "In-flight test"));
            Workspace workspace = workspaceFixture.createOwnedWorkspace("Chat In-flight Workspace", user.getId().toString());
            workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), user.getId().toString(), WorkspaceRole.OWNER);
            Session session = new Session(workspace.getId().toString(), user.getId().toString(), "In-flight Session");
            session.setId(UUID.randomUUID());
            Session persistedSession = saveBoundChatSession(session, user);
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
        } finally {
            configService.deleteKey("instance", "agent-runtime",
                    "maxConcurrentRunsPerSession", "test", null, null);
        }
    }

    /**
     * BL-283（PLAN-0660 T2.1 同族）：唤醒路径用**返回值**问准入要 slot。cap 满时答案是一个空
     * Optional，而关键点是**调用方事务仍可提交** —— 原先 `createScheduled` 抛出的 409 会穿过它
     * 自己的 REQUIRED 事务边界，把共享事务标成 rollback-only，deferred 入队与 wake 审计随事务一起
     * 回滚，提交时变成 `UnexpectedRollbackException`（BL-283：该唤醒既没跑也没留下"顺延"事实）。
     *
     * <p>本用例把 `tryCreateScheduled` 放进一个真实事务：cap 满 ⇒ 返回空；随后在同一事务里做一次
     * 可观测写入并提交。若事务被标脏，`execute` 会在提交时抛 `UnexpectedRollbackException`；若没被
     * 标脏，写入必须持久化。</p>
     */
    @Test
    void tryCreateScheduled_returnsEmptyWhenTheCapIsFull_andTheCallerTransactionStillCommits() {
        configService.putLayer("instance", "agent-runtime",
                Map.of("maxConcurrentRunsPerSession", "1"), "test", null, null);
        try {
            User user = userRepository.save(new User("bl283-deferred-" + UUID.randomUUID() + "@test.com", "hash", "BL-283 deferred test"));
            Workspace workspace = workspaceFixture.createOwnedWorkspace("BL-283 Deferred Workspace", user.getId().toString());
            workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), user.getId().toString(), WorkspaceRole.OWNER);
            Session session = new Session(workspace.getId().toString(), user.getId().toString(), "BL-283 Deferred Session");
            session.setId(UUID.randomUUID());
            Session persistedSession = saveBoundChatSession(session, user);
            AgentPrincipal principal = savePrincipal(user);
            sessionRepository.saveAndFlush(boundSession(persistedSession, principal));
            workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                    workspace.getId().toString(), objectMapper.createArrayNode()));

            // Occupy the only slot.
            ChatSubmissionService.Submission first = submit(UUID.randomUUID().toString(),
                    persistedSession, user, workspace, "first message", principal.getId().toString());
            assertTrue(chatRunRepository.findById(first.run().getId()).isPresent());

            String sessionId = persistedSession.getId().toString();
            String deferredRunId = UUID.randomUUID().toString();
            TransactionTemplate transaction = new TransactionTemplate(transactionManager);
            transaction.executeWithoutResult(status -> {
                String branchId = branchPathService.ensureRootBranchId(sessionId);
                var deferred = submissionService.tryCreateScheduled(deferredRunId, sessionId,
                        user.getId().toString(), workspace.getId().toString(), branchId,
                        "idem-" + deferredRunId, "request-hash", "provider", "model", "none", null, null,
                        "lease-owner", UUID.randomUUID().toString(), "deferred wake prompt", "[]",
                        java.util.List.of(),
                        com.cc01cc.p.xihe.cp.entity.Message.VISIBILITY_INTERNAL);
                assertTrue(deferred.isEmpty(),
                        "a full cap must answer as a value (empty), not as a thrown exception");
                jdbcTemplate.update("UPDATE sessions SET title = ? WHERE id = CAST(? AS UUID)",
                        "bl283-committed", sessionId);
            });

            assertEquals("bl283-committed", jdbcTemplate.queryForObject(
                    "SELECT title FROM sessions WHERE id = CAST(? AS UUID)", String.class, sessionId),
                    "the caller transaction must commit — a rollback-only marker would have thrown "
                            + "UnexpectedRollbackException instead");
            assertEquals(1, jdbcTemplate.queryForObject(
                    "SELECT count(*) FROM chat_runs WHERE CAST(session_id AS VARCHAR) = ?",
                    Integer.class, sessionId), "the deferred attempt must not create a run row");
            assertTrue(chatRunRepository.findById(UUID.fromString(deferredRunId)).isEmpty());
        } finally {
            configService.deleteKey("instance", "agent-runtime",
                    "maxConcurrentRunsPerSession", "test", null, null);
        }
    }

    /**
     * PLAN-0645 V1（服务层）：默认 cap=2 时，第一条 run 仍在非终态，第二次 create 必须被接纳，
     * 且两条 run 同时非终态、user Message 各一条。
     */
    @Test
    void secondCreateIsAdmittedWhileTheFirstRunIsStillInFlight() {
        User user = userRepository.save(new User("chat-parallel-" + UUID.randomUUID() + "@test.com", "hash", "Parallel test"));
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Chat Parallel Workspace", user.getId().toString());
        workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), user.getId().toString(), WorkspaceRole.OWNER);
        Session session = new Session(workspace.getId().toString(), user.getId().toString(), "Parallel Session");
        session.setId(UUID.randomUUID());
        Session persistedSession = saveBoundChatSession(session, user);
        AgentPrincipal principal = savePrincipal(user);
        sessionRepository.saveAndFlush(boundSession(persistedSession, principal));
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));

        ChatSubmissionService.Submission first = submit(UUID.randomUUID().toString(),
                persistedSession, user, workspace, "first message", principal.getId().toString());
        ChatSubmissionService.Submission second = submit(UUID.randomUUID().toString(),
                persistedSession, user, workspace, "second message", principal.getId().toString());

        assertNotNull(first.run().getId());
        assertNotNull(second.run().getId());
        String sessionId = persistedSession.getId().toString();
        assertEquals(2, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM chat_runs WHERE CAST(session_id AS VARCHAR) = ?",
                Integer.class, sessionId));
        assertEquals(2, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM chat_runs WHERE CAST(session_id AS VARCHAR) = ? "
                        + "AND status IN ('accepted','queued','running','streaming',"
                        + "'awaiting_approval','dispatching','cancelling')",
                Integer.class, sessionId),
                "both admitted runs stay non-terminal until they are dispatched/terminalized");
        List<Message> messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId);
        assertEquals(2, messages.size());
        assertEquals(List.of("first message", "second message"),
                messages.stream().map(Message::getContent).toList());
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
        return saveBoundChatSession(session, user);
    }


    // ---------------------------------------------------------------------------------------------
    // PLAN-0622 V15 (Lead ruling): disabling takes effect on the NEXT submission of an EXISTING
    // session — the first submission already succeeded, the second one is refused with 409.
    // ---------------------------------------------------------------------------------------------

    @Test
    void disablingAPrincipalBlocksTheSecondSubmissionOfAnExistingSession() throws Exception {
        ChatFixture fixture = createChatFixture("v15-second-submission");

        String firstRunId = UUID.randomUUID().toString();
        ChatSubmissionService.Submission first = submit(firstRunId, fixture.session(), fixture.user(),
                fixture.workspace(), "first message", fixture.principal().getId().toString());
        assertEquals(UUID.fromString(firstRunId), first.run().getId());

        fixture.principal().setDisabledAt(java.time.Instant.now());
        agentPrincipalRepository.saveAndFlush(fixture.principal());

        String secondRunId = UUID.randomUUID().toString();
        CpApiException error = assertThrows(CpApiException.class,
                () -> submit(secondRunId, fixture.session(), fixture.user(), fixture.workspace(),
                        "second message", fixture.principal().getId().toString()));
        assertEquals(HttpStatus.CONFLICT, error.getStatus());
        assertEquals("AGENT_PRINCIPAL_DISABLED", error.getCode());
        assertTrue(chatRunRepository.findById(UUID.fromString(secondRunId)).isEmpty(),
                "a refused submission must not persist a run");
    }
    private void assertRejectedWithoutWrites(String runId, Session session, User user, Workspace workspace) {
        assertRejectedWithoutWrites(runId, session, user, workspace, HttpStatus.FORBIDDEN, "FORBIDDEN");
    }

    private void assertRejectedWithoutWrites(String runId, Session session, User user, Workspace workspace,
                                             HttpStatus expectedStatus, String expectedCode) {
        CpApiException error = assertThrows(CpApiException.class,
                () -> submit(runId, session, user, workspace, "rejected message"));
        assertEquals(expectedStatus, error.getStatus());
        assertEquals(expectedCode, error.getCode());
        assertTrue(chatRunRepository.findById(UUID.fromString(runId)).isEmpty());
        assertTrue(messageRepository.findBySessionIdOrderByCreatedAtAsc(session.getId().toString()).isEmpty());
        assertFalse(mcpInvocationRepository.existsBySessionId(session.getId().toString()));
    }

    @Test
    void persistsToolOnlyTurnWithV2SnapshotAndProjectsItAfterRefresh() {
        ChatFixture fixture = createChatFixture("tool-snapshot");
        String runId = UUID.randomUUID().toString();
        ChatSubmissionService.Submission submission = submit(runId, fixture.session(), fixture.user(),
                fixture.workspace(), "prompt", fixture.principal().getId().toString());
        String branchId = submission.run().getBranchId();
        String callId = UUID.randomUUID().toString();

        appendToolEvent(fixture, runId, branchId, "tool.called", Map.of(
                "schemaVersion", 2,
                "toolCallId", callId,
                "toolName", "read_file",
                "runId", runId,
                "arguments", Map.of("path", "src/main.rs")));
        appendToolEvent(fixture, runId, branchId, "tool.result", Map.of(
                "schemaVersion", 2,
                "toolCallId", callId,
                "toolName", "read_file",
                "runId", runId,
                "status", "completed",
                "result", "placeholder"));

        String messageId = submissionService.persistAssistantResponse(
                fixture.session().getId().toString(), runId, "");
        assertNotNull(messageId);
        Message stored = messageRepository.findById(UUID.fromString(messageId)).orElseThrow();
        assertEquals("", stored.getContent());
        assertNotNull(stored.getToolCalls());
        assertTrue(stored.getToolCalls().contains(callId));
        assertFalse(stored.getToolCalls().contains("request_approval"));

        BranchPathService.BranchVisibility visibility = branchPathService.resolveVisibility(
                fixture.session().getId().toString(), branchId);
        String rootBranchId = branchPathService.resolvePath(fixture.session().getId().toString(), branchId);
        List<Map<String, Object>> messages = messageReadService.listVisibleMessages(
                fixture.session().getId().toString(), fixture.workspace().getId().toString(),
                rootBranchId, visibility);
        Map<String, Object> assistant = messages.stream()
                .filter(message -> messageId.equals(String.valueOf(message.get("id"))))
                .findFirst()
                .orElseThrow();
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> cards = (List<Map<String, Object>>) assistant.get("toolCalls");
        assertNotNull(cards);
        assertEquals(1, cards.size());
        assertEquals(callId, cards.get(0).get("id"));
        assertEquals("read_file", cards.get(0).get("name"));
        assertEquals("{\"path\":\"src/main.rs\"}", cards.get(0).get("arguments"));
        assertEquals("completed", cards.get(0).get("status"));
        assertNotNull(cards.get(0).get("result"));
    }

    @Test
    void refusalCodeSurvivesTheDurableSanitizerSnapshotAndTheMessageListing() {
        // PLAN-0649 M2 (T2.2/T2.4): the code is metadata, so it must survive the three carriers on
        // one path — sanitized durable event → assistant Message snapshot → GET /messages DTO —
        // while the body stays the CP placeholder at every hop.
        // Both the original budget code and the table extension added 2026-11-04 must survive: the
        // shape gate only checks the pattern, so a code that is malformed (or dropped as unknown)
        // would silently lose the refusal reason on the wire.
        for (String code : List.of(
                ToolRefusalCodes.DELEGATION_LIMIT_EXCEEDED,
                ToolRefusalCodes.SPAWN_ARGUMENTS_INVALID)) {
            assertRefusalCodeSurvivesAllCarriers(code);
        }
    }

    private void assertRefusalCodeSurvivesAllCarriers(String refusalCode) {
        ChatFixture fixture = createChatFixture("tool-refusal");
        String runId = UUID.randomUUID().toString();
        ChatSubmissionService.Submission submission = submit(runId, fixture.session(), fixture.user(),
                fixture.workspace(), "prompt", fixture.principal().getId().toString());
        String branchId = submission.run().getBranchId();
        String callId = UUID.randomUUID().toString();

        appendToolEvent(fixture, runId, branchId, "tool.called", Map.of(
                "schemaVersion", 2,
                "toolCallId", callId,
                "toolName", "spawn_agent",
                "runId", runId,
                "arguments", Map.of("prompt", "do the subtask")));
        appendToolEvent(fixture, runId, branchId, "tool.result", Map.of(
                "schemaVersion", 2,
                "toolCallId", callId,
                "toolName", "spawn_agent",
                "runId", runId,
                "status", "failed",
                "refusalCode", refusalCode,
                "result", "WORKSPACE-PRIVATE-TOOL-BODY"));

        String messageId = submissionService.persistAssistantResponse(
                fixture.session().getId().toString(), runId, "");
        Message stored = messageRepository.findById(UUID.fromString(messageId)).orElseThrow();
        assertTrue(stored.getToolCalls().contains(refusalCode),
                "the durable snapshot must carry " + refusalCode);
        assertFalse(stored.getToolCalls().contains("WORKSPACE-PRIVATE-TOOL-BODY"),
                "the body must never reach the persisted snapshot");

        BranchPathService.BranchVisibility visibility = branchPathService.resolveVisibility(
                fixture.session().getId().toString(), branchId);
        String rootBranchId = branchPathService.resolvePath(fixture.session().getId().toString(), branchId);
        List<Map<String, Object>> messages = messageReadService.listVisibleMessages(
                fixture.session().getId().toString(), fixture.workspace().getId().toString(),
                rootBranchId, visibility);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> cards = (List<Map<String, Object>>) messages.stream()
                .filter(message -> messageId.equals(String.valueOf(message.get("id"))))
                .findFirst()
                .orElseThrow()
                .get("toolCalls");

        assertNotNull(cards);
        assertEquals(1, cards.size());
        assertEquals("failed", cards.get(0).get("status"));
        assertEquals(refusalCode, cards.get(0).get("refusalCode"));
        assertFalse(String.valueOf(cards.get(0).get("result")).contains("WORKSPACE-PRIVATE-TOOL-BODY"));
    }

    @Test
    void persistsLegacySnapshotAndFiltersApprovalTool() throws Exception {
        ChatFixture fixture = createChatFixture("tool-legacy");
        String runId = UUID.randomUUID().toString();
        ChatSubmissionService.Submission submission = submit(runId, fixture.session(), fixture.user(),
                fixture.workspace(), "prompt", fixture.principal().getId().toString());
        String branchId = submission.run().getBranchId();

        appendToolEvent(fixture, runId, branchId, "tool.called", Map.of(
                "call_id", "approval-call", "tool_name", "request_approval",
                "tool_input", Map.of("action", "approve")));
        appendToolEvent(fixture, runId, branchId, "tool.called", Map.of(
                "call_id", "legacy-call", "tool_name", "execute_command",
                "tool_input", Map.of("command", "cargo test")));
        appendToolEvent(fixture, runId, branchId, "tool.result", Map.of(
                "call_id", "legacy-call", "tool_name", "execute_command",
                "status", "failed", "result", "boom"));

        String messageId = submissionService.persistAssistantResponse(
                fixture.session().getId().toString(), runId, "done");
        assertNotNull(messageId);
        Message stored = messageRepository.findById(UUID.fromString(messageId)).orElseThrow();
        assertFalse(stored.getToolCalls().contains("approval-call"));
        assertTrue(stored.getToolCalls().contains("legacy-call"));
        var card = objectMapper.readTree(stored.getToolCalls()).path("calls").get(0);
        assertEquals("legacy-call", card.path("id").asText());
        assertEquals("execute_command", card.path("name").asText());
        assertEquals("failed", card.path("status").asText());
    }

    @Test
    void persistsInterruptedToolOnlyTurnWithRunningCard() throws Exception {
        ChatFixture fixture = createChatFixture("tool-interrupted");
        String runId = UUID.randomUUID().toString();
        ChatSubmissionService.Submission submission = submit(runId, fixture.session(), fixture.user(),
                fixture.workspace(), "prompt", fixture.principal().getId().toString());
        String branchId = submission.run().getBranchId();

        appendToolEvent(fixture, runId, branchId, "tool.called", Map.of(
                "call_id", "interrupted-call", "tool_name", "read_file",
                "tool_input", Map.of("path", "README.md")));

        String messageId = submissionService.persistAssistantResponse(
                fixture.session().getId().toString(), runId, "");
        assertNotNull(messageId);
        Message stored = messageRepository.findById(UUID.fromString(messageId)).orElseThrow();
        var card = objectMapper.readTree(stored.getToolCalls()).path("calls").get(0);
        assertEquals("interrupted-call", card.path("id").asText());
        assertEquals("running", card.path("status").asText());
        assertFalse(card.has("completedAt"));
    }

    @Test
    void skipsBlankTurnWithoutTools() {
        ChatFixture fixture = createChatFixture("tool-empty");
        String runId = UUID.randomUUID().toString();
        submit(runId, fixture.session(), fixture.user(), fixture.workspace(),
                "prompt", fixture.principal().getId().toString());

        String messageId = submissionService.persistAssistantResponse(
                fixture.session().getId().toString(), runId, "");

        assertNull(messageId);
        assertTrue(messageRepository.findBySessionIdOrderByCreatedAtAsc(
                        fixture.session().getId().toString()).stream()
                .noneMatch(message -> message.getRole() == MessageRole.ASSISTANT));
    }

    private void appendToolEvent(ChatFixture fixture, String runId, String branchId,
                                 String eventType, Map<String, Object> payload) {
        eventStoreService.append(fixture.session().getId().toString(),
                fixture.workspace().getId().toString(), fixture.user().getId().toString(),
                eventType, payload, runId, branchId);
    }

    private ChatFixture createChatFixture(String prefix) {
        User user = userRepository.save(new User(prefix + "-" + UUID.randomUUID() + "@test.com", "hash", "Tool snapshot"));
        Workspace workspace = workspaceFixture.createOwnedWorkspace(prefix + " Workspace", user.getId().toString());
        workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), user.getId().toString(), WorkspaceRole.OWNER);
        Session session = new Session(workspace.getId().toString(), user.getId().toString(), prefix + " Session");
        session.setId(UUID.randomUUID());
        Session persistedSession = saveBoundChatSession(session, user);
        AgentPrincipal principal = savePrincipal(user);
        try {
            addPrincipalGrant(principal, user, "read");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()
                .add(objectMapper.createObjectNode().put("actionClass", "read"))));
        return new ChatFixture(user, workspace, persistedSession, principal);
    }

    private record ChatFixture(User user, Workspace workspace, Session session, AgentPrincipal principal) {
    }

    private ChatSubmissionService.Submission submit(String runId, Session session, User user,
                                                    Workspace workspace, String content) {
        String branchId = branchPathService.ensureRootBranchId(session.getId().toString());
        return submissionService.create(runId, session.getId().toString(), user.getId().toString(),
                workspace.getId().toString(), branchId, "idem-" + runId, "request-hash", "provider", "model",
                "none", null, null, "lease-owner", UUID.randomUUID().toString(), content, "[]", java.util.List.of());
    }

    /**
     * PLAN-0689 A4b: the submission signatures no longer take a run principal — the responder is
     * resolved server-side (explicit {@code as} &gt; PRIMARY) and stamped at admission. This overload is
     * kept so the ~25 call sites do not have to drop an argument that never selected a responder;
     * {@code ignoredPrincipalId} is intentionally unread.
     */
    private ChatSubmissionService.Submission submit(String runId, Session session, User user,
                                                     Workspace workspace, String content,
                                                     String ignoredPrincipalId) {
        return submit(runId, session, user, workspace, content);
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
        grant.setSource("role");
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
        User user = userRepository.save(new User(prefix + "-" + UUID.randomUUID() + "@test.com", "hash", "Inbox claim test"));
        Workspace workspace = workspaceFixture.createOwnedWorkspace(prefix + "-workspace", user.getId().toString());
        workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), user.getId().toString(), WorkspaceRole.OWNER);
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

    /**
     * PLAN-0678 T2.1 (BL-284 / BL-285 anti-regression): a real admission must freeze BOTH the
     * memory ({@code agent_memory}) and the skills ({@code skill_catalog}) component in
     * {@code chat_runs.context_template_snapshot}. The 11-05 fixes that merged the component
     * manifest were never asserted on the DB path — a revert of {@code 1dfab579} (BL-284) or
     * {@code 939c8e6b} (BL-285) would otherwise pass every mock.
     */
    @Test
    void admissionSnapshotFreezesMemoryAndSkillComponents() {
        ChatFixture fixture = createChatFixture("bl284-285");
        String runId = UUID.randomUUID().toString();
        ChatSubmissionService.Submission submission = submit(runId, fixture.session(), fixture.user(),
                fixture.workspace(), "snapshot guard", fixture.principal().getId().toString());

        var snapshot = submission.run().getContextTemplateSnapshot();
        var components = snapshot.path("template").path("components");
        assertTrue(components.isArray(), "the frozen snapshot must carry a component manifest: " + snapshot);
        java.util.Set<String> types = new java.util.HashSet<>();
        components.forEach(component -> types.add(component.path("type").asText()));
        assertTrue(types.contains("agent_memory"),
                "missing agent_memory — someone reverted BL-284 (1dfab579): the memory component "
                        + "dropped out of the admission snapshot; components=" + types);
        assertTrue(types.contains("skill_catalog"),
                "missing skill_catalog — someone reverted BL-285 (939c8e6b): the skills component "
                        + "dropped out of the admission snapshot; components=" + types);

        ChatRun persisted = chatRunRepository.findById(UUID.fromString(runId)).orElseThrow();
        assertTrue(persisted.getContextTemplateSnapshot().path("template").path("components")
                        .findValuesAsText("type").containsAll(java.util.List.of("agent_memory", "skill_catalog")),
                "the persisted row is the contract; an in-memory snapshot alone proves nothing");
    }

    /**
     * PLAN-0678 T2.2 (BL-347): a NULL-principal parent must be refused explicitly on the human
     * delegation route too — the child would otherwise inherit an unowned derived chain.
     */
    @Test
    void delegationRefusesParentSessionWithoutAgentPrincipal() throws Exception {
        User user = userRepository.save(new User("deleg-null-" + UUID.randomUUID() + "@test.com",
                "hash", "Delegation null principal"));
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Delegation Null Workspace",
                user.getId().toString());
        workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), user.getId().toString(),
                WorkspaceRole.OWNER);
        AgentPrincipal principal = savePrincipal(user);
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));

        Session parent = new Session(workspace.getId().toString(), user.getId().toString(),
                "Null principal parent");
        parent.setId(UUID.randomUUID());
        parent.setAgentPrincipalId(null);
        parent.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        saveBoundChatSession(parent, user);
        String parentRunId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(parentRunId, parent.getId().toString(),
                user.getId().toString(), workspace.getId().toString(), "parent-null-" + parentRunId,
                "parent-hash", "provider", "model", "workspace", "succeeded"));

        String idempotencyKey = "deleg-null-" + UUID.randomUUID();
        String authorizationBody = submissionService.delegationAuthorizationBody("task");
        CpApiException refused = assertThrows(CpApiException.class, () -> submissionService.createDelegation(
                parentRunId, principal.getId().toString(), "task", idempotencyKey,
                new ChatSubmissionService.SpawnAuthorization(authorizationBody, null, null)));
        assertEquals("SPAWN_PARENT_PRINCIPAL_MISSING", refused.getCode());
        assertEquals(HttpStatus.CONFLICT, refused.getStatus());
        assertTrue(chatRunRepository.findAll().stream()
                        .noneMatch(run -> idempotencyKey.equals(run.getIdempotencyKey())),
                "no derived run may be written for a NULL-principal parent");
    }

    // ---------------------------------------------------------- PLAN-0655 human delegation

    /**
     * The end-to-end settlement contract behind the human route: a delegation child carries full
     * provenance (spawned_from_session/run + waiting link) because
     * {@code ChatRunTerminalService.lockParentLink} rejects a spawn child without it. Code review
     * was not enough for the PLAN — this drives the child to a terminal state and asserts the
     * invariant holds (a missing provenance row would throw instead of committing).
     */
    @Test
    void humanDelegationChildCarriesProvenanceAndSettlesItsTerminalState() {
        User user = userRepository.save(new User("deleg-" + UUID.randomUUID() + "@test.com", "hash", "Delegator"));
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Delegation Workspace",
                user.getId().toString());
        workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), user.getId().toString(),
                WorkspaceRole.OWNER);
        AgentPrincipal principal = savePrincipal(user);
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));

        Session parent = new Session(workspace.getId().toString(), user.getId().toString(),
                "Delegation Parent");
        parent.setId(UUID.randomUUID());
        parent.setAgentPrincipalId(principal.getId().toString());
        parent.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        saveBoundChatSession(parent, user);

        // The parent's latest run, already terminal — the human route never waits on it; it exists
        // purely as the provenance anchor the settlement invariant requires.
        String parentRunId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(parentRunId, parent.getId().toString(),
                user.getId().toString(), workspace.getId().toString(), "parent-key-" + parentRunId,
                "parent-hash", "provider", "model", "workspace", "succeeded"));

        String idempotencyKey = "deleg-" + UUID.randomUUID();
        String authorizationBody = submissionService.delegationAuthorizationBody("translate this paragraph");
        ChatSubmissionService.SpawnResult child = submissionService.createDelegation(
                parentRunId, principal.getId().toString(), "translate this paragraph", idempotencyKey,
                new ChatSubmissionService.SpawnAuthorization(authorizationBody, null, null));

        Session childSession = sessionRepository.findById(UUID.fromString(child.sessionId())).orElseThrow();
        assertEquals(Session.KIND_SPAWN, childSession.getKind());
        assertEquals(parent.getId(), childSession.getSpawnedFromSessionId());
        assertEquals(UUID.fromString(parentRunId), childSession.getSpawnedFromRunId());
        assertEquals(principal.getId().toString(), childSession.getAgentPrincipalId());
        assertEquals(1, sessionParticipantRepository.findBySessionIdOrderByOrderIndexAsc(childSession.getId()).size(),
                "the child owns exactly one PRIMARY — the same rule as create/fork/spawn");

        ChatRun childRun = chatRunRepository.findById(UUID.fromString(child.runId())).orElseThrow();
        assertEquals(ChatRun.ORIGIN_SPAWN, childRun.getOrigin());
        assertEquals("accepted", childRun.getStatus());
        assertEquals(parentRunId, childRun.getWaitingOnRunId());
        assertEquals(
                UUID.nameUUIDFromBytes(idempotencyKey.getBytes(java.nio.charset.StandardCharsets.UTF_8)),
                UUID.fromString(childRun.getWaitingToolCallId()),
                "the waiting tool-call id is a stable 36-char derivation of the idempotency key");

        // The settlement itself: a provenance gap here throws Spawn child is missing parent
        // provenance / waiting link instead of committing.
        assertTrue(terminalService.terminalize(new ChatRunTerminalService.TerminalRequest(
                child.runId(), List.of("accepted"), "succeeded", "success", null, null,
                0, 0, ChatRunTerminalService.TerminalSource.STREAM, List.of())).committed(),
                "the child settles cleanly against the human parent anchor");
        ChatRun settled = chatRunRepository.findById(UUID.fromString(child.runId())).orElseThrow();
        assertEquals("succeeded", settled.getStatus());
        assertNotNull(settled.getTerminalAt());
    }

    @Test
    void delegationReplayOfTheSameKeyReturnsTheExistingChildWithoutSpendingBudgetAgain() {
        User user = userRepository.save(new User("deleg-rp-" + UUID.randomUUID() + "@test.com", "hash", "Delegator"));
        Workspace workspace = workspaceFixture.createOwnedWorkspace("Delegation Replay Workspace",
                user.getId().toString());
        workspaceFixture.bindWorkspaceRole(workspace.getId().toString(), user.getId().toString(),
                WorkspaceRole.OWNER);
        AgentPrincipal principal = savePrincipal(user);
        workspaceAgentRepository.saveAndFlush(new WorkspaceAgent(principal.getId().toString(),
                workspace.getId().toString(), objectMapper.createArrayNode()));

        Session parent = new Session(workspace.getId().toString(), user.getId().toString(),
                "Replay Parent");
        parent.setId(UUID.randomUUID());
        parent.setAgentPrincipalId(principal.getId().toString());
        parent.setAgentPermissionsSnapshot(objectMapper.createArrayNode());
        saveBoundChatSession(parent, user);
        String parentRunId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(parentRunId, parent.getId().toString(),
                user.getId().toString(), workspace.getId().toString(), "parent-key-" + parentRunId,
                "parent-hash", "provider", "model", "workspace", "succeeded"));

        String idempotencyKey = "deleg-replay-" + UUID.randomUUID();
        String authorizationBody = submissionService.delegationAuthorizationBody("task");
        ChatSubmissionService.SpawnAuthorization authorization =
                new ChatSubmissionService.SpawnAuthorization(authorizationBody, null, null);
        ChatSubmissionService.SpawnResult first = submissionService.createDelegation(
                parentRunId, principal.getId().toString(), "task", idempotencyKey, authorization);
        ChatSubmissionService.SpawnResult second = submissionService.createDelegation(
                parentRunId, principal.getId().toString(), "task", idempotencyKey, authorization);

        assertEquals(first.sessionId(), second.sessionId(), "same key = same child");
        assertEquals(first.runId(), second.runId());
        assertEquals(1, chatRunRepository.findAll().stream()
                .filter(run -> idempotencyKey.equals(run.getIdempotencyKey())).count(),
                "the replay never inserts a second Run");
    }

    // ------------------------------------------- PLAN-0669 M1 (V121): durable message attribution

    /** PLAN-0669 D2 acceptance: the assistant Message must name the Run's responding participant. */
    @Test
    void assistantMessageIsAttributedToTheRunsResponderParticipant() {
        ChatFixture fixture = createChatFixture("attribution");
        sessionRepository.saveAndFlush(boundSession(fixture.session(), fixture.principal()));
        UUID participantId = addPrimaryParticipant(fixture.session(), fixture.principal());

        String runId = UUID.randomUUID().toString();
        submit(runId, fixture.session(), fixture.user(), fixture.workspace(), "attribute me",
                fixture.principal().getId().toString());
        ChatRun run = chatRunRepository.findById(UUID.fromString(runId)).orElseThrow();
        assertEquals(fixture.principal().getId(), run.getAgentPrincipalId(),
                "admission recorded the responder principal (the attribution source of truth)");

        String assistantId = submissionService.persistAssistantResponse(
                fixture.session().getId().toString(), runId, "hello");
        assertNotNull(assistantId);
        Message stored = messageRepository.findById(UUID.fromString(assistantId)).orElseThrow();
        assertEquals(participantId, stored.getParticipantId(),
                "assistant Message carries the responder participant (same identity the live SSE badge uses)");
        assertEquals(participantId, sessionParticipantRepository
                        .findFirstBySessionIdAndPrincipalId(fixture.session().getId(),
                                run.getAgentPrincipalId()).orElseThrow().getId(),
                "the invariant is one row: run responder principal ⇔ message participant");
    }

    /** PLAN-0669 D2 fallback: derived runs (follow-up/continuation) answer as the Session binding. */
    @Test
    void assistantMessageFallsBackToTheSessionBindingWhenTheRunHasNoResponder() {
        ChatFixture fixture = createChatFixture("attribution-fallback");
        sessionRepository.saveAndFlush(boundSession(fixture.session(), fixture.principal()));
        UUID participantId = addPrimaryParticipant(fixture.session(), fixture.principal());

        String runId = UUID.randomUUID().toString();
        chatRunRepository.saveAndFlush(new ChatRun(runId, fixture.session().getId().toString(),
                fixture.user().getId().toString(), fixture.workspace().getId().toString(),
                "fallback-key-" + runId, "fallback-hash", "provider", "model", "none", "accepted"));

        String assistantId = submissionService.persistAssistantResponse(
                fixture.session().getId().toString(), runId, "derived run reply");
        assertNotNull(assistantId);
        assertEquals(participantId,
                messageRepository.findById(UUID.fromString(assistantId)).orElseThrow().getParticipantId(),
                "follow-up/continuation children never persist a run responder; attribution follows the "
                        + "Session-bound principal instead of going dark");
    }

    /** PLAN-0669 D2: no participant row ⇒ NULL (no guessing PRIMARY — absent beats wrong). */
    @Test
    void assistantMessageKeepsNoAttributionWhenNoParticipantExists() {
        ChatFixture fixture = createChatFixture("attribution-none");
        // Bound Session, but deliberately no session_participants row: admission is legal, yet the
        // fallback chain has nothing to resolve — the Message must stay NULL instead of guessing.
        sessionRepository.saveAndFlush(boundSession(fixture.session(), fixture.principal()));
        String runId = UUID.randomUUID().toString();
        submit(runId, fixture.session(), fixture.user(), fixture.workspace(), "no roster row");

        String assistantId = submissionService.persistAssistantResponse(
                fixture.session().getId().toString(), runId, "reply without roster");
        assertNotNull(assistantId);
        assertNull(messageRepository.findById(UUID.fromString(assistantId)).orElseThrow().getParticipantId(),
                "no participant row ⇒ NULL; the read face then omits the field and the UI renders no badge");
    }

    /** PLAN-0669 M1b: the durable listing projects participantId only when attributed. */
    @Test
    void messageListingProjectsParticipantIdOnlyWhenAttributed() {
        ChatFixture fixture = createChatFixture("attribution-read");
        sessionRepository.saveAndFlush(boundSession(fixture.session(), fixture.principal()));
        UUID participantId = addPrimaryParticipant(fixture.session(), fixture.principal());
        String runId = UUID.randomUUID().toString();
        submit(runId, fixture.session(), fixture.user(), fixture.workspace(), "read me",
                fixture.principal().getId().toString());
        String assistantId = submissionService.persistAssistantResponse(
                fixture.session().getId().toString(), runId, "reply");
        assertNotNull(assistantId);

        String branchId = branchPathService.ensureRootBranchId(fixture.session().getId().toString());
        BranchPathService.BranchVisibility visibility = branchPathService.resolveVisibility(
                fixture.session().getId().toString(), branchId);
        String rootBranchId = branchPathService.resolvePath(fixture.session().getId().toString(), branchId);
        List<Map<String, Object>> messages = messageReadService.listVisibleMessages(
                fixture.session().getId().toString(), fixture.workspace().getId().toString(),
                rootBranchId, visibility);

        Map<String, Object> assistant = messages.stream()
                .filter(message -> assistantId.equals(String.valueOf(message.get("id"))))
                .findFirst().orElseThrow();
        assertEquals(participantId.toString(), String.valueOf(assistant.get("participantId")),
                "assistant rows expose the durable actor to the history DTO");
        Map<String, Object> user = messages.stream()
                .filter(message -> "USER".equals(String.valueOf(message.get("role"))))
                .findFirst().orElseThrow();
        assertFalse(user.containsKey("participantId"),
                "user rows carry no v1 attribution — the field is omitted, not null");
    }

    // ------------------------------------------------- BL-280: derived runs stamp the agent principal

    @Test
    void derivedRunsStampTheSessionBoundPrincipal() {
        ChatFixture main = createChatFixture("stamp-main");
        sessionRepository.saveAndFlush(boundSession(main.session(), main.principal()));
        addPrimaryParticipant(main.session(), main.principal());
        String mainRunId = UUID.randomUUID().toString();
        submit(mainRunId, main.session(), main.user(), main.workspace(), "main",
                main.principal().getId().toString());
        assertEquals(main.principal().getId(),
                chatRunRepository.findById(UUID.fromString(mainRunId)).orElseThrow().getAgentPrincipalId(),
                "main submission stamps the responder");

        ChatFixture followUp = createChatFixture("stamp-follow-up");
        sessionRepository.saveAndFlush(boundSession(followUp.session(), followUp.principal()));
        addPrimaryParticipant(followUp.session(), followUp.principal());
        String followUpRunId = UUID.randomUUID().toString();
        submissionService.createFollowUp(followUpRunId, followUp.session().getId().toString(),
                followUp.user().getId().toString(), followUp.workspace().getId().toString(),
                branchPathService.ensureRootBranchId(followUp.session().getId().toString()),
                "follow-up-" + followUpRunId, "hash-follow-up", "provider", "model", "none", null, null,
                "lease", UUID.randomUUID().toString(), "queued prompt", "[]", List.of());
        assertEquals(followUp.principal().getId(),
                chatRunRepository.findById(UUID.fromString(followUpRunId)).orElseThrow().getAgentPrincipalId(),
                "follow-up children are stamped at admission (BL-280)");

        ChatFixture scheduled = createChatFixture("stamp-scheduled");
        sessionRepository.saveAndFlush(boundSession(scheduled.session(), scheduled.principal()));
        addPrimaryParticipant(scheduled.session(), scheduled.principal());
        String scheduledRunId = UUID.randomUUID().toString();
        submissionService.createScheduled(scheduledRunId, scheduled.session().getId().toString(),
                scheduled.user().getId().toString(), scheduled.workspace().getId().toString(),
                branchPathService.ensureRootBranchId(scheduled.session().getId().toString()),
                "scheduled-" + scheduledRunId, "hash-scheduled", "provider", "model", "none", null,
                null, null, UUID.randomUUID().toString(), "wake prompt", "[]", List.of());
        assertEquals(scheduled.principal().getId(),
                chatRunRepository.findById(UUID.fromString(scheduledRunId)).orElseThrow().getAgentPrincipalId(),
                "scheduled wake carriers are stamped at admission (BL-280)");
    }

    @Test
    void humanResponderKeepsTheAgentOnlyColumnNull() {
        ChatFixture fixture = createChatFixture("stamp-human");
        sessionRepository.saveAndFlush(boundSession(fixture.session(), fixture.principal()));
        addPrimaryParticipant(fixture.session(), fixture.principal());
        SessionParticipant human = sessionParticipantRepository.saveAndFlush(new SessionParticipant(
                fixture.session().getId(), SessionParticipant.KIND_HUMAN, fixture.user().getId(),
                SessionParticipant.ROLE_MEMBER, 20, SessionParticipant.WAKE_MENTION,
                SessionParticipant.RESPOND_WHEN_MENTIONED));

        String runId = UUID.randomUUID().toString();
        submissionService.create(runId, fixture.session().getId().toString(),
                fixture.user().getId().toString(), fixture.workspace().getId().toString(),
                branchPathService.ensureRootBranchId(fixture.session().getId().toString()),
                "human-" + runId, "hash-human", "provider", "model",
                "none", null, null, "lease", UUID.randomUUID().toString(), "hi", "[]", List.of(),
                human.getId().toString());
        assertNull(chatRunRepository.findById(UUID.fromString(runId)).orElseThrow().getAgentPrincipalId(),
                "a HUMAN responder keeps the agent-only column NULL — no stamp, and no FK violation");
    }

    private UUID addPrimaryParticipant(Session session, AgentPrincipal principal) {
        SessionParticipant participant = new SessionParticipant(session.getId(),
                SessionParticipant.KIND_AGENT, principal.getId(), SessionParticipant.ROLE_PRIMARY, 10,
                SessionParticipant.WAKE_ALL_MESSAGES, SessionParticipant.RESPOND_ALWAYS);
        return sessionParticipantRepository.saveAndFlush(participant).getId();
    }
}
