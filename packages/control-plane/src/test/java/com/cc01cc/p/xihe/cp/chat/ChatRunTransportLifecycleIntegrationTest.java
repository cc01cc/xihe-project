package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.AgentPrincipal;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ChatRunTransportAttempt;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceAgent;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.AgentPrincipalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunTransportAttemptRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceAgentRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import com.cc01cc.p.xihe.cp.service.RunCheckpointService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.verify;

class ChatRunTransportLifecycleIntegrationTest extends AbstractIntegrationTest {

    @Autowired private UserRepository users;
    @Autowired private WorkspaceRepository workspaces;
    @Autowired private WorkspaceUserRepository workspaceUsers;
    @Autowired private AgentPrincipalRepository principals;
    @Autowired private WorkspaceAgentRepository workspaceAgents;
    @Autowired private SessionRepository sessions;
    @Autowired private ChatRunRepository chatRuns;
    @Autowired private ChatRunTransportAttemptRepository attempts;
    @Autowired private ChatRunTerminalService terminalService;
    @Autowired private ChatRunReconciliationService reconciliationService;
    @Autowired private SessionMonitorService sessionMonitorService;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    @MockitoSpyBean
    private ChatRunTransportService transportService;

    @MockitoSpyBean
    private RunCheckpointService checkpointService;

    private String userId;
    private String workspaceId;
    private JsonNode permissionSnapshot;

    @BeforeEach
    void createTenant() {
        doNothing().when(checkpointService).requestCapture(any(String.class));
        User user = users.save(new User("transport-" + UUID.randomUUID() + "@test.com",
                "hash", UserRole.USER, "Transport lifecycle integration test"));
        userId = user.getId().toString();

        Workspace workspace = workspaces.save(new Workspace("Transport lifecycle test", userId));
        workspaceId = workspace.getId().toString();
        workspaceUsers.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));

        AgentPrincipal principal = new AgentPrincipal();
        principal.setName("Transport lifecycle principal");
        principal.setCreatedByUserId(userId);
        ObjectNode template = objectMapper.createObjectNode();
        template.set("permissions", objectMapper.createArrayNode());
        principal.setTemplateSnapshot(template);
        UUID principalId = principals.saveAndFlush(principal).getId();

        ArrayNode permissions = objectMapper.createArrayNode();
        ObjectNode read = objectMapper.createObjectNode();
        read.put("actionClass", "read");
        permissions.add(read);
        workspaceAgents.saveAndFlush(new WorkspaceAgent(principalId.toString(), workspaceId, permissions));
        permissionSnapshot = permissions.deepCopy();
    }

    @Test
    void lifecycleStartAndTerminalUpdateAreOneIdempotentRow() {
        ChatRun run = createRun("lifecycle");
        UUID attemptId = UUID.randomUUID();
        Instant startedAt = Instant.parse("2026-10-14T08:00:00Z");
        Instant endedAt = startedAt.plusMillis(120);

        assertTrue(transportService.startAttempt(run.getId().toString(), attemptId, 1, startedAt));
        ChatRunTransportAttempt running = attempts.findById(attemptId).orElseThrow();
        assertEquals(ChatRunTransportAttempt.STATUS_RUNNING, running.getStatus());
        assertNull(running.getOutcome());
        assertEquals(run.getSessionId(), running.getSessionId());
        assertNull(running.getChunkCount());

        ChatRunTransportService.AttemptCompletion completion = new ChatRunTransportService.AttemptCompletion(
                ChatRunTransportAttempt.OUTCOME_SUCCESS, startedAt, endedAt, 120,
                null, null, 42L, 3L);
        assertTrue(transportService.completeAttempt(run.getId().toString(), attemptId, 1, completion));
        assertFalse(transportService.completeAttempt(run.getId().toString(), attemptId, 1, completion));

        ChatRunTransportAttempt terminal = attempts.findById(attemptId).orElseThrow();
        assertEquals(ChatRunTransportAttempt.STATUS_TERMINAL, terminal.getStatus());
        assertEquals(ChatRunTransportAttempt.OUTCOME_SUCCESS, terminal.getOutcome());
        assertEquals(120L, terminal.getDurationMs());
        assertEquals(42L, terminal.getFirstChunkMs());
        assertEquals(3L, terminal.getChunkCount());
        assertEquals(1, countAttemptsForRun(run.getId()));
    }

    @Test
    void terminalSummaryWithoutStartReceiptFallsBackToOneTerminalRow() {
        ChatRun run = createRun("terminal-fallback");
        UUID attemptId = UUID.randomUUID();
        Instant startedAt = Instant.now().minusMillis(50);
        Instant endedAt = Instant.now();
        ChatRunTransportService.AttemptCompletion completion = new ChatRunTransportService.AttemptCompletion(
                ChatRunTransportAttempt.OUTCOME_TIMEOUT, startedAt, endedAt, 50,
                "LLM_PROVIDER_UNREACHABLE", null, null, 0L);

        assertTrue(transportService.completeAttempt(run.getId().toString(), attemptId, 1, completion));
        ChatRunTransportAttempt terminal = attempts.findById(attemptId).orElseThrow();
        assertEquals(ChatRunTransportAttempt.STATUS_TERMINAL, terminal.getStatus());
        assertEquals(ChatRunTransportAttempt.OUTCOME_TIMEOUT, terminal.getOutcome());
        assertEquals("LLM_PROVIDER_UNREACHABLE", terminal.getErrorCode());
        assertNull(terminal.getProviderHttpStatus());
        assertEquals(1, countAttemptsForRun(run.getId()));
    }

    @Test
    void committedRunImmediatelyReconcilesOpenAttemptAfterCommit() {
        ChatRun run = createRun("after-commit-partial");
        UUID attemptId = UUID.randomUUID();
        assertTrue(transportService.startAttempt(run.getId().toString(), attemptId, 1, Instant.now()));

        terminalService.terminalize(new ChatRunTerminalService.TerminalRequest(
                run.getId().toString(), List.of("running"), "failed", "provider_error",
                null, null, 0, 0, ChatRunTerminalService.TerminalSource.STREAM, List.of()));

        ChatRunTransportAttempt partial = attempts.findById(attemptId).orElseThrow();
        assertEquals(ChatRunTransportAttempt.STATUS_TERMINAL, partial.getStatus());
        assertEquals(ChatRunTransportAttempt.OUTCOME_PARTIAL, partial.getOutcome());
        assertNotNull(partial.getEndedAt());
        assertNull(partial.getDurationMs());
    }

    @Test
    void afterCommitReconcileFailureDoesNotRollbackRunAndScheduledSweepRepairsIt() {
        ChatRun run = createRun("partial-sweep");
        UUID attemptId = UUID.randomUUID();
        Instant startedAt = Instant.now().minusSeconds(1);
        assertTrue(transportService.startAttempt(run.getId().toString(), attemptId, 1, startedAt));

        doThrow(new IllegalStateException("injected telemetry reconcile failure"))
                .when(transportService).reconcileRunAfterTerminal(eq(run.getId().toString()), any(Instant.class));

        ChatRunTerminalService.TerminalResult result = terminalService.terminalize(
                new ChatRunTerminalService.TerminalRequest(
                        run.getId().toString(), List.of("running"), "succeeded", "success",
                        null, null, 0, 0, ChatRunTerminalService.TerminalSource.STREAM, List.of()));

        assertTrue(result.committed());
        assertEquals("succeeded", chatRuns.findById(run.getId()).orElseThrow().getStatus());
        verify(transportService).reconcileRunAfterTerminal(eq(run.getId().toString()), any(Instant.class));
        assertEquals(ChatRunTransportAttempt.STATUS_RUNNING,
                attempts.findById(attemptId).orElseThrow().getStatus());

        // There are no stale active runs here; transport repair must run before
        // ChatRunReconciliationService's empty-candidate early return.
        reconciliationService.reconcileStaleRuns();

        ChatRunTransportAttempt partial = attempts.findById(attemptId).orElseThrow();
        assertEquals(ChatRunTransportAttempt.STATUS_TERMINAL, partial.getStatus());
        assertEquals(ChatRunTransportAttempt.OUTCOME_PARTIAL, partial.getOutcome());
        assertNotNull(partial.getEndedAt());
        assertNull(partial.getDurationMs());
        assertNull(partial.getFirstChunkMs());
        assertNull(partial.getChunkCount());
        assertEquals("succeeded", chatRuns.findById(run.getId()).orElseThrow().getStatus());
    }

    @Test
    void terminalSummaryAndPartialReconcileRaceHasOneWinner() throws Exception {
        ChatRun run = createRun("terminal-reconcile-race");
        UUID attemptId = UUID.randomUUID();
        Instant startedAt = Instant.now();
        assertTrue(transportService.startAttempt(run.getId().toString(), attemptId, 1, startedAt));
        ChatRunTransportService.AttemptCompletion completion = new ChatRunTransportService.AttemptCompletion(
                ChatRunTransportAttempt.OUTCOME_SUCCESS, startedAt, startedAt.plusMillis(4), 4,
                null, null, 2L, 1L);

        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<Boolean> terminal = executor.submit(() -> {
                ready.countDown();
                if (!release.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("terminal racer was not released");
                }
                return transportService.completeAttempt(run.getId().toString(), attemptId, 1, completion);
            });
            Future<Integer> partial = executor.submit(() -> {
                ready.countDown();
                if (!release.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("partial racer was not released");
                }
                return transportService.reconcileRunAfterTerminal(run.getId().toString(), Instant.now());
            });

            assertTrue(ready.await(5, TimeUnit.SECONDS));
            release.countDown();
            boolean terminalWon = terminal.get(10, TimeUnit.SECONDS);
            int partialRows = partial.get(10, TimeUnit.SECONDS);
            assertTrue(terminalWon || partialRows == 1);
            assertEquals(1, countAttemptsForRun(run.getId()));

            ChatRunTransportAttempt row = attempts.findById(attemptId).orElseThrow();
            assertEquals(ChatRunTransportAttempt.STATUS_TERMINAL, row.getStatus());
            assertTrue(List.of(ChatRunTransportAttempt.OUTCOME_SUCCESS,
                    ChatRunTransportAttempt.OUTCOME_PARTIAL).contains(row.getOutcome()));
        } finally {
            release.countDown();
            executor.shutdownNow();
            assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS));
        }
    }

    @Test
    void progressSamplesAreBoundedMonotonicAndRefreshReadable() {
        ChatRun run = createRun("progress-samples");
        String runId = run.getId().toString();
        UUID attemptId = UUID.randomUUID();
        assertTrue(transportService.startAttempt(runId, attemptId, 1, Instant.now()));

        assertTrue(transportService.recordProgress(runId, attemptId, 1,
                ChatRunTransportAttempt.STAGE_ATTEMPT_STARTED, 0));
        assertTrue(transportService.recordProgress(runId, attemptId, 1,
                ChatRunTransportAttempt.STAGE_FIRST_CHUNK, 83));
        assertTrue(transportService.recordProgress(runId, attemptId, 1,
                ChatRunTransportAttempt.STAGE_STREAMING, 140));
        // Stale or duplicate samples are no-ops; the last accepted stage never regresses.
        assertFalse(transportService.recordProgress(runId, attemptId, 1,
                ChatRunTransportAttempt.STAGE_FIRST_CHUNK, 90));
        assertFalse(transportService.recordProgress(runId, attemptId, 1,
                ChatRunTransportAttempt.STAGE_STREAMING, 141));
        assertTrue(transportService.recordProgress(runId, attemptId, 1,
                ChatRunTransportAttempt.STAGE_ATTEMPT_FINISHED, 900));
        assertFalse(transportService.recordProgress(runId, attemptId, 1,
                ChatRunTransportAttempt.STAGE_ATTEMPT_FINISHED, 901));

        ChatRunTransportAttempt running = attempts.findById(attemptId).orElseThrow();
        assertEquals(ChatRunTransportAttempt.STAGE_ATTEMPT_FINISHED, running.getLastProgressStage());
        assertEquals(900L, running.getLastProgressElapsedMs());

        // The accepted sample is frozen once the lifecycle row turns terminal.
        ChatRunTransportService.AttemptCompletion completion = new ChatRunTransportService.AttemptCompletion(
                ChatRunTransportAttempt.OUTCOME_SUCCESS, running.getStartedAt(), Instant.now(), 900,
                null, null, 83L, 5L);
        assertTrue(transportService.completeAttempt(runId, attemptId, 1, completion));
        assertFalse(transportService.recordProgress(runId, attemptId, 1,
                ChatRunTransportAttempt.STAGE_ATTEMPT_FINISHED, 902));

        ChatRunTransportAttempt terminal = attempts.findById(attemptId).orElseThrow();
        assertEquals(ChatRunTransportAttempt.STATUS_TERMINAL, terminal.getStatus());
        assertEquals(ChatRunTransportAttempt.STAGE_ATTEMPT_FINISHED, terminal.getLastProgressStage());
        assertEquals(900L, terminal.getLastProgressElapsedMs());
    }

    @Test
    void progressForUnknownOrMismatchedAttemptIsNoOp() {
        ChatRun run = createRun("progress-isolation");
        String runId = run.getId().toString();
        UUID attemptId = UUID.randomUUID();

        // Bounded progress never inserts a lifecycle row by itself.
        assertFalse(transportService.recordProgress(runId, attemptId, 1,
                ChatRunTransportAttempt.STAGE_ATTEMPT_STARTED, 0));
        assertEquals(0, countAttemptsForRun(run.getId()));

        assertTrue(transportService.startAttempt(runId, attemptId, 1, Instant.now()));
        assertFalse(transportService.recordProgress(UUID.randomUUID().toString(), attemptId, 1,
                ChatRunTransportAttempt.STAGE_FIRST_CHUNK, 10));
        assertFalse(transportService.recordProgress(runId, attemptId, 2,
                ChatRunTransportAttempt.STAGE_FIRST_CHUNK, 10));
        assertNull(attempts.findById(attemptId).orElseThrow().getLastProgressStage());
    }

    @Test
    void migrationCreatesLifecycleSchemaAndIndexes() {
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM information_schema.tables "
                        + "WHERE table_schema = current_schema() AND table_name = 'chat_run_transport_attempts'",
                Integer.class));
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM flyway_schema_history WHERE version = '68' AND success = true",
                Integer.class));
        assertEquals(1, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM pg_indexes WHERE schemaname = current_schema() "
                        + "AND indexname = 'idx_chat_run_transport_attempts_running_run'",
                Integer.class));
        assertEquals(2, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM information_schema.columns "
                        + "WHERE table_schema = current_schema() AND table_name = 'chat_run_transport_attempts' "
                        + "AND column_name IN ('last_progress_stage', 'last_progress_elapsed_ms')",
                Integer.class));
        assertEquals(3, jdbcTemplate.queryForObject(
                "SELECT count(*) FROM pg_constraint WHERE conname IN ("
                        + "'ck_chat_run_transport_attempts_progress_stage', "
                        + "'ck_chat_run_transport_attempts_progress_pair', "
                        + "'ck_chat_run_transport_attempts_progress_elapsed')",
                Integer.class));
    }

    @Test
    void sessionMonitorTransportCountsStaySeparateFromHistoryWindow() {
        ChatRun run = createRun("session-monitor-counts");
        UUID attemptId = UUID.randomUUID();
        assertTrue(transportService.startAttempt(run.getId().toString(), attemptId, 1, Instant.now()));

        terminalService.terminalize(new ChatRunTerminalService.TerminalRequest(
                run.getId().toString(), List.of("running"), "succeeded", "success",
                null, null, 0, 0, ChatRunTerminalService.TerminalSource.STREAM, List.of()));

        Session session = sessions.findById(UUID.fromString(run.getSessionId())).orElseThrow();
        Map<String, Object> response = sessionMonitorService.getMonitor(session, userId, workspaceId);
        Map<?, ?> transport = (Map<?, ?>) response.get("transport");
        Map<?, ?> history = (Map<?, ?>) response.get("history");
        Map<?, ?> historyCounts = (Map<?, ?>) history.get("counts");

        assertEquals(1L, transport.get("attemptCount"));
        assertEquals(0L, transport.get("failedCount"));
        assertEquals(1L, transport.get("partialCount"));
        assertEquals(1L, historyCounts.get("success"));
        assertFalse(historyCounts.containsKey("partial"));
    }

    private ChatRun createRun(String suffix) {
        Session session = new Session(workspaceId, userId, "Transport " + suffix);
        session.setId(UUID.randomUUID());
        session.setAgentPermissionsSnapshot(permissionSnapshot.deepCopy());
        session = sessions.saveAndFlush(session);

        String requestId = UUID.randomUUID().toString();
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), session.getId().toString(), userId, workspaceId,
                requestId, UUID.randomUUID().toString().replace("-", ""),
                "provider", "model", "workspace", "running");
        return chatRuns.saveAndFlush(run);
    }

    private int countAttemptsForRun(UUID runId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM chat_run_transport_attempts WHERE run_id = ?",
                Integer.class, runId);
    }
}
