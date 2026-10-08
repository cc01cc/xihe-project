package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.policy.GrantAuthorizationService;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunHistoryRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;

/**
 * PLAN-0464 T1.2/T1.3/T2.1: the terminal transaction's durable faces are the
 * ChatRun row, its {@code chat_run_history} row, the child waiting link and the
 * Inbox notice — the Operation settlement face is gone.
 */
class TerminalTransactionCoreIntegrationTest extends AbstractIntegrationTest {
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private AgentPrincipalRepository agentPrincipalRepository;
    @Autowired private WorkspaceAgentRepository workspaceAgentRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private ChatRunHistoryRepository historyRepository;
    @Autowired private ChatRunTerminalService terminalService;
    @Autowired private SessionService sessionService;
    @Autowired private GrantAuthorizationService grantAuthorizationService;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private PlatformTransactionManager transactionManager;
    @Autowired private com.cc01cc.p.xihe.cp.repository.McpInvocationRepository mcpInvocationRepository;

    @MockitoSpyBean
    private ChatRunHistoryWriter historyWriter;

    private String userId;
    private String workspaceId;
    private UUID principalId;
    private JsonNode permissionSnapshot;

    @BeforeEach
    void createTenant() {
        User user = userRepository.save(new User("terminal-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Terminal transaction integration test"));
        userId = user.getId().toString();
        Workspace workspace = workspaceRepository.save(new Workspace("Terminal transaction test", userId));
        workspaceId = workspace.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Terminal test principal");
        principal.setCreatedByUserId(userId);
        ObjectNode template = objectMapper.createObjectNode();
        template.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(template);
        principalId = agentPrincipalRepository.saveAndFlush(principal).getId();
        permissionSnapshot = capabilitySnapshot();
        workspaceAgentRepository.saveAndFlush(
                new WorkspaceAgent(principalId.toString(), workspaceId, permissionSnapshot));
    }

    @Test
    void v44AndV50TerminalColumnsAreMappedOnAChainThatIncludesV45() {
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM information_schema.columns "
                        + "WHERE table_schema = current_schema() AND table_name = 'chat_runs' "
                        + "AND column_name = 'terminal_at'",
                Integer.class));
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM information_schema.columns "
                        + "WHERE table_schema = current_schema() AND table_name = 'chat_runs' "
                        + "AND column_name = 'waiting_on_run_id'",
                Integer.class), "PLAN-0464 V50 moved the waiting link onto the child run");
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM information_schema.tables "
                        + "WHERE table_schema = current_schema() AND table_name = 'chat_run_history'",
                Integer.class), "PLAN-0464 V50 added the ChatRun transition history");
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '45' AND success = true",
                Integer.class),
                "PLAN-0408 T1.1 added V45 to the chain this suite boots with");
    }

    @Test
    void rootTerminalCommitsRunTimestampAndHistoryTogether() {
        RunFixture root = createRun(createSession("root", null, null));

        ChatRunTerminalService.TerminalResult result = terminalService.terminalize(
                request(root, "succeeded", "success", null, ChatRunTerminalService.TerminalSource.STREAM));

        assertTrue(result.committed());
        ChatRun terminalRun = chatRunRepository.findById(root.run().getId()).orElseThrow();
        assertEquals("succeeded", terminalRun.getStatus());
        assertNotNull(terminalRun.getTerminalAt());
        List<com.cc01cc.p.xihe.cp.entity.ChatRunHistory> history =
                historyRepository.findByRunIdOrderBySequenceAsc(root.run().getId());
        assertEquals(1, history.size());
        assertEquals("terminal", history.get(0).getEventType());
        assertEquals("stream", history.get(0).getSource());
        assertEquals("succeeded", history.get(0).getToStatus());
        assertEquals("success", history.get(0).getTerminalOutcome());
    }

    @Test
    void childTerminalCommitsHistoryAndClearsWaitingLink() {
        SpawnFixture fixture = createSpawnFixture(true);

        ChatRunTerminalService.TerminalResult result = terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM));

        assertTrue(result.committed());
        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("succeeded", child.getStatus());
        assertNotNull(child.getTerminalAt());
        assertNull(child.getWaitingOnRunId(), "the child waiting link must be settled");
        assertNull(child.getWaitingToolCallId());
        assertEquals(1, historyRepository.findByRunIdOrderBySequenceAsc(child.getId()).size());
        assertEquals("running", chatRunRepository.findById(fixture.parent().run().getId())
                .orElseThrow().getStatus(), "child terminal must not touch the parent run");
    }

    @Test
    void parentTerminalPreservesChildWaitingLinkUntilChildSettlesIt() {
        SpawnFixture fixture = createSpawnFixture(true);

        assertTrue(terminalService.terminalize(request(fixture.parent(), "succeeded", "success", null,
                ChatRunTerminalService.TerminalSource.STREAM)).committed());
        ChatRun liveChild = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals(fixture.parent().run().getId().toString(), liveChild.getWaitingOnRunId(),
                "parent Run terminal must not clear a still-live child link");

        assertTrue(terminalService.terminalize(request(fixture.child(), "succeeded", "success", null,
                ChatRunTerminalService.TerminalSource.STREAM)).committed());

        ChatRun settled = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertNull(settled.getWaitingOnRunId());
        assertNull(settled.getWaitingToolCallId());
        assertEquals(1, historyRepository.findByRunIdOrderBySequenceAsc(settled.getId()).size());
        assertEquals(1, historyRepository.findByRunIdOrderBySequenceAsc(fixture.parent().run().getId()).size());
    }

    @Test
    void childTerminalDoesNotMutateParentRun() {
        SpawnFixture fixture = createSpawnFixture(true);

        assertTrue(terminalService.terminalize(request(fixture.parent(), "succeeded", "success", null,
                ChatRunTerminalService.TerminalSource.STREAM)).committed());
        int parentHistoryCount = historyRepository.findByRunIdOrderBySequenceAsc(
                fixture.parent().run().getId()).size();

        assertTrue(terminalService.terminalize(request(fixture.child(), "failed", "error", "CHILD_TERMINAL_ERROR",
                ChatRunTerminalService.TerminalSource.STREAM)).committed());

        assertEquals(parentHistoryCount, historyRepository.findByRunIdOrderBySequenceAsc(
                fixture.parent().run().getId()).size(),
                "child settlement must not write terminal history for the parent run");
        assertEquals("succeeded", chatRunRepository.findById(fixture.parent().run().getId())
                .orElseThrow().getStatus());
        assertEquals("failed", chatRunRepository.findById(fixture.child().run().getId())
                .orElseThrow().getStatus());
    }

    @Test
    void deletedParentAllowsChildLocalTerminalCommit() {
        SpawnFixture fixture = createSpawnFixture(true);
        sessionService.delete(fixture.parent().session().getId().toString(), userId, workspaceId);

        ChatRunTerminalService.TerminalResult result = terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM));

        assertTrue(result.committed());
        assertTrue(sessionRepository.findById(fixture.child().session().getId()).isPresent());
        assertEquals("succeeded", chatRunRepository.findById(fixture.child().run().getId()).orElseThrow().getStatus());
        assertEquals(1, historyRepository.findByRunIdOrderBySequenceAsc(fixture.child().run().getId()).size());
    }

    @Test
    void liveParentWithoutWaitingLinkRollsBackTerminalTransition() {
        SpawnFixture fixture = createSpawnFixture(false);

        CpApiException failure = assertThrows(CpApiException.class, () -> terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM)));

        assertEquals("RUN_TERMINAL_INVARIANT_VIOLATION", failure.getCode());
        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("running", child.getStatus());
        assertNull(child.getTerminalAt());
        assertNull(child.getWaitingOnRunId());
        assertTrue(historyRepository.findByRunIdOrderBySequenceAsc(child.getId()).isEmpty());
        assertEquals("running", chatRunRepository.findById(fixture.parent().run().getId())
                .orElseThrow().getStatus());
    }

    @Test
    void historyWriteFailureRollsBackRunAndParentLink() {
        SpawnFixture fixture = createSpawnFixture(true);
        doThrow(new IllegalStateException("forced history failure"))
                .when(historyWriter)
                .append(any(), any(), any(), any(), any(), any(), any(), any(), any(), any());

        assertThrows(IllegalStateException.class, () -> terminalService.terminalize(
                request(fixture.child(), "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM)));

        ChatRun child = chatRunRepository.findById(fixture.child().run().getId()).orElseThrow();
        assertEquals("running", child.getStatus());
        assertNull(child.getTerminalAt());
        assertNotNull(child.getWaitingOnRunId(), "a failed history write rolls the link settlement back");
        assertTrue(historyRepository.findByRunIdOrderBySequenceAsc(child.getId()).isEmpty());
    }

    @Test
    void concurrentTerminalRequestsHaveOneCasWinner() throws Exception {
        RunFixture root = createRun(createSession("cas-winner-root", null, null));
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<ChatRunTerminalService.TerminalResult> success = executor.submit(() -> {
                ready.countDown();
                start.await(5, TimeUnit.SECONDS);
                return terminalService.terminalize(request(root, "succeeded", "success", null,
                        ChatRunTerminalService.TerminalSource.STREAM));
            });
            Future<ChatRunTerminalService.TerminalResult> failure = executor.submit(() -> {
                ready.countDown();
                start.await(5, TimeUnit.SECONDS);
                return terminalService.terminalize(request(root, "failed", "error", "PROVIDER_ERROR",
                        ChatRunTerminalService.TerminalSource.STREAM));
            });
            assertTrue(ready.await(5, TimeUnit.SECONDS));
            start.countDown();
            ChatRunTerminalService.TerminalResult successResult = success.get(15, TimeUnit.SECONDS);
            ChatRunTerminalService.TerminalResult failureResult = failure.get(15, TimeUnit.SECONDS);
            assertEquals(1L, List.of(successResult, failureResult).stream()
                    .filter(ChatRunTerminalService.TerminalResult::committed).count());

            ChatRun terminal = chatRunRepository.findById(root.run().getId()).orElseThrow();
            assertTrue(List.of("succeeded", "failed").contains(terminal.getStatus()));
            assertNotNull(terminal.getTerminalAt());
            assertEquals(1, historyRepository.findByRunIdOrderBySequenceAsc(terminal.getId()).size(),
                    "exactly one history row — only the CAS winner writes one");
        } finally {
            start.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void terminalRunBlocksInvocationCallerGate() {
        RunFixture root = createRun(createSession("late-writer-root", null, null));
        String toolCallId = UUID.randomUUID().toString();
        SpawnTestSupport.seedAgentInvocation(mcpInvocationRepository,
                root.session().getId().toString(), root.run().getId().toString(), workspaceId, userId,
                toolCallId, "mcp__test", "{}");

        assertTrue(grantAuthorizationService.hasCurrentAgentToolCall(userId, workspaceId,
                root.session().getId().toString(), root.run().getId().toString(), toolCallId, "mcp__test"),
                "a live run authorizes its own durable tool call");

        assertTrue(terminalService.terminalize(request(root, "succeeded", "success", null,
                ChatRunTerminalService.TerminalSource.STREAM)).committed());

        // The durable caller gate is the run lease + invocation scope.
        assertFalse(grantAuthorizationService.hasCurrentAgentToolCall(userId, workspaceId,
                root.session().getId().toString(), root.run().getId().toString(), toolCallId, "mcp__test"),
                "a terminal run must fail the durable caller gate closed");
        assertEquals("failed", mcpInvocationRepository
                .findByRunIdAndToolCallIdAndSource(root.run().getId().toString(), toolCallId, "agent")
                .orElseThrow().getStatus());
    }

    private RunFixture createRun(Session session) {
        String runId = UUID.randomUUID().toString();
        String requestId = UUID.randomUUID().toString();
        ChatRun run = new ChatRun(runId, session.getId().toString(), userId, workspaceId,
                requestId, "t26-hash-" + runId,
                "provider", "model", "workspace", "running");
        run = chatRunRepository.saveAndFlush(run);
        return new RunFixture(session, run);
    }

    private SpawnFixture createSpawnFixture(boolean createWaitingLink) {
        RunFixture parent = createRun(createSession("parent", null, null));
        String toolCallId = UUID.randomUUID().toString();

        Session childSession = createSession("child", Session.KIND_SPAWN, parent);
        RunFixture child = createRun(childSession);
        String assistantMessageId = UUID.randomUUID().toString();
        ChatRun updatedChild = chatRunRepository.findById(child.run().getId()).orElseThrow();
        updatedChild.setAssistantMessageId(assistantMessageId);
        if (createWaitingLink) {
            // The waiting link belongs to the child ChatRun.
            updatedChild.setWaitingOnRunId(parent.run().getId().toString());
            updatedChild.setWaitingToolCallId(toolCallId);
        }
        chatRunRepository.saveAndFlush(updatedChild);
        return new SpawnFixture(parent, child, assistantMessageId, toolCallId);
    }

    private Session createSession(String title, String kind, RunFixture parent) {
        Session session = new Session(workspaceId, userId, title);
        session.setId(UUID.randomUUID());
        session.setAgentPrincipalId(principalId.toString());
        session.setAgentPermissionsSnapshot(permissionSnapshot.deepCopy());
        if (kind != null) {
            session.setKind(kind);
            session.setSpawnedFromSessionId(parent.session().getId());
            session.setSpawnedFromRunId(parent.run().getId());
            session.setSpawnedAt(Instant.now());
        }
        return sessionRepository.saveAndFlush(session);
    }

    private ChatRunTerminalService.TerminalRequest request(RunFixture run, String status,
                                                           String outcome, String errorCode,
                                                           ChatRunTerminalService.TerminalSource mode) {
        String detail = errorCode == null ? null : "terminal test error";
        return new ChatRunTerminalService.TerminalRequest(run.run().getId().toString(),
                List.of(run.run().getStatus()), status, outcome, errorCode, detail,
                run.run().getTokenCount(), run.run().getAssistantChars(), mode, List.of());
    }

    private Session createSession(String title) {
        return createSession(title, null, null);
    }

    private ArrayNode capabilitySnapshot() {
        ArrayNode caps = objectMapper.createArrayNode();
        ObjectNode read = objectMapper.createObjectNode();
        read.put("actionClass", "read");
        caps.add(read);
        return caps;
    }

    private record RunFixture(Session session, ChatRun run) {}

    private record SpawnFixture(RunFixture parent, RunFixture child,
                                String childAssistantMessageId, String toolCallId) {}
}
