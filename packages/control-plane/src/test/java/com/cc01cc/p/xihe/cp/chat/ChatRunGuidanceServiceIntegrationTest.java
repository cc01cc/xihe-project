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

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0528 M4: real CP+PostgreSQL integration for Guidance idempotency,
 * active-state gating, terminal settlement and consume semantics (frozen:
 * spec/cp-guidance-contract.md). No mock store.
 */
class ChatRunGuidanceServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private ChatRunGuidanceService service;

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
        ChatRun run = runs.findById(submitted.record().getRunId()).orElseThrow();
        run.setStatus("succeeded");
        run.setTerminalAt(Instant.now());
        runs.save(run);

        int expired = service.recoverPendingOnTerminalRuns();

        assertEquals(1, expired);
        ChatRunGuidance reloaded = guidance.findById(submitted.record().getId()).orElseThrow();
        assertEquals(ChatRunGuidance.STATUS_TERMINAL_EXPIRED, reloaded.getStatus());
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
}
