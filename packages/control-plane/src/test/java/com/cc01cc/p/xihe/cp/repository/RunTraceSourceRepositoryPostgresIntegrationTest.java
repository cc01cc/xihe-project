package com.cc01cc.p.xihe.cp.repository;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.repository.RunTraceSourceRepository.RunMetadata;
import com.cc01cc.p.xihe.cp.repository.RunTraceSourceRepository.RunIdentity;
import com.cc01cc.p.xihe.cp.repository.RunTraceSourceRepository.SourceRecord;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** PostgreSQL-backed checks for the bounded Run Trace source queries. */
class RunTraceSourceRepositoryPostgresIntegrationTest extends AbstractIntegrationTest {

    private static final String ARGUMENT_MARKER = "trace-arguments-secret-marker";
    private static final String RESULT_MARKER = "trace-result-secret-marker";
    private static final String EXTRA_MARKER = "trace-extra-secret-marker";
    private static final String TEMPLATE_BODY_MARKER = "trace-template-body-secret-marker";
    private static final String PROMPT_BODY_MARKER = "trace-prompt-body-secret-marker";

    @Autowired private RunTraceSourceRepository sourceRepository;
    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private WorkspaceUserRepository workspaceUserRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private JdbcTemplate jdbcTemplate;
    @Autowired private ObjectMapper objectMapper;

    private UUID userId;
    private UUID workspaceId;
    private UUID sessionId;
    private UUID otherSessionId;
    private UUID runId;

    @BeforeEach
    void createTenantFixture() {
        User user = userRepository.saveAndFlush(new User(
                "run-trace-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER,
                "Run Trace repository test"));
        userId = user.getId();

        Workspace workspace = workspaceRepository.saveAndFlush(
                new Workspace("Run Trace repository test", userId.toString()));
        workspaceId = workspace.getId();
        workspaceUserRepository.saveAndFlush(new WorkspaceUser(
                workspaceId.toString(), userId.toString(), WorkspaceRole.OWNER));

        Session session = createSession("Run Trace source session");
        sessionId = session.getId();
        otherSessionId = createSession("Run Trace other session").getId();

        runId = UUID.randomUUID();
        chatRunRepository.saveAndFlush(new ChatRun(runId.toString(), sessionId.toString(),
                userId.toString(), workspaceId.toString(), "run-trace-" + runId,
                "request-hash", "test-provider", "test-model", "workspace", "running"));
    }

    @AfterEach
    void cleanTenantFixture() {
        if (runId != null) {
            jdbcTemplate.update("DELETE FROM mcp_invocations WHERE run_id = ?", runId);
        }
        if (sessionId != null) {
            jdbcTemplate.update("DELETE FROM context_events WHERE session_id = ?", sessionId);
            jdbcTemplate.update("DELETE FROM workspace_jobs WHERE session_id = ?", sessionId);
        }
        if (otherSessionId != null) {
            jdbcTemplate.update("DELETE FROM workspace_jobs WHERE session_id = ?", otherSessionId);
        }
        if (runId != null) {
            chatRunRepository.deleteById(runId);
        }
        if (sessionId != null) {
            sessionRepository.deleteById(sessionId);
        }
        if (otherSessionId != null) {
            sessionRepository.deleteById(otherSessionId);
        }
        if (workspaceId != null && userId != null) {
            workspaceUserRepository.deleteById(new com.cc01cc.p.xihe.cp.entity.WorkspaceUserId(
                    workspaceId.toString(), userId.toString()));
            workspaceRepository.deleteById(workspaceId);
        }
        if (userId != null) {
            userRepository.deleteById(userId);
        }
    }

    @Test
    void unlinkedRuntimeJobCandidateRequiresSameSessionNullRunAndVisibleTimeWindow() {
        Instant runCreatedAt = chatRunRepository.findById(runId).orElseThrow().getCreatedAt();
        Instant runWindowEnd = runCreatedAt.plusSeconds(20);
        Instant candidateAt = runCreatedAt.plusSeconds(5);

        insertWorkspaceJob(sessionId, runId, runCreatedAt.plusSeconds(2));
        insertWorkspaceJob(otherSessionId, null, runCreatedAt.plusSeconds(3));
        insertWorkspaceJob(sessionId, null, runCreatedAt.minusSeconds(1));
        insertWorkspaceJob(sessionId, null, runWindowEnd.plusSeconds(1));
        insertWorkspaceJob(sessionId, null, candidateAt);

        assertFalse(sourceRepository.hasUnlinkedRuntimeJobCandidate(
                sessionId, runCreatedAt, runWindowEnd, candidateAt.minusSeconds(1)),
                "a matching job newer than asOf is not visible yet");
        assertFalse(sourceRepository.hasUnlinkedRuntimeJobCandidate(
                sessionId, runCreatedAt, candidateAt.minusSeconds(1), candidateAt.plusSeconds(2)),
                "a same-session unlinked job after the run window is excluded even when visible at asOf");
        assertTrue(sourceRepository.hasUnlinkedRuntimeJobCandidate(
                sessionId, runCreatedAt, runWindowEnd, candidateAt.plusSeconds(1)),
                "the query returns a boolean existence fact for a same-session unlinked job in-window");
    }

    @Test
    void linkedRuntimeJobWithoutHistoryUsesVisibleStatusTimeAndStableCursorOrder() {
        Instant runCreatedAt = chatRunRepository.findById(runId).orElseThrow().getCreatedAt();
        Instant queuedAt = runCreatedAt.plusSeconds(1);
        Instant jobCreatedAt = runCreatedAt.plusSeconds(2);
        Instant startedAt = jobCreatedAt.plusSeconds(3);
        Instant endedAt = startedAt.plusSeconds(5);
        UUID queuedJobId = insertWorkspaceJobSnapshot(
                "pending", queuedAt, null, null, queuedAt);
        UUID completedJobId = insertWorkspaceJobSnapshot(
                "succeeded", jobCreatedAt, startedAt, endedAt, endedAt.plusSeconds(5));

        Instant runningAsOf = startedAt.plusSeconds(1);
        SourceRecord running = sourceRepository.readRuntimeJobs(runId, runningAsOf, null, 10).stream()
                .filter(record -> completedJobId.toString().equals(record.sourceRecordId()))
                .findFirst().orElseThrow();
        assertEquals("running", running.status());
        assertEquals(startedAt, running.occurredAt());

        Instant completedAsOf = endedAt.plusSeconds(1);
        List<SourceRecord> firstPage = sourceRepository.readRuntimeJobs(runId, completedAsOf, null, 1);
        assertEquals(1, firstPage.size());
        assertEquals(queuedJobId.toString(), firstPage.getFirst().sourceRecordId());
        RunTraceSourceRepository.Cursor cursor = new RunTraceSourceRepository.Cursor(
                firstPage.getFirst().occurredAt(), firstPage.getFirst().source(),
                firstPage.getFirst().sourceRecordId());
        List<SourceRecord> secondPage = sourceRepository.readRuntimeJobs(runId, completedAsOf, cursor, 1);
        assertEquals(1, secondPage.size());
        assertEquals(completedJobId.toString(), secondPage.getFirst().sourceRecordId());
        assertEquals("completed", secondPage.getFirst().status());
        assertEquals(endedAt, secondPage.getFirst().occurredAt());
    }

    @Test
    void runMetadataQueryReturnsAllowlistedConfigurationScalarsWithoutTemplateBody()
            throws JsonProcessingException {
        UUID providerConnectionId = UUID.randomUUID();
        UUID templateId = UUID.randomUUID();
        String snapshot = "{\"layer\":\"workspace\",\"templateId\":\"" + templateId
                + "\",\"version\":3,\"apiTypeId\":\"openai-chat-completions\","
                + "\"apiTypeVersion\":2,\"connectionKey\":\"connection-secret-marker\","
                + "\"template\":{\"body\":\"" + TEMPLATE_BODY_MARKER + "\"}}";
        jdbcTemplate.update("UPDATE chat_runs SET provider_connection_id = ?::uuid, "
                        + "connection_revision = ?, context_template_snapshot = CAST(? AS jsonb) "
                        + "WHERE id = ?::uuid",
                providerConnectionId.toString(), 4L, snapshot, runId.toString());

        RunMetadata metadata = sourceRepository.readRunMetadata(runId).orElseThrow();
        RunIdentity identity = sourceRepository.readRunIdentity(runId).orElseThrow();

        assertEquals(runId, metadata.id());
        assertEquals(runId, identity.id());
        assertEquals(sessionId.toString(), identity.sessionId());
        assertEquals(userId.toString(), identity.userId());
        assertEquals(workspaceId.toString(), identity.workspaceId());
        assertEquals(providerConnectionId.toString(), metadata.providerConnectionId());
        assertEquals(4L, metadata.connectionRevision());
        assertEquals("openai-chat-completions", metadata.apiTypeId());
        assertEquals("2", metadata.apiTypeVersion());
        assertEquals("workspace", metadata.contextTemplateLayer());
        assertEquals(templateId.toString(), metadata.contextTemplateId());
        assertEquals("3", metadata.contextTemplateVersion());
        String safeProjectionJson = objectMapper.writeValueAsString(metadata);
        assertFalse(safeProjectionJson.contains(TEMPLATE_BODY_MARKER));
        assertFalse(safeProjectionJson.contains("connection-secret-marker"));
        assertFalse(safeProjectionJson.contains("body"));
    }

    @Test
    void promptAdmissionProjectsOnlyEventIdentityAndAdmissionStatus() throws JsonProcessingException {
        Instant occurredAt = Instant.now().minusSeconds(2);
        UUID eventId = UUID.randomUUID();
        insertContextEvent(eventId, 1, "prompt.admitted", occurredAt,
                "{\"message\":{\"role\":\"human\",\"content\":\""
                        + PROMPT_BODY_MARKER + "\"},\"private\":\"ignored\"}");

        List<SourceRecord> records = sourceRepository.readContextEvents(
                runId, Instant.now(), null, 10);

        assertEquals(1, records.size());
        SourceRecord event = records.getFirst();
        assertEquals("input.admitted", event.kind());
        assertEquals("admitted", event.status());
        assertEquals(eventId.toString(), event.sourceRecordId());
        assertTrue(Math.abs(Duration.between(occurredAt, event.occurredAt()).toNanos()) <= 500,
                "PostgreSQL timestamp precision should stay within half a microsecond");
        String safeProjectionJson = objectMapper.writeValueAsString(event);
        assertFalse(safeProjectionJson.contains(PROMPT_BODY_MARKER));
        assertFalse(safeProjectionJson.contains("human"));
        assertFalse(safeProjectionJson.contains("private"));
    }

    @Test
    void assistantRespondedMarkerIsExcludedInsteadOfDegradingCompleteness() {
        Instant occurredAt = Instant.now().minusSeconds(1);
        insertContextEvent(UUID.randomUUID(), 1, "assistant.responded", occurredAt,
                "{\"messageId\":\"message-1\"}");

        List<SourceRecord> records = sourceRepository.readContextEvents(
                runId, Instant.now(), null, 10);

        assertTrue(records.isEmpty(),
                "assistant.responded is an outcome marker and must not surface as an unknown trace event");
    }

    @Test
    void contextEventProjectionUsesSafeScalarsAndSuppressesMcpDuplicateRows() throws JsonProcessingException {
        Instant calledAt = Instant.now().minusSeconds(20);
        Instant resultAt = calledAt.plusMillis(250);
        Instant mcpCalledAt = resultAt.plusMillis(250);
        Instant mcpResultAt = mcpCalledAt.plusMillis(250);
        Instant asOf = mcpResultAt.plusSeconds(1);
        UUID customToolCallId = UUID.randomUUID();
        UUID mcpToolCallId = UUID.randomUUID();

        insertContextEvent(UUID.randomUUID(), 1, "tool.called", calledAt,
                "{\"toolCallId\":\"" + customToolCallId + "\",\"toolName\":\"ApprovalAgentTool\","
                        + "\"arguments\":{\"marker\":\"" + ARGUMENT_MARKER + "\"},"
                        + "\"result\":\"" + RESULT_MARKER + "\",\"unexpected\":\"" + EXTRA_MARKER + "\"}");
        insertContextEvent(UUID.randomUUID(), 2, "tool.result", resultAt,
                "{\"toolCallId\":\"" + customToolCallId + "\",\"toolName\":\"ApprovalAgentTool\","
                        + "\"status\":\"completed\",\"result\":{\"marker\":\"" + RESULT_MARKER + "\"},"
                        + "\"arguments\":\"" + ARGUMENT_MARKER + "\",\"unexpected\":\"" + EXTRA_MARKER + "\"}");
        insertContextEvent(UUID.randomUUID(), 3, "tool.called", mcpCalledAt,
                "{\"toolCallId\":\"" + mcpToolCallId + "\",\"toolName\":\"mcp__files__read\","
                        + "\"arguments\":\"" + ARGUMENT_MARKER + "\"}");
        insertContextEvent(UUID.randomUUID(), 4, "tool.result", mcpResultAt,
                "{\"toolCallId\":\"" + mcpToolCallId + "\",\"toolName\":\"mcp__files__read\","
                        + "\"status\":\"completed\",\"result\":\"" + RESULT_MARKER + "\"}");
        insertMcpInvocation(mcpToolCallId, mcpCalledAt, mcpResultAt);

        List<SourceRecord> contextRecords = sourceRepository.readContextEvents(runId, asOf, null, 20);
        List<SourceRecord> mcpRecords = sourceRepository.readMcpInvocations(runId, asOf, null, 20);

        assertEquals(2, contextRecords.size(), "the MCP ContextEvent pair must be deduplicated");
        assertTrue(contextRecords.stream().allMatch(record -> "agent.tool".equals(record.kind())));
        assertEquals(List.of("started", "succeeded"),
                contextRecords.stream().map(SourceRecord::status).toList(), contextRecords.toString());
        assertEquals(customToolCallId.toString(), contextRecords.getFirst().toolCallId());
        assertEquals("ApprovalAgentTool", contextRecords.getFirst().toolName());
        assertEquals(250L, contextRecords.getLast().durationMs());
        assertEquals(1, mcpRecords.size(), "the MCP invocation remains the canonical trace row");
        assertEquals(mcpToolCallId.toString(), mcpRecords.getFirst().toolCallId());

        String safeProjectionJson = objectMapper.writeValueAsString(contextRecords);
        assertFalse(safeProjectionJson.contains(ARGUMENT_MARKER));
        assertFalse(safeProjectionJson.contains(RESULT_MARKER));
        assertFalse(safeProjectionJson.contains(EXTRA_MARKER));
        assertFalse(safeProjectionJson.contains("arguments"));
        assertFalse(safeProjectionJson.contains("result"));
        assertNull(contextRecords.getFirst().errorCode());
        assertNull(contextRecords.getFirst().providerId());
        assertNull(contextRecords.getFirst().modelId());
    }

    private Session createSession(String title) {
        Session session = new Session(workspaceId.toString(), userId.toString(), title);
        session.setId(UUID.randomUUID());
        return sessionRepository.saveAndFlush(session);
    }

    private void insertWorkspaceJob(UUID session, UUID linkedRun, Instant createdAt) {
        Timestamp timestamp = Timestamp.from(createdAt);
        jdbcTemplate.update("INSERT INTO workspace_jobs "
                        + "(id, workspace_id, user_id, session_id, run_id, source, scope, status, state, "
                        + "created_at, updated_at) VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, "
                        + "'agent', 'session', 'pending', '{}'::jsonb, ?, ?)",
                UUID.randomUUID().toString(), workspaceId.toString(), userId.toString(), session.toString(),
                linkedRun == null ? null : linkedRun.toString(), timestamp, timestamp);
    }

    private UUID insertWorkspaceJobSnapshot(String status, Instant createdAt, Instant startedAt,
                                            Instant endedAt, Instant updatedAt) {
        UUID jobId = UUID.randomUUID();
        jdbcTemplate.update("INSERT INTO workspace_jobs "
                        + "(id, workspace_id, user_id, session_id, run_id, source, scope, status, state, "
                        + "started_at, ended_at, created_at, updated_at) "
                        + "VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, 'agent', 'session', ?, "
                        + "'{}'::jsonb, ?, ?, ?, ?)",
                jobId.toString(), workspaceId.toString(), userId.toString(), sessionId.toString(),
                runId.toString(), status, timestamp(startedAt), timestamp(endedAt),
                timestamp(createdAt), timestamp(updatedAt));
        return jobId;
    }

    private static Timestamp timestamp(Instant value) {
        return value == null ? null : Timestamp.from(value);
    }

    private void insertContextEvent(UUID eventId, long sequence, String eventType,
                                    Instant createdAt, String payload) {
        jdbcTemplate.update("INSERT INTO context_events "
                        + "(id, session_id, workspace_id, user_id, event_type, sequence, payload, "
                        + "correlation_id, created_at) VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?, ?, "
                        + "CAST(? AS jsonb), ?, ?)",
                eventId.toString(), sessionId.toString(), workspaceId.toString(), userId.toString(),
                eventType, sequence, payload, runId.toString(), Timestamp.from(createdAt));
    }

    private void insertMcpInvocation(UUID toolCallId, Instant startedAt, Instant finishedAt) {
        Timestamp started = Timestamp.from(startedAt);
        Timestamp finished = Timestamp.from(finishedAt);
        jdbcTemplate.update("INSERT INTO mcp_invocations "
                        + "(id, tool_call_id, run_id, session_id, workspace_id, user_id, source, tool_name, "
                        + "status, started_at, finished_at, created_at, updated_at) "
                        + "VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, 'agent', ?, "
                        + "'completed', ?, ?, ?, ?)",
                UUID.randomUUID().toString(), toolCallId.toString(), runId.toString(), sessionId.toString(),
                workspaceId.toString(), userId.toString(), "mcp__files__read", started, finished,
                started, finished);
    }
}
