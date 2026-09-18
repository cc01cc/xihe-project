package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.LedgerOperationRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.RestTemplate;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0346 T1.8 drill: with a held row lock and a small
 * {@code cp.lock-timeout-ms}, every write path must fail explicitly and in a
 * bounded time (PostgreSQL 55P03 → {@code CannotAcquireLockException} → 503
 * {@code OPERATION_LOCK_TIMEOUT}), leave no partial rows, and recover once the
 * lock is released. Real PostgreSQL only — H2 cannot express this.
 */
class LedgerLockTimeoutIntegrationTest extends AbstractIntegrationTest {

    @DynamicPropertySource
    static void lockTimeout(DynamicPropertyRegistry registry) {
        registry.add("cp.lock-timeout-ms", () -> "800");
    }

    @Autowired
    private OperationService operationService;

    @Autowired
    private EventStoreService eventStoreService;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private LedgerOperationRepository ledgerOperationRepository;

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
        String email = "lock-int-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "LedgerLockTimeoutTest");
        ResponseEntity<AuthResponse> regResponse = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        assertTrue(regResponse.getStatusCode().is2xxSuccessful(), "registration must succeed");

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow().getId().toString();
        Session session = new Session(workspaceId, userId, "Lock Timeout Session");
        session.setId(UUID.randomUUID());
        sessionId = sessionRepository.save(session).getId().toString();
    }

    private UUID startOperation() {
        return operationService.startOperation(userId, sessionId, workspaceId, null, null,
                "chat", "ui", "user", userId,
                "lock-key-" + UUID.randomUUID().toString().substring(0, 8), "Lock timeout drill")
                .operationId();
    }

    private int countItems(UUID operationId) {
        Integer rows = jdbcTemplate.queryForObject(
                "select count(*) from operation_items where operation_id = ?::uuid",
                Integer.class, operationId.toString());
        return rows == null ? 0 : rows;
    }

    @Test
    void appendItemFailsFastOnLockedOperationRowAndRecovers() throws Exception {
        UUID operationId = startOperation();
        long start = System.nanoTime();
        try (LockHolder ignored = holdLock(() -> ledgerOperationRepository.findByIdForUpdate(operationId))) {
            assertThrows(CannotAcquireLockException.class, () -> operationService.appendItem(
                    operationId, UUID.randomUUID().toString(), null,
                    "tool_call", "probe", "agent", null, null, null));
            long elapsedMs = (System.nanoTime() - start) / 1_000_000;
            assertTrue(elapsedMs >= 500, "lock timeout must be applied (elapsed=" + elapsedMs + "ms)");
            assertTrue(elapsedMs < 5_000, "wait must be bounded (elapsed=" + elapsedMs + "ms)");
            assertEquals(0, countItems(operationId), "timed-out write must not leave a row");
        }

        // Pool recovers and transaction-scoped SET LOCAL does not leak: the very
        // next write succeeds.
        var item = operationService.appendItem(operationId, UUID.randomUUID().toString(), null,
                "tool_call", "probe", "agent", null, null, null);
        assertNotNull(item.getId());
        assertEquals(1, countItems(operationId));
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

    @Test
    void lateTerminationHttpSurfacesExplicit503LockTimeout() throws Exception {
        UUID operationId = startOperation();
        var item = operationService.appendItem(operationId, UUID.randomUUID().toString(), null,
                "tool_call", "probe", "agent", null, null, null);
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth("dev-token-not-secure");
        try (LockHolder ignored = holdLock(() -> ledgerOperationRepository.findByIdForUpdate(operationId))) {
            long start = System.nanoTime();
            HttpServerErrorException error = assertThrows(HttpServerErrorException.class, () ->
                    restTemplate.exchange(
                            baseUrl + "/internal/v1/operations/items/" + item.getId() + "/late-termination",
                            HttpMethod.POST, new HttpEntity<>(Map.of("confirmed", true), headers), Map.class));
            long elapsedMs = (System.nanoTime() - start) / 1_000_000;
            assertEquals(HttpStatus.SERVICE_UNAVAILABLE, error.getStatusCode());
            String body = error.getResponseBodyAsString();
            assertTrue(body.contains("OPERATION_LOCK_TIMEOUT"), "problem code must be explicit: " + body);
            assertTrue(elapsedMs < 5_000, "HTTP path must fail boundedly (elapsed=" + elapsedMs + "ms)");
        }

        // After the lock is released the same request succeeds (retry is safe).
        ResponseEntity<Map> ok = new RestTemplate().exchange(
                baseUrl + "/internal/v1/operations/items/" + item.getId() + "/late-termination",
                HttpMethod.POST, new HttpEntity<>(Map.of("confirmed", true), headers), Map.class);
        assertEquals(HttpStatus.OK, ok.getStatusCode());
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
