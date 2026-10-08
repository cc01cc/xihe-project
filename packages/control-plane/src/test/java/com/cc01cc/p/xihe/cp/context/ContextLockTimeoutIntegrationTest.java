package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.UUID;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Context writes fail quickly under a held Session row lock and recover after
 * the lock is released. Real PostgreSQL only — H2 cannot express this.
 */
class ContextLockTimeoutIntegrationTest extends AbstractIntegrationTest {

    @DynamicPropertySource
    static void lockTimeout(DynamicPropertyRegistry registry) {
        registry.add("cp.lock-timeout-ms", () -> "800");
    }

    @Autowired
    private EventStoreService eventStoreService;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String userId;
    private String workspaceId;
    private String sessionId;

    @BeforeEach
    void setUp() {
        String email = "context-lock-" + UUID.randomUUID() + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "Context lock test");
        var response = restTemplate.postForEntity(baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        assertTrue(response.getStatusCode().is2xxSuccessful());
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow().getId().toString();
        Session session = new Session(workspaceId, userId, "Lock Timeout Session");
        session.setId(UUID.randomUUID());
        sessionId = sessionRepository.save(session).getId().toString();
    }

    @Test
    void contextAppendFailsFastOnLockedSessionRow() throws Exception {
        long start = System.nanoTime();
        try (LockHolder ignored = holdLock(() -> sessionRepository.findByIdForUpdate(UUID.fromString(sessionId)))) {
            assertThrows(CannotAcquireLockException.class, () -> eventStoreService.append(
                    sessionId, workspaceId, userId, "prompt.admitted", Map.of("probe", true)));
            long elapsedMs = (System.nanoTime() - start) / 1_000_000;
            assertTrue(elapsedMs >= 500, "lock timeout must be applied (elapsed=" + elapsedMs + "ms)");
            assertTrue(elapsedMs < 5_000, "wait must be bounded (elapsed=" + elapsedMs + "ms)");
        }
        var event = eventStoreService.append(sessionId, workspaceId, userId,
                "prompt.admitted", Map.of("probe", true));
        assertNotNull(event.getId());
    }

    /** Holds an acquired row lock in its own transaction until closed. */
    private LockHolder holdLock(Runnable acquire) throws InterruptedException {
        return new LockHolder(transactionManager, acquire);
    }

    private static final class LockHolder implements AutoCloseable {
        private final ExecutorService executor = Executors.newSingleThreadExecutor();
        private final CountDownLatch held = new CountDownLatch(1);
        private final CountDownLatch release = new CountDownLatch(1);
        private final Future<?> future;

        private LockHolder(PlatformTransactionManager transactionManager, Runnable acquire)
                throws InterruptedException {
            this.future = executor.submit(() -> new TransactionTemplate(transactionManager).execute(status -> {
                acquire.run();
                held.countDown();
                try {
                    release.await(30, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return null;
            }));
            if (!held.await(10, TimeUnit.SECONDS)) {
                throw new IllegalStateException("lock holder did not acquire the row lock in time");
            }
        }

        @Override
        public void close() {
            release.countDown();
            try {
                future.get(30, TimeUnit.SECONDS);
            } catch (Exception e) {
                throw new IllegalStateException("lock holder failed to release", e);
            } finally {
                executor.shutdown();
            }
        }
    }
}
