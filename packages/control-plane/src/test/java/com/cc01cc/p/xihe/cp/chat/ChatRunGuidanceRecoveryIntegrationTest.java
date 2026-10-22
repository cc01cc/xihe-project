package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
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
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

import java.time.Instant;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * PLAN-0543 T2.2: the startup sweep is one bounded bulk update over terminal
 * Runs. It must not regress to the old "load every terminal run id, then IN"
 * shape, and must leave rows on non-terminal Runs pending.
 */
class ChatRunGuidanceRecoveryIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private ChatRunGuidanceService service;

    @MockitoSpyBean
    private ChatRunGuidanceRepository guidance;

    @MockitoSpyBean
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
        String email = "guidance-recovery-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> registration = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "Guidance Recovery"),
                AuthResponse.class);
        assertTrue(registration.getStatusCode().is2xxSuccessful());
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow().getId().toString();
        Session session = new Session(workspaceId, userId, "Guidance Recovery Session");
        session.setId(UUID.randomUUID());
        sessionId = sessions.save(session).getId().toString();
    }

    @Test
    void sweepExpiresOnlyPendingRowsOnTerminalRunsWithOneBulkUpdate() {
        Fixture terminal = fixture();
        markTerminal(terminal);
        Fixture active = fixture();
        Fixture consumed = fixture();
        service.consume(consumed.runId(), consumed.guidanceId());
        markTerminal(consumed);

        int expired = service.recoverPendingOnTerminalRuns();

        assertTrue(expired >= 1, "the sweep must report the rows it expired");
        assertEquals(ChatRunGuidance.STATUS_TERMINAL_EXPIRED,
                reload(terminal.guidanceId()).getStatus(),
                "pending guidance on a terminal Run converges to terminal_expired");
        assertEquals(ChatRunGuidance.STATUS_PENDING,
                reload(active.guidanceId()).getStatus(),
                "guidance on a non-terminal Run must stay pending");
        ChatRunGuidance alreadyConsumed = reload(consumed.guidanceId());
        assertEquals(ChatRunGuidance.STATUS_CONSUMED, alreadyConsumed.getStatus(),
                "terminal states stay mutually exclusive and irreversible");
        assertNull(alreadyConsumed.getTerminalExpiredAt());

        assertEquals(0, service.recoverPendingOnTerminalRuns(),
                "a second sweep has nothing left to expire");

        verify(runs, never()).findIdsByStatusIn(any());
        verify(guidance, never()).findByRunIdInAndStatus(any(), anyString());
    }

    private record Fixture(String runId, String guidanceId) {
    }

    private Fixture fixture() {
        String runId = UUID.randomUUID().toString();
        runs.save(new ChatRun(runId, sessionId, userId, workspaceId,
                "guidance-recovery-" + UUID.randomUUID(), "hash", "provider", "model",
                "workspace", "running"));
        ChatRunGuidanceService.SubmitResult submitted = service.submit(
                runId, userId, workspaceId, "idem-" + UUID.randomUUID(), "guidance");
        return new Fixture(runId, submitted.record().getId().toString());
    }

    private void markTerminal(Fixture fixture) {
        ChatRun run = runs.findById(UUID.fromString(fixture.runId())).orElseThrow();
        run.setStatus("succeeded");
        run.setTerminalAt(Instant.now());
        runs.save(run);
    }

    private ChatRunGuidance reload(String guidanceId) {
        return guidance.findById(UUID.fromString(guidanceId)).orElseThrow();
    }
}
