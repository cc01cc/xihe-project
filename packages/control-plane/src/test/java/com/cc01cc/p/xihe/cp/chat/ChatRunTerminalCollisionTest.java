package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.integration.WorkspaceFixture;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.status.HealthMonitor;
import com.cc01cc.p.xihe.cp.status.RequestQueue;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;

import static org.awaitility.Awaitility.await;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.verify;

/**
 * task-134 T1（对撞·帧级）: the recovery drain and the reconciler may both meet the same parked run.
 * Only one of them may produce a terminal record, and only that one may emit frames.
 *
 * <p>Why a separate class: the frame assertion needs s {@code SseEmitterManager} stand-in, and a
 * {@code @TestConfiguration}/{@code @MockitoBean} override is scoped to <b>this</b> context only, so
 * {@code ChatControllerTest}'s 73 cases keep their own bean and their own preconditions.</p>
 *
 * <p>Both directions are asserted, because an empty recorder proves nothing on its own: the winner
 * case must be seen to produce an {@code error} frame through this very recorder, and only then is
 * the loser's empty recorder evidence.</p>
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ChatRunTerminalCollisionTest extends AbstractIntegrationTest {

    private static final String OTHER_INSTANCE = "cp-other-instance";

    /** Stand-in for the frame sink: records what the controller would push to the client. */
    @MockitoBean
    private SseEmitterManager sseManager;

    /** Lets the test fire the agent's down→up edge deterministically instead of waiting for a poll. */
    @MockitoBean
    private HealthMonitor healthMonitor;

    @Autowired private UserRepository userRepository;
    @Autowired private WorkspaceFixture workspaceFixture;
    @Autowired private SessionRepository sessionRepository;
    @Autowired private ChatRunRepository chatRunRepository;
    @Autowired private ChatRunTerminalService terminalService;
    @Autowired private RequestQueue requestQueue;
    @Autowired private ChatActiveRunRegistry activeRunRegistry;
    @Autowired private JdbcTemplate jdbcTemplate;

    private final List<String> frames = Collections.synchronizedList(new ArrayList<>());
    private Consumer<String> recoveryEdge;
    private String userId;
    private String workspaceId;
    private String sessionId;

    @BeforeAll
    void captureRecoveryEdge() {
        ArgumentCaptor<Consumer<String>> captor = ArgumentCaptor.forClass(Consumer.class);
        verify(healthMonitor, atLeastOnce()).setOnServiceRecovered(captor.capture());
        recoveryEdge = captor.getValue();
    }

    @BeforeEach
    void setUp() {
        String email = "collision-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> registered = restTemplate.postForEntity(baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "CollisionTest"), AuthResponse.class);
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        Workspace workspace = workspaceFixture.ensureOwnedWorkspace(UUID.fromString(userId));
        workspaceId = workspace.getId().toString();
        workspaceFixture.bindWorkspaceRole(workspaceId, userId, WorkspaceRole.OWNER);
        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "Collision Test");
        session.setId(UUID.fromString(sessionId));
        sessionRepository.save(session);

        requestQueue.clear();
        frames.clear();
        doAnswer(invocation -> {
            frames.add(invocation.getArgument(1) + ":" + invocation.getArgument(2));
            return true;
        }).when(sseManager).send(anyString(), anyString(), any(), any());
        doAnswer(invocation -> {
            frames.add(invocation.getArgument(1) + ":" + invocation.getArgument(2));
            return true;
        }).when(sseManager).send(anyString(), anyString(), any());
    }

    @Test
    void theWinnerEmitsTheErrorFrameAndTheLoserEmitsNothing() {
        // ── winner: a parked run that is still deliverable, but whose lease belongs elsewhere
        //    ⇒ the drain refuses it and terminalizes it itself (queued → failed), one frame.
        String winnerRunId = seedRun("queued");
        chatRunRepository.tryAcquireLease(UUID.fromString(winnerRunId), OTHER_INSTANCE,
                Instant.now().plusSeconds(600), Instant.now(), ChatRunRepository.ACTIVE_LEASE_STATUSES);
        park(winnerRunId, Instant.now());
        requestQueue.enqueue(sessionId, "winner", "openai", "gpt-test", "none", List.of(),
                userId, workspaceId, "request-winner", winnerRunId);

        recoveryEdge.accept("agent");

        await().atMost(Duration.ofSeconds(20)).untilAsserted(() ->
                assertTrue(frames.stream().anyMatch(frame -> frame.startsWith("error:"))
                                // the witness: this recorder does see error frames from this path
                                || frames.stream().anyMatch(frame -> frame.startsWith("done:")),
                        "the refused delivery must emit its frames through this recorder: " + frames));
        assertTrue(frames.stream().anyMatch(frame -> frame.contains(winnerRunId)),
                "the emitted frame must name the run: " + frames);
        assertEquals(1, terminalHistoryCount(winnerRunId),
                "the winner writes exactly one terminal record");
    }

    @Test
    void aRunTheReconcilerAlreadyTerminalizedIsNotTerminalizedOrFramedByTheDrain() {
        String runId = seedRun("queued");
        // Reconciliation's own entry point, with the request shape it builds.
        terminalService.terminalize(new ChatRunTerminalService.TerminalRequest(
                runId, List.of("queued"), "ambiguous", "ambiguous", "QUEUE_EXPIRED",
                "The queued chat request expired before the agent recovered", 0, 0,
                ChatRunTerminalService.TerminalSource.RECONCILIATION, null, null));
        park(runId, Instant.now());
        requestQueue.enqueue(sessionId, "loser", "openai", "gpt-test", "none", List.of(),
                userId, workspaceId, "request-loser", runId);
        int framesBefore = frames.size();

        recoveryEdge.accept("agent");

        await().atMost(Duration.ofSeconds(20)).untilAsserted(() ->
                assertEquals(0, requestQueue.size(), "the drain must still consume the stale entry"));
        // The loser may still emit non-terminal chatter (attempting this run's checkpoint reports
        // "degraded"), but it must never emit a terminal frame: error/done are the pair a client
        // reads as "this run ended now".
        List<String> added = List.copyOf(frames.subList(framesBefore, frames.size()));
        assertEquals(List.of(), added.stream()
                        .filter(frame -> frame.startsWith("error:") || frame.startsWith("done:")).toList(),
                "the loser must not emit a terminal frame: " + added);
        assertEquals(1, terminalHistoryCount(runId), "the run keeps exactly one terminal record");
        assertEquals("QUEUE_EXPIRED", jdbcTemplate.queryForObject(
                "SELECT error_code FROM chat_runs WHERE id = CAST(? AS UUID)", String.class, runId),
                "the first writer's code must survive");
    }

    private String seedRun(String status) {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), sessionId, userId, workspaceId,
                "idem-" + UUID.randomUUID(), "hash", "openai", "gpt-test", "none", status);
        return chatRunRepository.save(run).getId().toString();
    }

    private void park(String runId, Instant at) {
        activeRunRegistry.claim(sessionId, runId);
        activeRunRegistry.markHandedOff(sessionId, runId, at);
    }

    private int terminalHistoryCount(String runId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM chat_run_history WHERE run_id = CAST(? AS UUID)",
                Integer.class, runId);
    }
}
