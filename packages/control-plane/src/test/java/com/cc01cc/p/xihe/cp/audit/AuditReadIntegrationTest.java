package com.cc01cc.p.xihe.cp.audit;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.ApprovalHistory;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ChatRunHistory;
import com.cc01cc.p.xihe.cp.entity.McpAttempt;
import com.cc01cc.p.xihe.cp.entity.McpInvocation;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.WorkspaceJob;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.mcp.McpInvocationService;
import com.cc01cc.p.xihe.cp.operation.JobStateService;
import com.cc01cc.p.xihe.cp.repository.ApprovalHistoryRepository;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunHistoryRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.McpAttemptRepository;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0466 T3.1 / verify V1-V3: the audit read view, its routes, ACL tiers and
 * redaction matrix against a real PostgreSQL schema (V54 view included).
 *
 * <p>Fixture: 9 entries for one owner — 4 chat_runs (one with terminal history, one
 * terminal without history, two in flight), 1 workspace_job (start → running →
 * cancel), 3 mcp_invocations (completed / unknown / late-confirmed) and 1 approval
 * (requested → decided) — plus a second user for the negative authorization cases.</p>
 */
class AuditReadIntegrationTest extends AbstractIntegrationTest {

    /** /internal/v1 only accepts the service Bearer (SecurityConfig hasRole INTERNAL_SERVICE). */
    private static final String SERVICE_TOKEN = "dev-token-not-secure";

    private static final int FIXTURE_ENTRIES = 9;

    /** Raw-argument marker: must never appear in user or internal responses. */
    private static final String RAW_ARGS_MARKER = "SENSITIVE_ARGUMENT_PREVIEW_VALUE";
    private static final String ERROR_DETAIL_MARKER = "SENSITIVE_CHAT_ERROR_DETAIL";
    private static final String HISTORY_PAYLOAD_MARKER = "SENSITIVE_HISTORY_PAYLOAD";
    private static final String POLICY_RAW_MARKER = "SENSITIVE_POLICY_RAW_VALUE";

    private static final String VALID_MCP_POLICY = "{\"effect\":\"allow\",\"sourceLayer\":\"builtin\","
            + "\"matchedRule\":\"audit-rule\",\"reason\":\"auto allow for the audit read view\","
            + "\"mode\":\"auto\",\"allowedBy\":\"mode\",\"actionClass\":\"write\","
            + "\"shape\":\"structured\",\"reused\":false}";

    private static final String VALID_APPROVAL_POLICY = "{\"effect\":\"ask\",\"sourceLayer\":\"builtin\","
            + "\"matchedRule\":null,\"reason\":\"manual approval required\","
            + "\"mode\":\"manual\",\"actionClass\":\"write\",\"shape\":\"structured\"}";

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceRepository workspaceRepository;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private ChatRunHistoryRepository chatRunHistoryRepository;
    @Autowired private ChatApprovalRepository chatApprovalRepository;
    @Autowired private ApprovalHistoryRepository approvalHistoryRepository;
    @Autowired private McpInvocationRepository mcpInvocationRepository;
    @Autowired private McpAttemptRepository mcpAttemptRepository;
    @Autowired private McpInvocationService mcpInvocationService;
    @Autowired private JobStateService jobStateService;
    @Autowired private JdbcTemplate jdbcTemplate;

    private String userId;
    private String otherUserId;
    private String workspaceId;
    private String otherWorkspaceId;
    private String sessionId;
    private String runId;
    private String authToken;
    private String otherAuthToken;

    private UUID chatRunId;
    private UUID historylessRunId;
    private UUID jobId;
    private UUID settledInvocationId;
    private UUID unknownInvocationId;
    private UUID lateInvocationId;
    private UUID approvalRequestId;

    @BeforeEach
    void seedAuditFixture() {
        String ownerEmail = newEmail("audit-owner");
        authToken = register(ownerEmail);
        User user = userRepository.findByEmail(ownerEmail).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow().getId().toString();

        String otherEmail = newEmail("audit-other");
        otherAuthToken = register(otherEmail);
        User otherUser = userRepository.findByEmail(otherEmail).orElseThrow();
        otherUserId = otherUser.getId().toString();
        otherWorkspaceId = workspaceRepository
                .findActiveByMemberUserId(UUID.fromString(otherUserId))
                .stream().findFirst().orElseThrow().getId().toString();

        Session session = new Session(workspaceId, userId, "Audit read session");
        session.setId(UUID.randomUUID());
        sessionId = sessionRepository.save(session).getId().toString();

        // chat_run with a terminal history row
        chatRunId = UUID.randomUUID();
        runId = chatRunId.toString();
        ChatRun run = new ChatRun(chatRunId.toString(), sessionId, userId, workspaceId,
                "audit-chat-key-1", "hash", "provider", "audit-model", "workspace", "succeeded");
        run.setTerminalAt(Instant.now());
        run.setTerminalOutcome("success");
        run.setErrorDetail(ERROR_DETAIL_MARKER);
        chatRunRepository.saveAndFlush(run);
        ChatRunHistory terminal = new ChatRunHistory();
        terminal.setId(UUID.randomUUID());
        terminal.setRunId(chatRunId);
        terminal.setSessionId(UUID.fromString(sessionId));
        terminal.setSequence(1L);
        terminal.setEventType(ChatRunHistory.EVENT_TERMINAL);
        terminal.setSource(ChatRunHistory.SOURCE_STREAM);
        terminal.setActorType("system");
        terminal.setFromStatus("running");
        terminal.setToStatus("succeeded");
        terminal.setTerminalOutcome("success");
        terminal.setPayload("{\"tokens\":10,\"marker\":\"" + HISTORY_PAYLOAD_MARKER + "\"}");
        chatRunHistoryRepository.saveAndFlush(terminal);

        // terminal chat_run without any history row (pre-V50 shape: degrade branch)
        historylessRunId = UUID.randomUUID();
        ChatRun bare = new ChatRun(historylessRunId.toString(), sessionId, userId, workspaceId,
                "audit-chat-key-2", "hash", "provider", null, "workspace", "failed");
        bare.setTerminalAt(Instant.now());
        bare.setTerminalOutcome("error");
        bare.setErrorCode("CHAT_FAILED");
        chatRunRepository.saveAndFlush(bare);

        // two in-flight chat runs so the paged view has volume
        for (int i = 0; i < 2; i++) {
            chatRunRepository.saveAndFlush(new ChatRun(UUID.randomUUID().toString(), sessionId,
                    userId, workspaceId, "audit-chat-extra-" + i, "hash", "provider",
                    "audit-model", "workspace", "running"));
        }

        seedWorkspaceJob();
        seedMcpInvocations();
        seedApproval();
    }

    // ------------------------------------------------------------------
    // V1: view coverage + type tags + user-tier projection
    // ------------------------------------------------------------------

    @Test
    void listCoversAllFourDomainTypesWithUserTierOnly() {
        Map<String, Object> body = listOk("?size=50", authToken);
        List<Map<String, Object>> entries = entries(body);
        assertEquals(FIXTURE_ENTRIES, entries.size());
        assertEquals(FIXTURE_ENTRIES, total(body));

        Map<String, Map<String, Object>> byId = new LinkedHashMap<>();
        entries.forEach(entry -> byId.put(String.valueOf(entry.get("id")), entry));

        Map<String, Object> chat = byId.get(chatRunId.toString());
        assertNotNull(chat, "terminal chat run must surface");
        assertEquals("chat_run", chat.get("type"));
        assertEquals("succeeded", chat.get("status"));
        assertEquals("audit-model", chat.get("summary"));
        assertEquals("user_submission", chat.get("source"));
        assertEquals("success", chat.get("terminalOutcome"));
        assertNotNull(chat.get("finishedAt"));
        assertNull(chat.get("startedAt"), "chat_runs has no start column");

        Map<String, Object> job = byId.get(jobId.toString());
        assertNotNull(job, "workspace job must surface");
        assertEquals("workspace_job", job.get("type"));
        assertEquals("cancelled", job.get("status"));
        assertEquals("user_cancel", job.get("cancelReason"));
        assertEquals("run", job.get("scope"));

        Map<String, Object> mcp = byId.get(settledInvocationId.toString());
        assertNotNull(mcp, "mcp invocation must surface");
        assertEquals("mcp_invocation", mcp.get("type"));
        assertEquals("write_file", mcp.get("summary"));

        Map<String, Object> approval = byId.get(approvalRequestId.toString());
        assertNotNull(approval, "approval must surface");
        assertEquals("approval", approval.get("type"));
        assertEquals("approved", approval.get("status"));
        assertEquals("write_file", approval.get("summary"));

        // user tier redaction: internal identity/correlation keys are absent, not null
        for (Map<String, Object> entry : entries) {
            assertFalse(entry.containsKey("userId"), "user view must not emit userId");
            assertFalse(entry.containsKey("idempotencyKey"), "no idempotencyKey in the user view");
            assertFalse(entry.containsKey("requestId"), "user view must not emit requestId");
            assertFalse(entry.containsKey("runtimeJobId"), "user view must not emit runtimeJobId");
            assertFalse(entry.containsKey("argumentsPreview"), "no raw arguments in the user view");
        }
        String raw = body.toString();
        assertFalse(raw.contains(RAW_ARGS_MARKER), "arguments_preview must never leave CP");
        assertFalse(raw.contains(ERROR_DETAIL_MARKER), "chat error_detail is not an audit column");
        assertFalse(raw.contains(HISTORY_PAYLOAD_MARKER), "history payload is not an audit column");
    }

    // ------------------------------------------------------------------
    // V1: filters, unknown values, pagination boundaries
    // ------------------------------------------------------------------

    @Test
    void listFiltersByTypeStatusSessionAndUnknownValues() {
        List<Map<String, Object>> chatOnly = entries(listOk("?type=chat_run&size=50", authToken));
        assertFalse(chatOnly.isEmpty());
        assertTrue(chatOnly.stream().allMatch(e -> "chat_run".equals(e.get("type"))));

        Map<String, Object> byStatus =
                listOk("?type=workspace_job&status=cancelled", authToken);
        assertEquals(1L, total(byStatus));

        Map<String, Object> unknownStatus = listOk("?status=__no_such_status__", authToken);
        assertTrue(entries(unknownStatus).isEmpty());
        assertEquals(0L, total(unknownStatus));
        assertEquals(0, unknownStatus.get("totalPages"));

        ResponseEntity<Map> unknownType = list("?type=__no_such_type__", authToken);
        assertEquals(HttpStatus.BAD_REQUEST, unknownType.getStatusCode());
        assertEquals("INVALID_REQUEST", unknownType.getBody().get("code"));

        ResponseEntity<Map> foreignSession = list("?sessionId=" + UUID.randomUUID(), authToken);
        assertEquals(HttpStatus.OK, foreignSession.getStatusCode());
        assertTrue(entries(foreignSession.getBody()).isEmpty());

        Map<String, Object> ownSession =
                listOk("?sessionId=" + sessionId + "&size=50", authToken);
        assertEquals(FIXTURE_ENTRIES, total(ownSession),
                "session scope keeps only this session's entries");
    }

    @Test
    void listPaginationBoundariesAndClamping() {
        Map<String, Object> firstPage = listOk("?page=0&size=3", authToken);
        int totalPages = (int) firstPage.get("totalPages");
        assertTrue(totalPages >= 2, "fixture must span several pages, got " + totalPages);
        assertEquals(3, firstPage.get("size"));
        assertEquals(3, entries(firstPage).size());

        Map<String, Object> lastPage =
                listOk("?page=" + (totalPages - 1) + "&size=3", authToken);
        assertFalse(entries(lastPage).isEmpty());

        Map<String, Object> beyondEnd = listOk("?page=" + totalPages + "&size=3", authToken);
        assertTrue(entries(beyondEnd).isEmpty(), "a page beyond the end is an empty set");
        assertEquals(total(firstPage), total(beyondEnd), "total does not depend on the page");

        Map<String, Object> maxPage = listOk("?page=2147483647&size=100", authToken);
        assertTrue(entries(maxPage).isEmpty(), "large page offsets must not overflow negative");
        assertEquals(total(firstPage), total(maxPage));

        Map<String, Object> clamped = listOk("?page=-5&size=1000", authToken);
        assertEquals(0, clamped.get("page"), "negative page clamps to 0");
        assertEquals(100, clamped.get("size"), "size clamps to the 100 cap");

        Map<String, Object> zeroSize = listOk("?size=0", authToken);
        assertEquals(1, zeroSize.get("size"), "size clamps to a minimum of 1");
    }

    // ------------------------------------------------------------------
    // V2: cross-user / cross-workspace negatives and 404 semantics
    // ------------------------------------------------------------------

    @Test
    void crossUserDetailIs404AndIndistinguishableFromMissing() {
        String path = "/api/v1/audit/entries/chat_run/" + chatRunId;
        ResponseEntity<Map> foreign = get(path, otherAuthToken);
        assertEquals(HttpStatus.NOT_FOUND, foreign.getStatusCode());
        assertEquals("AUDIT_ENTRY_NOT_FOUND", foreign.getBody().get("code"));

        ResponseEntity<Map> missing =
                get("/api/v1/audit/entries/chat_run/" + UUID.randomUUID(), otherAuthToken);
        assertEquals(HttpStatus.NOT_FOUND, missing.getStatusCode());
        assertEquals("AUDIT_ENTRY_NOT_FOUND", missing.getBody().get("code"));
        assertEquals(foreign.getBody().get("detail"), missing.getBody().get("detail"),
                "wrong-owner and unknown ids must be indistinguishable");

        ResponseEntity<Map> owner = get(path, authToken);
        assertEquals(HttpStatus.OK, owner.getStatusCode());
    }

    @Test
    void crossUserListIsIsolatedAndCrossWorkspaceIsDenied() {
        ResponseEntity<Map> otherList = list("?size=50", otherAuthToken);
        assertEquals(HttpStatus.OK, otherList.getStatusCode());
        assertTrue(entries(otherList.getBody()).isEmpty(),
                "user B sees none of user A's entries");

        ResponseEntity<Map> foreignWorkspace = list("?workspaceId=" + otherWorkspaceId, authToken);
        assertEquals(HttpStatus.NOT_FOUND, foreignWorkspace.getStatusCode());
        assertEquals("WORKSPACE_NOT_FOUND", foreignWorkspace.getBody().get("code"));

        ResponseEntity<Map> unknownWorkspace =
                list("?workspaceId=" + UUID.randomUUID(), authToken);
        assertEquals(HttpStatus.NOT_FOUND, unknownWorkspace.getStatusCode());

        Map<String, Object> ownWorkspace =
                listOk("?workspaceId=" + workspaceId + "&size=50", authToken);
        assertEquals(FIXTURE_ENTRIES, total(ownWorkspace));
    }

    @Test
    void invalidTypeTagAndEntryIdAre400() {
        ResponseEntity<Map> badType = get("/api/v1/audit/entries/__bogus__/" + chatRunId, authToken);
        assertEquals(HttpStatus.BAD_REQUEST, badType.getStatusCode());
        assertEquals("INVALID_REQUEST", badType.getBody().get("code"));

        ResponseEntity<Map> badId = get("/api/v1/audit/entries/chat_run/not-a-uuid", authToken);
        assertEquals(HttpStatus.BAD_REQUEST, badId.getStatusCode());
        assertEquals("INVALID_REQUEST", badId.getBody().get("code"));

        ResponseEntity<Map> badSession = list("?sessionId=not-a-uuid", authToken);
        assertEquals(HttpStatus.BAD_REQUEST, badSession.getStatusCode());
    }

    // ------------------------------------------------------------------
    // V3: detail timeline per domain, degrade branch, unknown/late display
    // ------------------------------------------------------------------

    @Test
    void detailTimelineIsReadFromTheMatchingHistoryTable() {
        Map<String, Object> chat = detailOk("chat_run", chatRunId, authToken);
        assertEquals("chat_run", entry(chat).get("type"));
        List<Map<String, Object>> chatTimeline = timeline(chat);
        assertEquals(1, chatTimeline.size());
        assertEquals("terminal", chatTimeline.get(0).get("eventType"));
        assertEquals("running", chatTimeline.get(0).get("fromStatus"));
        assertEquals("succeeded", chatTimeline.get(0).get("toStatus"));
        assertFalse(chatTimeline.get(0).containsKey("payload"),
                "history payload TEXT is never projected");

        Map<String, Object> job = detailOk("workspace_job", jobId, authToken);
        List<Map<String, Object>> jobTimeline = timeline(job);
        assertEquals(3, jobTimeline.size(), "start -> running -> cancel must all surface");
        assertEquals("start", jobTimeline.get(0).get("eventType"));
        assertEquals("running", jobTimeline.get(1).get("eventType"));
        assertEquals("cancel", jobTimeline.get(2).get("eventType"));
        assertEquals("user_cancel", jobTimeline.get(2).get("cancelReason"));

        Map<String, Object> mcp = detailOk("mcp_invocation", settledInvocationId, authToken);
        List<Map<String, Object>> mcpTimeline = timeline(mcp);
        assertFalse(mcpTimeline.isEmpty());
        assertEquals("invocation.opened", mcpTimeline.get(0).get("eventType"));
        List<Map<String, Object>> attempts = attempts(mcp);
        assertEquals(1, attempts.size());
        assertEquals("cp_forward", attempts.get(0).get("stage"));
        assertEquals("succeeded", attempts.get(0).get("status"));
        assertFalse(attempts.get(0).containsKey("httpStatus"), "user attempts omit httpStatus");
        assertFalse(attempts.get(0).containsKey("resultRef"), "user attempts omit resultRef");

        Map<String, Object> approval = detailOk("approval", approvalRequestId, authToken);
        List<Map<String, Object>> approvalTimeline = timeline(approval);
        assertEquals(2, approvalTimeline.size());
        assertEquals("requested", approvalTimeline.get(0).get("eventType"));
        assertEquals("decided", approvalTimeline.get(1).get("eventType"));
        assertEquals(Boolean.TRUE, approvalTimeline.get(1).get("approved"));
        assertEquals("approved", entry(approval).get("status"));

        ResponseEntity<Map> foreign = detail("chat_run", chatRunId, otherAuthToken);
        assertEquals(HttpStatus.NOT_FOUND, foreign.getStatusCode());
    }

    @Test
    void entryWithoutHistoryDegradesToCurrentStateAndTerminalOutcome() {
        Map<String, Object> body = detailOk("chat_run", historylessRunId, authToken);
        assertTrue(timeline(body).isEmpty(),
                "a row without history keeps an empty timeline instead of inventing events");
        Map<String, Object> entry = entry(body);
        assertEquals("failed", entry.get("status"));
        assertEquals("error", entry.get("terminalOutcome"));
        assertEquals("CHAT_FAILED", entry.get("errorCode"));
        assertNotNull(entry.get("finishedAt"), "terminal time still displays");
        assertTrue(attempts(body).isEmpty());
    }

    @Test
    void unknownAndLateStatesDisplayAsRecorded() {
        // unsettled invocation: shown with its native unknown status, not coerced
        Map<String, Object> unknownList = listOk("?type=mcp_invocation&status=unknown", authToken);
        List<Map<String, Object>> unknownEntries = entries(unknownList);
        assertEquals(1, unknownEntries.size());
        assertEquals(unknownInvocationId.toString(), unknownEntries.get(0).get("id"));
        assertEquals("unknown", unknownEntries.get(0).get("status"));

        Map<String, Object> unknownDetail = detailOk("mcp_invocation", unknownInvocationId, authToken);
        assertEquals("unknown", entry(unknownDetail).get("status"));

        // late termination report: recorded as its own timeline event
        Map<String, Object> lateDetail = detailOk("mcp_invocation", lateInvocationId, authToken);
        List<String> eventTypes = timeline(lateDetail).stream()
                .map(event -> String.valueOf(event.get("eventType"))).toList();
        assertTrue(eventTypes.contains("attempt.unknown"), eventTypes.toString());
        assertTrue(eventTypes.contains("attempt.late_confirmed"), eventTypes.toString());
        assertEquals("late_confirmed", attempts(lateDetail).get(0).get("status"));
    }

    // ------------------------------------------------------------------
    // V2: policy summary safety + internal tier
    // ------------------------------------------------------------------

    @Test
    void policySummaryIsProjectedOnlyAsTheSafeParsedShape() {
        Map<String, Object> mcp = detailOk("mcp_invocation", settledInvocationId, authToken);
        @SuppressWarnings("unchecked")
        Map<String, Object> policy = (Map<String, Object>) entry(mcp).get("policy");
        assertNotNull(policy, "a valid snapshot must surface as the safe projection");
        assertEquals("allow", policy.get("effect"));
        assertEquals("builtin", policy.get("sourceLayer"));
        assertEquals("auto", policy.get("mode"));
        assertEquals("write", policy.get("actionClass"));
        assertEquals("structured", policy.get("shape"));
        assertFalse(policy.containsKey("rawArguments"), "extra keys never survive the parser");
        assertFalse(mcp.toString().contains(RAW_ARGS_MARKER));

        Map<String, Object> approval = detailOk("approval", approvalRequestId, authToken);
        @SuppressWarnings("unchecked")
        Map<String, Object> approvalPolicy = (Map<String, Object>) entry(approval).get("policy");
        assertNotNull(approvalPolicy, "approval snapshots project through their own parser");
        assertEquals("ask", approvalPolicy.get("effect"));
        assertTrue(approvalPolicy.containsKey("allowedBy"),
                "the wire shape carries allowedBy explicitly");
        assertNull(approvalPolicy.get("allowedBy"),
                "an approval snapshot has no automatic-allow marker to report");
        assertTrue(approvalPolicy.containsKey("reused"),
                "the wire shape carries the reuse annotation explicitly");
        assertNull(approvalPolicy.get("reused"),
                "reuse annotation is not applicable for approvals and stays null");

        Map<String, Object> malformed = detailOk("mcp_invocation", lateInvocationId, authToken);
        assertFalse(entry(malformed).containsKey("policy"),
                "an unreadable snapshot is omitted, never guessed");
        assertFalse(malformed.toString().contains(POLICY_RAW_MARKER),
                "raw policy_summary TEXT must not leak");
    }

    @Test
    void internalTierWidensReferencesButNeverRawArguments() {
        ResponseEntity<Map> detail = get(
                "/internal/v1/audit/entries/mcp_invocation/" + settledInvocationId, SERVICE_TOKEN);
        assertEquals(HttpStatus.OK, detail.getStatusCode());
        Map<String, Object> body = detail.getBody();
        @SuppressWarnings("unchecked")
        Map<String, Object> internalEntry = (Map<String, Object>) body.get("entry");
        assertEquals(userId, internalEntry.get("userId"), "internal tier carries the owner id");
        assertNotNull(internalEntry.get("requestId"), "internal tier carries the correlation id");
        assertTrue(internalEntry.containsKey("idempotencyKey"));

        List<Map<String, Object>> internalAttempts = attempts(body);
        assertEquals(1, internalAttempts.size());
        assertTrue(internalAttempts.get(0).containsKey("httpStatus"));
        assertTrue(internalAttempts.get(0).containsKey("resultRef"));
        assertEquals("artifact://audit-result-ref", internalAttempts.get(0).get("resultRef"));

        String raw = body.toString();
        assertFalse(raw.contains(RAW_ARGS_MARKER), "no raw arguments in the internal view either");
        assertFalse(raw.contains(HISTORY_PAYLOAD_MARKER));
        assertFalse(raw.contains(ERROR_DETAIL_MARKER));

        // chat_run internal detail carries the chat idempotency key; user detail must not
        ResponseEntity<Map> internalChat =
                get("/internal/v1/audit/entries/chat_run/" + chatRunId, SERVICE_TOKEN);
        assertEquals(HttpStatus.OK, internalChat.getStatusCode());
        @SuppressWarnings("unchecked")
        Map<String, Object> chatEntry =
                (Map<String, Object>) internalChat.getBody().get("entry");
        assertEquals("audit-chat-key-1", chatEntry.get("idempotencyKey"));
        Map<String, Object> userChat = detailOk("chat_run", chatRunId, authToken);
        assertFalse(entry(userChat).containsKey("idempotencyKey"));

        // a user token and an anonymous caller cannot reach the internal surface
        ResponseEntity<Map> userOnInternal = get(
                "/internal/v1/audit/entries/mcp_invocation/" + settledInvocationId, authToken);
        assertTrue(userOnInternal.getStatusCode().is4xxClientError(),
                "user token must not pass the service gate: " + userOnInternal.getStatusCode());
        ResponseEntity<Map> anonymous = get(
                "/internal/v1/audit/entries/mcp_invocation/" + settledInvocationId, null);
        assertEquals(HttpStatus.UNAUTHORIZED, anonymous.getStatusCode());
    }

    // ------------------------------------------------------------------
    // T1.1: EXPLAIN evidence for the paged VIEW query
    // ------------------------------------------------------------------

    @Test
    void explainOwnerScopedPaginationUsesTheAuditIndexes() {
        // EXPLAIN runs on a raw Statement, so the owner id is inlined (test-controlled
        // UUID; no user input ever reaches a statement string).
        String sql = "EXPLAIN SELECT type, entry_id FROM v_audit_entries WHERE user_id = '"
                + userId + "' ORDER BY created_at DESC, entry_id DESC LIMIT 20 OFFSET 0";
        String plan = jdbcTemplate.execute((ConnectionCallback<String>) con -> {
            try (Statement statement = con.createStatement()) {
                statement.execute("SET enable_seqscan = off");
                try {
                    List<String> lines = new ArrayList<>();
                    try (ResultSet rs = statement.executeQuery(sql)) {
                        while (rs.next()) {
                            lines.add(rs.getString(1));
                        }
                    }
                    return String.join("\n", lines);
                } finally {
                    statement.execute("RESET enable_seqscan");
                }
            }
        });
        assertNotNull(plan);
        System.out.println("[AUDIT_EXPLAIN]\n" + plan);
        // The planner inlines the view, so the evidence is: all four branches were
        // index-scanned on the owner column instead of sequentially scanned.
        assertTrue(plan.contains("Index"), "owner pagination must be index-backed:\n" + plan);
        for (String table : List.of("chat_runs", "workspace_jobs", "mcp_invocations",
                "approval_requests")) {
            assertTrue(plan.contains(table), "branch missing from the plan: " + table + "\n" + plan);
        }
        assertFalse(plan.contains("Seq Scan"), "no sequential scan in the owner path:\n" + plan);
    }

    // ------------------------------------------------------------------
    // fixtures
    // ------------------------------------------------------------------

    private void seedWorkspaceJob() {
        jobId = UUID.randomUUID();
        WorkspaceJob job = new WorkspaceJob();
        job.setId(jobId);
        job.setWorkspaceId(UUID.fromString(workspaceId));
        job.setUserId(UUID.fromString(userId));
        job.setSessionId(UUID.fromString(sessionId));
        job.setRunId(chatRunId);
        job.setSource("mcp");
        job.setScope("run");
        job.setStatus("pending");
        Map<String, Object> initial = new LinkedHashMap<>();
        initial.put("jobId", "runtime-job-audit-1");
        initial.put("scope", "run");
        initial.put("status", "pending");
        jobStateService.createJob(job, initial);
        jobStateService.upsertById(jobId, Map.of("status", "running"));
        jobStateService.upsertById(jobId,
                Map.of("status", "cancelled", "cancelReason", "user_cancel"));
        assertEquals("cancelled",
                jobStateService.findByJobId(jobId).map(JobStateService.JobArchive::status)
                        .orElse(null), "job seed must reach the cancelled terminal state");
    }

    private void seedMcpInvocations() {
        // completed invocation with a valid safe policy snapshot
        settledInvocationId = openInvocation("11111111-1111-4111-8111-111111111111",
                "{\"path\":\"" + RAW_ARGS_MARKER + "\"}");
        UUID attempt = mcpInvocationService
                .startDispatchAttempt(settledInvocationId, UUID.randomUUID().toString())
                .orElseThrow();
        mcpInvocationService.finishDispatchAttempt(settledInvocationId, attempt, 200, null,
                McpInvocationService.McpDispatchVerdict.COMPLETED);
        mcpInvocationService.attachPolicySummary(settledInvocationId, VALID_MCP_POLICY);
        McpAttempt finished = mcpAttemptRepository.findById(attempt).orElseThrow();
        finished.setResultRef("artifact://audit-result-ref");
        mcpAttemptRepository.save(finished);

        // unknown invocation: left as recorded for the native display
        unknownInvocationId = openInvocation("22222222-2222-4222-8222-222222222222",
                "{\"path\":\"other.txt\"}");
        UUID unknownAttempt = mcpInvocationService
                .startDispatchAttempt(unknownInvocationId, UUID.randomUUID().toString())
                .orElseThrow();
        mcpInvocationService.finishDispatchAttempt(unknownInvocationId, unknownAttempt, 0,
                "DISPATCH_UNKNOWN", null);
        assertEquals("unknown", mcpInvocationRepository.findById(unknownInvocationId)
                .map(McpInvocation::getStatus).orElse(null));

        // late termination report on an unknown invocation
        lateInvocationId = openInvocation("33333333-3333-4333-8333-333333333333",
                "{\"path\":\"late.txt\"}");
        UUID lateAttempt = mcpInvocationService
                .startDispatchAttempt(lateInvocationId, UUID.randomUUID().toString())
                .orElseThrow();
        mcpInvocationService.finishDispatchAttempt(lateInvocationId, lateAttempt, 0,
                "DISPATCH_UNKNOWN", null);
        McpInvocation lateRow = mcpInvocationRepository.findById(lateInvocationId).orElseThrow();
        lateRow.setPolicySummary(
                "{\"effect\":\"ask\",\"rawArguments\":\"" + POLICY_RAW_MARKER + "\"}");
        mcpInvocationRepository.save(lateRow);
        mcpInvocationService.recordLateTermination(lateInvocationId, lateAttempt, true);
    }

    private UUID openInvocation(String toolCallId, String argumentsPreview) {
        Optional<UUID> id = mcpInvocationService.openAgentInvocation(runId, toolCallId,
                "write_file", UUID.randomUUID().toString(), argumentsPreview);
        assertTrue(id.isPresent(), "run-scoped invocation must open for " + toolCallId);
        return id.orElseThrow();
    }

    private void seedApproval() {
        approvalRequestId = UUID.randomUUID();
        ChatApproval approval = new ChatApproval(approvalRequestId.toString(),
                chatRunId.toString(), sessionId, userId, workspaceId, "write_file",
                "Write file audit.md", "bounded detail preview", "approved",
                Instant.now().plusSeconds(3600), "args-hash");
        approval.setApproved(true);
        approval.setDecisionKind("user");
        approval.setDecidedAt(Instant.now());
        approval.setOrigin("cp_gate");
        approval.setPolicySummary(VALID_APPROVAL_POLICY);
        chatApprovalRepository.saveAndFlush(approval);

        ApprovalHistory requested = new ApprovalHistory();
        requested.setId(UUID.randomUUID());
        requested.setRequestId(approvalRequestId);
        requested.setRunId(chatRunId);
        requested.setSessionId(UUID.fromString(sessionId));
        requested.setSequence(1L);
        requested.setEventType(ApprovalHistory.EVENT_REQUESTED);
        requested.setToState("pending");
        requested.setActorType("agent");
        approvalHistoryRepository.saveAndFlush(requested);

        ApprovalHistory decided = new ApprovalHistory();
        decided.setId(UUID.randomUUID());
        decided.setRequestId(approvalRequestId);
        decided.setRunId(chatRunId);
        decided.setSessionId(UUID.fromString(sessionId));
        decided.setSequence(2L);
        decided.setEventType(ApprovalHistory.EVENT_DECIDED);
        decided.setFromState("pending");
        decided.setToState("approved");
        decided.setApproved(true);
        decided.setDecisionKind("user");
        decided.setActorType("user");
        approvalHistoryRepository.saveAndFlush(decided);
    }

    // ------------------------------------------------------------------
    // HTTP helpers
    // ------------------------------------------------------------------

    private static String newEmail(String prefix) {
        return prefix + "-" + UUID.randomUUID() + "@test.com";
    }

    private String register(String email) {
        ResponseEntity<AuthResponse> response = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "Audit read test"),
                AuthResponse.class);
        assertNotNull(response.getBody());
        return response.getBody().getAccessToken();
    }

    private HttpHeaders bearer(String token) {
        HttpHeaders headers = new HttpHeaders();
        if (token != null) {
            headers.setBearerAuth(token);
        }
        return headers;
    }

    private ResponseEntity<Map> get(String path, String token) {
        return restTemplate.exchange(baseUrl + path, HttpMethod.GET,
                new HttpEntity<>(bearer(token)), Map.class);
    }

    /** Raw list request (keeps the status/body for negative assertions). */
    private ResponseEntity<Map> list(String query, String token) {
        return get("/api/v1/audit/entries" + query, token);
    }

    private Map<String, Object> listOk(String query, String token) {
        ResponseEntity<Map> response = list(query, token);
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        return response.getBody();
    }

    private Map<String, Object> detailOk(String type, UUID id, String token) {
        ResponseEntity<Map> response = detail(type, id, token);
        assertEquals(HttpStatus.OK, response.getStatusCode(), String.valueOf(response.getBody()));
        return response.getBody();
    }

    private ResponseEntity<Map> detail(String type, UUID id, String token) {
        return get("/api/v1/audit/entries/" + type + "/" + id, token);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> entries(Map<String, Object> body) {
        Object entries = body.get("entries");
        assertTrue(entries instanceof List, "list body must carry entries");
        return (List<Map<String, Object>>) entries;
    }

    private static long total(Map<String, Object> body) {
        Object total = body.get("totalElements");
        assertTrue(total instanceof Number, "totalElements must be numeric");
        return ((Number) total).longValue();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> timeline(Map<String, Object> detail) {
        return (List<Map<String, Object>>) detail.get("timeline");
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> attempts(Map<String, Object> detail) {
        return (List<Map<String, Object>>) detail.get("attempts");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> entry(Map<String, Object> detail) {
        Object entry = detail.get("entry");
        assertTrue(entry instanceof Map, "detail must carry an entry object");
        return (Map<String, Object>) entry;
    }
}
