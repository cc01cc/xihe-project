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
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * PLAN-0346 (gap E): context_events sequence allocation runs under the session
 * row lock. These tests use the real PostgreSQL container (not H2) because the
 * behaviour under test is exactly the row-lock/unique-index interaction.
 */
class EventStoreServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private EventStoreService eventStoreService;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String userId;
    private String workspaceId;
    private String sessionId;

    @BeforeEach
    void setUp() {
        String email = "evt-int-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        RegisterRequest register = new RegisterRequest(email, TestDataFactory.PASSWORD, "EventStoreIntTest");
        ResponseEntity<AuthResponse> regResponse = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register", register, AuthResponse.class);
        org.junit.jupiter.api.Assertions.assertTrue(regResponse.getStatusCode().is2xxSuccessful(),
                "registration must succeed, got " + regResponse.getStatusCode());

        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(UUID.fromString(userId))
                .stream().findFirst().orElseThrow().getId().toString();

        Session session = new Session(workspaceId, userId, "Event Store Session");
        session.setId(UUID.randomUUID());
        sessionId = sessionRepository.save(session).getId().toString();
    }

    @Test
    void concurrentAppendsToSameSessionAllocateDistinctSequences() throws Exception {
        // Four writers race append() on one session; the session row lock
        // serialises sequence allocation, so every event lands with a distinct
        // sequence (previously an INSERT could die on
        // uq_context_events_session_sequence and the event was lost).
        int writers = 4;
        var executor = Executors.newFixedThreadPool(writers);
        var latch = new CountDownLatch(1);
        List<Future<?>> futures = new ArrayList<>();
        for (int i = 0; i < writers; i++) {
            int writer = i;
            futures.add(executor.submit(() -> {
                latch.await();
                eventStoreService.append(sessionId, workspaceId, userId, "prompt.admitted",
                        Map.of("writer", writer));
                return null;
            }));
        }
        latch.countDown();
        for (Future<?> future : futures) {
            future.get(30, TimeUnit.SECONDS); // a lost race would surface here
        }
        executor.shutdown();

        Integer rows = jdbcTemplate.queryForObject(
                "select count(*) from context_events where session_id = ?::uuid",
                Integer.class, sessionId);
        assertEquals(writers, rows, "every concurrent append must persist");

        List<Long> sequences = jdbcTemplate.queryForList(
                "select sequence from context_events where session_id = ?::uuid order by sequence",
                Long.class, sessionId);
        assertEquals(List.of(1L, 2L, 3L, 4L), sequences, "sequences must be contiguous and unique");
    }
}
