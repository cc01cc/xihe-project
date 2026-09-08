package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.entity.WorkspaceRole;
import com.cc01cc.p.xihe.cp.entity.WorkspaceUser;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ChatRunLeaseIntegrationTest extends AbstractIntegrationTest {

    private static final String OWNER_A = "cp-instance-a";
    private static final String OWNER_B = "cp-instance-b";

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private WorkspaceUserRepository workspaceUserRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private ChatApprovalRepository approvalRepository;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    private String userId;
    private String workspaceId;
    private String sessionId;

    @BeforeEach
    void setUp() {
        String email = "lease-int-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "LeaseIntTest");
        ResponseEntity<AuthResponse> regResponse = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        regResponse.getBody().getAccessToken();

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        Workspace ws = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId)).stream().findFirst().orElseThrow();
        workspaceId = ws.getId().toString();
        workspaceUserRepository.save(new WorkspaceUser(workspaceId, userId, WorkspaceRole.OWNER));
        jwtTokenProvider.createAccessToken(userId, email, "USER", workspaceId);

        sessionId = UUID.randomUUID().toString();
        Session session = new Session(workspaceId, userId, "Lease Integration");
        session.setId(UUID.fromString(sessionId));
        sessionRepository.save(session);
    }

    private ChatRun runWithLease(String status, String owner, Instant expiresAt) {
        ChatRun run = new ChatRun(UUID.randomUUID().toString(), sessionId, userId, workspaceId,
                "idem-" + UUID.randomUUID(), "hash", "openai", "gpt-test", "none", status);
        run.setLeaseOwner(owner);
        run.setLeaseExpiresAt(expiresAt);
        return chatRunRepository.save(run);
    }

    private int acquire(String runId, String owner, Instant expiresAt) {
        return chatRunRepository.tryAcquireLease(
                UUID.fromString(runId), owner, expiresAt, Instant.now(),
                ChatRunRepository.ACTIVE_LEASE_STATUSES);
    }

    @Test
    void concurrentAcquireIsMutuallyExclusive() throws Exception {
        ChatRun run = runWithLease("running", null, null);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Callable<Integer> taskA = () -> acquire(run.getId().toString(), OWNER_A, Instant.now().plusSeconds(600));
            Callable<Integer> taskB = () -> acquire(run.getId().toString(), OWNER_B, Instant.now().plusSeconds(600));
            Future<Integer> futureA = pool.submit(taskA);
            Future<Integer> futureB = pool.submit(taskB);
            int affectedA = futureA.get(10, TimeUnit.SECONDS);
            int affectedB = futureB.get(10, TimeUnit.SECONDS);
            assertEquals(1, affectedA + affectedB, "exactly one contender wins the lease");
        } finally {
            pool.shutdownNow();
        }
        ChatRun winner = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals(1, chatRunRepository.releaseLease(run.getId(), winner.getLeaseOwner()));
    }

    @Test
    void releaseLeaseOnlyClearsOwnOwnership() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().plusSeconds(600));

        assertEquals(0, chatRunRepository.releaseLease(run.getId(), OWNER_B));
        ChatRun untouched = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals(OWNER_A, untouched.getLeaseOwner());
        assertNotNull(untouched.getLeaseExpiresAt());

        assertEquals(1, chatRunRepository.releaseLease(run.getId(), OWNER_A));
        ChatRun released = chatRunRepository.findById(run.getId()).orElseThrow();
        assertNull(released.getLeaseOwner());
        assertNull(released.getLeaseExpiresAt());
    }

    @Test
    void expiredLeaseCanBeTakenOver() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().minusSeconds(1));

        assertEquals(1, acquire(run.getId().toString(), OWNER_B, Instant.now().plusSeconds(600)));
        ChatRun takenOver = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals(OWNER_B, takenOver.getLeaseOwner());
        assertTrue(takenOver.getLeaseExpiresAt().isAfter(Instant.now()));
    }

    @Test
    void liveLeaseBlocksForeignTakeover() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().plusSeconds(600));

        assertEquals(0, acquire(run.getId().toString(), OWNER_B, Instant.now().plusSeconds(600)));
        ChatRun unchanged = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals(OWNER_A, unchanged.getLeaseOwner());
    }

    @Test
    void terminalStatusIsNotRecoverable() {
        ChatRun run = runWithLease("succeeded", OWNER_A, Instant.now().plusSeconds(600));

        assertEquals(0, acquire(run.getId().toString(), OWNER_B, Instant.now().plusSeconds(600)));
        assertEquals(0, chatRunRepository.findRecoverableRuns(ChatRunRepository.ACTIVE_LEASE_STATUSES).stream()
                .filter(candidate -> candidate.getId().equals(run.getId()))
                .count());
    }

    @Test
    void reconciliationRestoresAwaitingApprovalForLiveApproval() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().plusSeconds(600));
        ChatApproval approval = new ChatApproval(UUID.randomUUID().toString(), run.getId().toString(),
                sessionId, userId, workspaceId, "request_approval", "delete file", "README.md",
                "pending", Instant.now().plusSeconds(300));
        approvalRepository.save(approval);

        reconciliationService().reconcileOnStartup();

        ChatRun restored = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals("awaiting_approval", restored.getStatus());
        assertNull(restored.getErrorCode());
    }

    @Test
    void reconciliationMarksAmbiguousWithoutLiveApproval() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().plusSeconds(600));

        reconciliationService().reconcileOnStartup();

        ChatRun marked = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals("ambiguous", marked.getStatus());
        assertEquals("ambiguous", marked.getTerminalOutcome());
        assertEquals("CP_RESTARTED", marked.getErrorCode());
    }

    @Test
    void reconciliationIgnoresExpiredApprovalAndMarksAmbiguous() {
        ChatRun run = runWithLease("running", OWNER_A, Instant.now().plusSeconds(600));
        ChatApproval expired = new ChatApproval(UUID.randomUUID().toString(), run.getId().toString(),
                sessionId, userId, workspaceId, "request_approval", "delete file", "README.md",
                "pending", Instant.now().minusSeconds(1));
        approvalRepository.save(expired);

        reconciliationService().reconcileOnStartup();

        ChatRun marked = chatRunRepository.findById(run.getId()).orElseThrow();
        assertEquals("ambiguous", marked.getStatus());
        assertEquals("CP_RESTARTED", marked.getErrorCode());
    }

    private ChatRunRecoveryService reconciliationService() {
        return new ChatRunRecoveryService(chatRunRepository, approvalRepository, chatController);
    }

    @Autowired
    private ChatController chatController;
}
