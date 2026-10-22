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
import org.awaitility.Awaitility;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0543 T1.4: consume and terminal settlement are two conditional updates
 * over the same row, so PostgreSQL decides the winner. The tests are
 * direction-ordered, never random stress: each interleaving is produced by a
 * lock holder with a known application_name, observed through
 * {@code pg_stat_activity} before the holder commits.
 */
class ChatRunGuidanceConcurrencyIntegrationTest extends AbstractIntegrationTest {

    /**
     * The blocked consume must outlive the await window below if the machine is
     * slow; 15s is still bounded, so a genuine deadlock fails the test instead
     * of hanging.
     */
    @DynamicPropertySource
    static void lockBudget(DynamicPropertyRegistry registry) {
        registry.add("cp.lock-timeout-ms", () -> 15_000);
    }

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

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PlatformTransactionManager transactionManager;

    private String userId;
    private String workspaceId;
    private String sessionId;

    @BeforeEach
    void setUp() {
        String email = "guidance-concurrency-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> registration = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "Guidance Concurrency"),
                AuthResponse.class);
        assertTrue(registration.getStatusCode().is2xxSuccessful());
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow().getId().toString();
        Session session = new Session(workspaceId, userId, "Guidance Concurrency Session");
        session.setId(UUID.randomUUID());
        sessionId = sessions.save(session).getId().toString();
    }

    /** Direction 1: consume commits first; settlement must find nothing to expire. */
    @Test
    void consumeFirstWinsAndLaterSettlementLeavesConsumedRowUntouched() {
        Fixture fixture = fixture("running");

        ChatRunGuidanceService.ConsumeResult first =
                service.consume(fixture.runId(), fixture.guidanceId());

        assertTrue(first.firstConsumption());
        assertEquals(ChatRunGuidance.STATUS_CONSUMED, first.record().getStatus());
        assertEquals(0, service.settleTerminal(UUID.fromString(fixture.runId())),
                "settlement must not overwrite a consumed row");

        ChatRunGuidance reloaded = guidance.findById(UUID.fromString(fixture.guidanceId())).orElseThrow();
        assertEquals(ChatRunGuidance.STATUS_CONSUMED, reloaded.getStatus());
        assertNull(reloaded.getTerminalExpiredAt());
        assertFalse(service.consume(fixture.runId(), fixture.guidanceId()).firstConsumption(),
                "re-consume stays idempotent after settlement");
        assertEquals(ChatRunGuidance.STATUS_CONSUMED, service.consume(
                fixture.runId(), fixture.guidanceId()).record().getStatus());
    }

    /** Direction 2: settlement commits first; consume is an explicit 409, never a 500. */
    @Test
    void settlementFirstWinsAndConsumeReturns409BothTimes() {
        Fixture fixture = fixture("running");

        assertEquals(1, service.settleTerminal(UUID.fromString(fixture.runId())));
        ChatRunGuidance settled = guidance.findById(UUID.fromString(fixture.guidanceId())).orElseThrow();
        assertEquals(ChatRunGuidance.STATUS_TERMINAL_EXPIRED, settled.getStatus());
        assertNull(settled.getConsumedAt());

        for (int attempt = 0; attempt < 2; attempt++) {
            CpApiException conflict = assertThrows(CpApiException.class,
                    () -> service.consume(fixture.runId(), fixture.guidanceId()));
            assertEquals(HttpStatus.CONFLICT, conflict.getStatus());
            assertEquals(ChatRunGuidanceService.ERROR_ALREADY_TERMINAL_EXPIRED, conflict.getCode());
        }
        assertEquals(0, service.settleTerminal(UUID.fromString(fixture.runId())),
                "settlement is idempotent once every row is terminal");
    }

    /**
     * Settlement holds the row lock, consume is provably blocked on it, then
     * settlement commits terminal_expired. PostgreSQL re-evaluates the blocked
     * conditional update against the new row version: affected=0 → 409.
     */
    @Test
    void consumeBlockedBehindSettlementLockConvergesToConflict() throws Exception {
        Fixture fixture = fixture("running");
        CountDownLatch holderLocked = new CountDownLatch(1);
        CountDownLatch releaseHolder = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        TransactionTemplate transactions = new TransactionTemplate(transactionManager);
        Future<?> holder = null;
        Future<Object> consumption = null;

        try {
            holder = executor.submit(() -> transactions.execute(status -> {
                lockGuidanceRow(fixture.guidanceId(), "p543-settlement-holder");
                holderLocked.countDown();
                awaitLatch(releaseHolder, "settlement holder release");
                jdbcTemplate.update("UPDATE chat_run_guidance SET status = 'terminal_expired', "
                                + "terminal_expired_at = now(), updated_at = now() WHERE id = ?",
                        UUID.fromString(fixture.guidanceId()));
                return null;
            }));
            assertTrue(holderLocked.await(5, TimeUnit.SECONDS),
                    "settlement holder must own the guidance row first");

            consumption = executor.submit(() -> consumeTraced(transactions, "p543-consume-waiter", fixture));
            awaitPostgresLockWait("p543-consume-waiter");
            releaseHolder.countDown();

            holder.get(15, TimeUnit.SECONDS);
            Object outcome = consumption.get(15, TimeUnit.SECONDS);
            assertTrue(outcome instanceof CpApiException,
                    "the blocked consume must reject, not return a stale consumed row: " + outcome);
            CpApiException conflict = (CpApiException) outcome;
            assertEquals(HttpStatus.CONFLICT, conflict.getStatus());
            assertEquals(ChatRunGuidanceService.ERROR_ALREADY_TERMINAL_EXPIRED, conflict.getCode());
        } finally {
            releaseHolder.countDown();
            executor.shutdownNow();
            awaitQuietly(holder);
            awaitQuietly(consumption);
        }

        Map<String, Object> row = jdbcTemplate.queryForMap(
                "SELECT status, consumed_at, terminal_expired_at FROM chat_run_guidance WHERE id = ?",
                UUID.fromString(fixture.guidanceId()));
        assertEquals(ChatRunGuidance.STATUS_TERMINAL_EXPIRED, row.get("status"));
        assertNull(row.get("consumed_at"), "the losing consume must not write consumed_at");
    }

    /** Two consumes blocked on the same row: exactly one firstConsumption=true. */
    @Test
    void twoBlockedConsumersYieldExactlyOneFirstConsumption() throws Exception {
        Fixture fixture = fixture("running");
        CountDownLatch holderLocked = new CountDownLatch(1);
        CountDownLatch releaseHolder = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(3);
        TransactionTemplate transactions = new TransactionTemplate(transactionManager);
        Future<?> holder = null;
        Future<Object> first = null;
        Future<Object> second = null;

        try {
            holder = executor.submit(() -> transactions.execute(status -> {
                lockGuidanceRow(fixture.guidanceId(), "p543-consume-holder");
                holderLocked.countDown();
                awaitLatch(releaseHolder, "holder release");
                return null;
            }));
            assertTrue(holderLocked.await(5, TimeUnit.SECONDS));

            first = executor.submit(() -> consumeTraced(transactions, "p543-consume-a", fixture));
            awaitPostgresLockWait("p543-consume-a");
            second = executor.submit(() -> consumeTraced(transactions, "p543-consume-b", fixture));
            awaitPostgresLockWait("p543-consume-b");
            releaseHolder.countDown();

            holder.get(15, TimeUnit.SECONDS);
            Object a = first.get(20, TimeUnit.SECONDS);
            Object b = second.get(20, TimeUnit.SECONDS);
            List<Object> outcomes = List.of(a, b);
            long winners = outcomes.stream()
                    .filter(ChatRunGuidanceService.ConsumeResult.class::isInstance)
                    .map(ChatRunGuidanceService.ConsumeResult.class::cast)
                    .filter(ChatRunGuidanceService.ConsumeResult::firstConsumption)
                    .count();
            assertEquals(1, winners, "exactly one consumer may claim firstConsumption: " + outcomes);
            assertTrue(outcomes.stream()
                            .filter(ChatRunGuidanceService.ConsumeResult.class::isInstance)
                            .map(ChatRunGuidanceService.ConsumeResult.class::cast)
                            .allMatch(result -> ChatRunGuidance.STATUS_CONSUMED.equals(result.record().getStatus())),
                    "both consumers observe the committed consumed state: " + outcomes);
        } finally {
            releaseHolder.countDown();
            executor.shutdownNow();
            awaitQuietly(holder);
            awaitQuietly(first);
            awaitQuietly(second);
        }

        assertEquals(ChatRunGuidance.STATUS_CONSUMED, guidance.findById(
                UUID.fromString(fixture.guidanceId())).orElseThrow().getStatus());
    }

    // ── fixtures ────────────────────────────────────────────────────────────

    private record Fixture(String runId, String guidanceId) {
    }

    private Fixture fixture(String runStatus) {
        String runId = UUID.randomUUID().toString();
        runs.save(new ChatRun(runId, sessionId, userId, workspaceId,
                "guidance-concurrency-" + UUID.randomUUID(), "hash", "provider", "model",
                "workspace", runStatus));
        ChatRunGuidanceService.SubmitResult submitted =
                service.submit(runId, userId, workspaceId, "idem-" + UUID.randomUUID(), "guidance");
        return new Fixture(runId, submitted.record().getId().toString());
    }

    /**
     * The service's @Transactional boundary joins this template's transaction and
     * marks it rollback-only on a conflict, so the template rethrows the domain
     * error after rolling back — catch it outside the template.
     */
    private Object consumeTraced(TransactionTemplate transactions, String applicationName, Fixture fixture) {
        try {
            return transactions.execute(status -> {
                jdbcTemplate.execute("SET LOCAL application_name = '" + applicationName + "'");
                return service.consume(fixture.runId(), fixture.guidanceId());
            });
        } catch (CpApiException error) {
            return error;
        }
    }

    private void lockGuidanceRow(String guidanceId, String applicationName) {
        jdbcTemplate.execute("SET LOCAL application_name = '" + applicationName + "'");
        jdbcTemplate.query("SELECT id FROM chat_run_guidance WHERE id = ? FOR UPDATE",
                resultSet -> null, UUID.fromString(guidanceId));
    }

    private void awaitPostgresLockWait(String applicationName) {
        Awaitility.await().atMost(Duration.ofSeconds(5)).pollInterval(Duration.ofMillis(25))
                .untilAsserted(() -> assertEquals(1, jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM pg_stat_activity "
                                + "WHERE application_name = ? AND state = 'active' "
                                + "AND wait_event_type = 'Lock'",
                        Integer.class, applicationName)));
    }

    private static void awaitLatch(CountDownLatch latch, String description) {
        try {
            if (!latch.await(10, TimeUnit.SECONDS)) {
                throw new IllegalStateException("Timed out waiting for " + description);
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while waiting for " + description, error);
        }
    }

    private static void awaitQuietly(Future<?> future) {
        if (future == null) {
            return;
        }
        try {
            future.get(10, TimeUnit.SECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        } catch (ExecutionException | java.util.concurrent.TimeoutException ignored) {
            // The assertion already ran; cleanup must not mask it.
        }
    }
}
