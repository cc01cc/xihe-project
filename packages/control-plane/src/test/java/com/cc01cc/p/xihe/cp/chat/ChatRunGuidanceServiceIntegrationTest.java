package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.ChatRunGuidance;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ChatRunGuidanceRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;

/**
 * PLAN-0528 M4: real CP+PostgreSQL integration for Guidance idempotency,
 * active-state gating, terminal settlement and consume semantics (frozen:
 * spec/session/chat-run-operation.md §Run Guidance). No mock store.
 */
class ChatRunGuidanceServiceIntegrationTest extends AbstractIntegrationTest {

    @MockitoSpyBean
    private ChatRunGuidanceService service;

    @Autowired
    private ChatRunTerminalService terminalService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private ChatRunGuidanceRepository guidance;

    @Autowired
    private ChatRunRepository runs;

    @Autowired
    private SessionRepository sessions;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    private String userId;
    private String workspaceId;
    private String sessionId;

    @BeforeEach
    void setUp() {
        String email = "guidance-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "Guidance Probe");
        ResponseEntity<AuthResponse> reg = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        assertTrue(reg.getStatusCode().is2xxSuccessful());

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow().getId().toString();

        Session session = new Session(workspaceId, userId, "Guidance Probe Session");
        session.setId(UUID.randomUUID());
        sessionId = sessions.save(session).getId().toString();
    }

    private String createRun(String status) {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), sessionId, userId, workspaceId,
                "guidance-key-" + UUID.randomUUID(), "hash", "provider", "model", "workspace", status);
        return runs.save(run).getId().toString();
    }

    @Test
    void submitIsDurableOrderedAndIdempotent() {
        String runId = createRun("running");

        var first = service.submit(runId, userId, workspaceId, "idem-1", "first guidance");
        var second = service.submit(runId, userId, workspaceId, "idem-2", "second guidance");
        var replay = service.submit(runId, userId, workspaceId, "idem-1", "first guidance");

        assertTrue(first.record().getSequence() >= 1);
        assertEquals(first.record().getSequence() + 1, second.record().getSequence());
        assertEquals(first.record().getId(), replay.record().getId(), "same key must replay original row");
        assertTrue(replay.replayed());
        assertNotEquals(replay.record().getSequence(), second.record().getSequence());
        assertEquals(2, guidance.findByRunIdOrderBySequenceAsc(first.record().getRunId()).size());
    }

    @Test
    void submitRejectsNonActiveRuns() {
        for (String status : new String[] {"queued", "accepted", "cancelling", "succeeded", "failed"}) {
            String runId = createRun(status);
            CpApiException rejected = assertThrows(CpApiException.class,
                    () -> service.submit(runId, userId, workspaceId, "idem-" + status, "content"));
            assertEquals(ChatRunGuidanceService.ERROR_RUN_NOT_ACTIVE, rejected.getCode(), status);
        }
    }

    @Test
    void consumeIsIdempotentAndFirstWins() {
        String runId = createRun("streaming");
        var submitted = service.submit(runId, userId, workspaceId, "idem-c1", "guidance");

        var first = service.consume(runId, submitted.record().getId().toString());
        var replay = service.consume(runId, submitted.record().getId().toString());

        assertTrue(first.firstConsumption());
        assertNotEquals(true, replay.firstConsumption());
        assertEquals(ChatRunGuidance.STATUS_CONSUMED, replay.record().getStatus());
        // DB round-trip truncates sub-microsecond precision; idempotency = same state, not nanosecond equality.
        assertEquals(first.record().getConsumedAt().toEpochMilli() / 1000,
                replay.record().getConsumedAt().toEpochMilli() / 1000);
    }

    @Test
    void consumeAfterTerminalExpiredReturnsExplicitConflict() {
        String runId = createRun("running");
        var submitted = service.submit(runId, userId, workspaceId, "idem-t1", "guidance");
        service.settleTerminal(submitted.record().getRunId());

        CpApiException rejected = assertThrows(CpApiException.class,
                () -> service.consume(runId, submitted.record().getId().toString()));
        assertEquals(ChatRunGuidanceService.ERROR_ALREADY_TERMINAL_EXPIRED, rejected.getCode());
    }

    @Test
    void pendingForAgentReturnsOnlyPendingInSequenceOrder() {
        String runId = createRun("running");
        var a = service.submit(runId, userId, workspaceId, "idem-p1", "a");
        var b = service.submit(runId, userId, workspaceId, "idem-p2", "b");
        service.consume(runId, a.record().getId().toString());

        List<ChatRunGuidance> pending = service.pendingForAgent(runId);

        assertEquals(1, pending.size());
        assertEquals(b.record().getId(), pending.get(0).getId());
    }

    @Test
    void recoveryExpiresPendingOnTerminalRuns() {
        // Simulate a pre-deploy crash window: run settles terminal while guidance stays pending.
        String runId = createRun("running");
        var submitted = service.submit(runId, userId, workspaceId, "idem-r1", "guidance");
        String activeRunId = createRun("running");
        var active = service.submit(activeRunId, userId, workspaceId, "idem-r2", "still active");
        ChatRun run = runs.findById(submitted.record().getRunId()).orElseThrow();
        run.setStatus("succeeded");
        run.setTerminalAt(Instant.now());
        runs.save(run);

        int expired = service.recoverPendingOnTerminalRuns();

        assertTrue(expired >= 1, "the crash-window row must be expired");
        ChatRunGuidance reloaded = guidance.findById(submitted.record().getId()).orElseThrow();
        assertEquals(ChatRunGuidance.STATUS_TERMINAL_EXPIRED, reloaded.getStatus());
        assertEquals(ChatRunGuidance.STATUS_PENDING, guidance.findById(
                        active.record().getId()).orElseThrow().getStatus(),
                "non-terminal Runs are never swept");
        assertEquals(0, service.recoverPendingOnTerminalRuns(),
                "the sweep is idempotent once converged");
    }

    @Test
    void submitRejectsBlankOversizedAndMissingKey() {
        String runId = createRun("running");
        assertThrows(CpApiException.class,
                () -> service.submit(runId, userId, workspaceId, "idem-b1", " "));
        assertThrows(CpApiException.class,
                () -> service.submit(runId, userId, workspaceId, "idem-b2", "x".repeat(8001)));
        assertThrows(CpApiException.class,
                () -> service.submit(runId, userId, workspaceId, " ", "content"));
    }

    /**
     * PLAN-0543 T1.5: settlement runs inside the Run terminal transaction. If it
     * fails after its own update, the whole terminal transaction must roll back —
     * a committed terminal Run with pending guidance is the forbidden state.
     */
    @Test
    void terminalSettlementFailureRollsBackRunStatusAndGuidanceTogether() {
        String runId = createRun("running");
        var submitted = service.submit(runId, userId, workspaceId, "idem-rollback", "guidance");
        doAnswer(invocation -> {
            invocation.callRealMethod();
            throw new IllegalStateException("forced guidance settlement failure");
        }).when(service).settleTerminal(any(UUID.class));

        assertThrows(IllegalStateException.class, () -> terminalService.terminalize(
                new ChatRunTerminalService.TerminalRequest(runId, List.of("running"), "succeeded",
                        "success", null, null, 0, 0,
                        ChatRunTerminalService.TerminalSource.STREAM, null)));

        assertEquals("running", jdbcTemplate.queryForObject(
                "SELECT status FROM chat_runs WHERE id = ?", String.class, UUID.fromString(runId)));
        Map<String, Object> row = jdbcTemplate.queryForMap(
                "SELECT status, terminal_expired_at FROM chat_run_guidance WHERE id = ?",
                submitted.record().getId());
        assertEquals(ChatRunGuidance.STATUS_PENDING, row.get("status"),
                "the guidance expiry must roll back with the Run terminal status");
        assertNull(row.get("terminal_expired_at"));
    }

    /** PLAN-0543 T1.5: bulk updates bypass @PreUpdate, so both timestamps are written explicitly. */
    @Test
    void bulkTransitionsWriteUpdatedAtAndStageTimestampsExplicitly() {
        String runId = createRun("running");
        var consumed = service.submit(runId, userId, workspaceId, "idem-ts1", "consumed row");
        service.consume(runId, consumed.record().getId().toString());

        Map<String, Object> consumedRow = jdbcTemplate.queryForMap(
                "SELECT status, consumed_at, terminal_expired_at, updated_at, created_at "
                        + "FROM chat_run_guidance WHERE id = ?", consumed.record().getId());
        assertEquals(ChatRunGuidance.STATUS_CONSUMED, consumedRow.get("status"));
        assertNotNull(consumedRow.get("consumed_at"));
        assertNull(consumedRow.get("terminal_expired_at"));
        assertTrue(!instant(consumedRow, "updated_at").isBefore(instant(consumedRow, "created_at")),
                "consume must advance updated_at to the consuming instant");

        var expired = service.submit(runId, userId, workspaceId, "idem-ts2", "expired row");
        assertEquals(1, service.settleTerminal(UUID.fromString(runId)));

        Map<String, Object> expiredRow = jdbcTemplate.queryForMap(
                "SELECT status, consumed_at, terminal_expired_at, updated_at, created_at "
                        + "FROM chat_run_guidance WHERE id = ?", expired.record().getId());
        assertEquals(ChatRunGuidance.STATUS_TERMINAL_EXPIRED, expiredRow.get("status"));
        assertNull(expiredRow.get("consumed_at"));
        assertNotNull(expiredRow.get("terminal_expired_at"));
        assertTrue(!instant(expiredRow, "updated_at").isBefore(instant(expiredRow, "created_at")),
                "settlement must advance updated_at to the expiry instant");
    }

    private static Instant instant(Map<String, Object> row, String column) {
        return ((Timestamp) row.get(column)).toInstant();
    }
}
