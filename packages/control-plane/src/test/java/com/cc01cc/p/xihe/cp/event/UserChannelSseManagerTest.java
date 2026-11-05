package com.cc01cc.p.xihe.cp.event;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.UncategorizedSQLException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0660 T5.4 / T5.5 — the user-channel contract (`spec/session/user-channel.md` §4/§5).
 *
 * <p>Three things a naive SSE manager gets wrong are pinned here: keeping <b>every</b> tab of one user
 * (no single-connection replacement — unlike Chat SSE), never leaking one user's hint into another
 * user's connection, and refusing the 9th connection <b>explicitly</b> rather than dropping it
 * silently. Plus the hint whitelist: payload keys are asserted as a <b>subset</b> of the frozen keys,
 * so a future "just add the count/body to the hint" change fails here instead of leaking onto the wire.</p>
 */
class UserChannelSseManagerTest {

    private static final String USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    private static final Set<String> NOTIFIED_HINT_KEYS = Set.of("sessionId", "participantId");
    private static final Set<String> QUESTION_HINT_KEYS = Set.of("questionId", "sessionId", "state");

    private JdbcTemplate jdbc;
    private UserChannelSseManager manager;

    @BeforeEach
    void createDatabase() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:userchannel_" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1");
        jdbc = new JdbcTemplate(dataSource);
        jdbc.execute("CREATE TABLE users (id UUID PRIMARY KEY, token_version INT NOT NULL, "
                + "session_version INT NOT NULL, status VARCHAR(16) NOT NULL, deleted_at TIMESTAMP)");
        jdbc.update("INSERT INTO users VALUES (?, 0, 0, 'ACTIVE', NULL)", UUID.fromString(USER_A));
        jdbc.update("INSERT INTO users VALUES (?, 0, 0, 'ACTIVE', NULL)", UUID.fromString(USER_B));
        manager = new UserChannelSseManager(jdbc);
    }

    @AfterEach
    void stopManager() {
        manager.stopHeartbeat();
    }

    /** Counts frames per emitter and remembers the payload key sets it was handed. */
    private static final class CountingEmitter extends SseEmitter {
        private final AtomicInteger frames = new AtomicInteger();
        private final List<Map<?, ?>> payloads = new ArrayList<>();

        CountingEmitter() {
            super(0L);
        }

        @Override
        public void send(SseEventBuilder builder) throws IOException {
            frames.incrementAndGet();
            builder.build().forEach(data -> {
                if (data.getData() instanceof Map<?, ?> map) {
                    payloads.add(map);
                }
            });
        }

        int frames() {
            return frames.get();
        }

        List<Map<?, ?>> payloads() {
            return payloads;
        }
    }

    @Test
    void everyTabOfTheSameUserReceivesTheHint() {
        CountingEmitter first = new CountingEmitter();
        CountingEmitter second = new CountingEmitter();
        manager.registerForTest(USER_A, 0, first);
        manager.registerForTest(USER_A, 0, second);
        assertEquals(1, first.frames(), "each connection gets the connected frame on open");
        assertEquals(1, second.frames());

        manager.participantNotified(USER_A, "session-1", "participant-1");

        assertEquals(2, manager.connectionCount(USER_A), "multi-tab: connections are NOT replaced");
        assertEquals(2, first.frames(), "the first tab must still receive the hint");
        assertEquals(2, second.frames(), "the second tab receives it too — both-must-receive is frozen");
    }

    @Test
    void aHintNeverLeaksToAnotherUser() {
        CountingEmitter mine = new CountingEmitter();
        CountingEmitter other = new CountingEmitter();
        manager.registerForTest(USER_A, 0, mine);
        manager.registerForTest(USER_B, 0, other);

        manager.participantNotified(USER_A, "session-1", "participant-1");

        assertEquals(2, mine.frames(), "the addressee receives the hint");
        assertEquals(1, other.frames(), "another user's connection sees only its own connected frame");
    }

    @Test
    void theNinthConnectionIsRefusedExplicitly() {
        for (int index = 0; index < UserChannelSseManager.MAX_SUBSCRIBERS_PER_USER; index++) {
            manager.registerForTest(USER_A, 0, new CountingEmitter());
        }

        CpApiException refusal = assertThrows(CpApiException.class,
                () -> manager.registerForTest(USER_A, 0, new CountingEmitter()));

        assertEquals("USER_CHANNEL_FULL", refusal.getCode(), "the cap is an explicit problem code");
        assertEquals(429, refusal.getStatus().value(), "and an explicit status, never a silent drop");
        assertEquals(UserChannelSseManager.MAX_SUBSCRIBERS_PER_USER, manager.connectionCount(USER_A));
    }

    @Test
    void theEventNamesAreTheClosedPublicSet() {
        assertEquals("connected", UserChannelSseManager.EVENT_CONNECTED);
        assertEquals("participant_notified", UserChannelSseManager.EVENT_PARTICIPANT_NOTIFIED);
        assertEquals("user_question", UserChannelSseManager.EVENT_USER_QUESTION);
        for (String name : new String[] {UserChannelSseManager.EVENT_CONNECTED,
                UserChannelSseManager.EVENT_PARTICIPANT_NOTIFIED,
                UserChannelSseManager.EVENT_USER_QUESTION}) {
            assertTrue(!name.startsWith("wake_"),
                    "public wire names are intentionally NOT the internal wake_* names (D-102)");
        }
    }

    @Test
    void theNotifiedHintCarriesOnlyTheTwoFrozenKeys() {
        CountingEmitter tab = new CountingEmitter();
        manager.registerForTest(USER_A, 0, tab);

        manager.participantNotified(USER_A, "session-1", "participant-1");

        Map<?, ?> hint = tab.payloads().stream()
                .filter(payload -> payload.containsKey("participantId"))
                .findFirst()
                .orElseThrow(() -> new AssertionError("the participant_notified hint was not pushed"));
        assertTrue(NOTIFIED_HINT_KEYS.containsAll(hint.keySet()),
                "hint keys must be a SUBSET of {sessionId, participantId}; got " + hint.keySet());
        assertEquals(NOTIFIED_HINT_KEYS, hint.keySet(), "and carry both identifiers, nothing else");
    }

    @Test
    void theQuestionHintCarriesOnlyTheThreeFrozenKeys() {
        CountingEmitter tab = new CountingEmitter();
        manager.registerForTest(USER_A, 0, tab);

        manager.questionChanged(USER_A, "question-1", "session-1", "pending");

        Map<?, ?> hint = tab.payloads().stream()
                .filter(payload -> payload.containsKey("questionId"))
                .findFirst()
                .orElseThrow(() -> new AssertionError("the user_question hint was not pushed"));
        assertTrue(QUESTION_HINT_KEYS.containsAll(hint.keySet()),
                "hint keys must be a SUBSET of {questionId, sessionId, state}; got " + hint.keySet());
        assertEquals(QUESTION_HINT_KEYS, hint.keySet());
    }

    // ------------------------------------------------------------------
    // PLAN-0660 T5.4 security gaps (D-174): revocation / version churn /
    // concurrency must close the existing connection at the NEXT send, and
    // the per-user cap must be atomic under concurrent registration.
    // ------------------------------------------------------------------

    @Test
    void aDisabledUserIsClosedAndNotDeliveredOnTheNextSend() {
        CountingEmitter tab = new CountingEmitter();
        manager.registerForTest(USER_A, 0, tab);
        assertEquals(1, tab.frames(), "only the connected frame has been delivered so far");

        jdbc.update("UPDATE users SET status = 'DISABLED' WHERE id = ?", UUID.fromString(USER_A));
        manager.participantNotified(USER_A, "session-1", "participant-1");

        assertEquals(1, tab.frames(),
                "the disabled user's existing connection gets nothing after the row changed");
        assertEquals(0, manager.connectionCount(USER_A),
                "the connection was closed at the next send, not left dangling");
    }

    @Test
    void aSoftDeletedUserIsClosedAndNotDeliveredOnTheNextSend() {
        CountingEmitter tab = new CountingEmitter();
        manager.registerForTest(USER_A, 0, tab);

        jdbc.update("UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?", UUID.fromString(USER_A));
        manager.questionChanged(USER_A, "question-1", "session-1", "pending");

        assertEquals(1, tab.frames(), "only the connected frame ever reached the deleted user");
        assertEquals(0, manager.connectionCount(USER_A), "the connection is gone");
    }

    @Test
    void aTokenVersionBumpClosesTheExistingConnectionOnTheNextSend() {
        CountingEmitter tab = new CountingEmitter();
        manager.registerForTest(USER_A, 0, tab);

        jdbc.update("UPDATE users SET token_version = 1 WHERE id = ?", UUID.fromString(USER_A));
        manager.participantNotified(USER_A, "session-1", "participant-1");

        assertEquals(1, tab.frames(), "tv mismatch closes the connection before delivering");
        assertEquals(0, manager.connectionCount(USER_A), "and the subscriber is removed");
    }

    @Test
    void aSessionVersionBumpClosesTheExistingConnectionOnTheNextSend() {
        CountingEmitter tab = new CountingEmitter();
        manager.registerForTest(USER_A, 0, tab);

        jdbc.update("UPDATE users SET session_version = 1 WHERE id = ?", UUID.fromString(USER_A));
        manager.participantNotified(USER_A, "session-1", "participant-1");

        assertEquals(1, tab.frames(), "session_version mismatch closes the connection before delivering");
        assertEquals(0, manager.connectionCount(USER_A), "and the subscriber is removed");
    }

    @Test
    void theHeartbeatAlsoChecksRevocation() {
        CountingEmitter tab = new CountingEmitter();
        manager.registerForTest(USER_A, 0, tab);

        jdbc.update("UPDATE users SET status = 'DISABLED' WHERE id = ?", UUID.fromString(USER_A));
        manager.sendHeartbeats();

        assertEquals(1, tab.frames(), "the heartbeat is the send that finds the revocation");
        assertEquals(0, manager.connectionCount(USER_A), "no leaked half-dead subscriber");
    }

    @Test
    void registrationRejectsATokenVersionThatTheDatabaseDisagreesWith() {
        CountingEmitter emitter = new CountingEmitter();
        CpApiException refusal = assertThrows(CpApiException.class,
                () -> manager.registerForTest(USER_A, 1, emitter));
        assertEquals("UNAUTHENTICATED", refusal.getCode(),
                "a token whose tv no longer matches users.token_version must not open a channel");
        assertEquals(0, manager.connectionCount(USER_A));
    }

    @Test
    void registrationRejectsADisabledUser() {
        jdbc.update("UPDATE users SET status = 'DISABLED' WHERE id = ?", UUID.fromString(USER_A));
        CountingEmitter emitter = new CountingEmitter();
        CpApiException refusal = assertThrows(CpApiException.class,
                () -> manager.registerForTest(USER_A, 0, emitter));
        assertEquals("UNAUTHENTICATED", refusal.getCode(), "disabled users cannot open the channel");
        assertEquals(0, manager.connectionCount(USER_A));
    }

    @Test
    void aStrongerSnapshotTransactionFailsClosedInsteadOfServingStaleState() {
        // The manager requires a current committed read: a caller holding a SERIALIZABLE
        // (stronger-than-READ_COMMITTED) transaction must not serve the channel from it.
        SingleConnectionDataSource pinned = new SingleConnectionDataSource();
        pinned.setUrl("jdbc:h2:mem:userchannel_pinned_" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1");
        pinned.setAutoCommit(false);
        try {
            JdbcTemplate pinnedJdbc = new JdbcTemplate(pinned);
            pinnedJdbc.execute("CREATE TABLE users (id UUID PRIMARY KEY, token_version INT NOT NULL, "
                    + "session_version INT NOT NULL, status VARCHAR(16) NOT NULL, deleted_at TIMESTAMP)");
            pinnedJdbc.update("INSERT INTO users VALUES (?, 0, 0, 'ACTIVE', NULL)", UUID.fromString(USER_A));
            pinnedJdbc.execute("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE");

            UserChannelSseManager pinnedManager = new UserChannelSseManager(pinnedJdbc);
            // The JDBC template translates the fail-closed SQLException into a data-access failure;
            // the important part is "no channel is opened", not the exact exception type.
            assertThrows(UncategorizedSQLException.class,
                    () -> pinnedManager.registerForTest(USER_A, 0, new CountingEmitter()),
                    "a non-READ_COMMITTED transaction must fail closed");
            assertEquals(0, pinnedManager.connectionCount(USER_A), "nothing was registered");
        } finally {
            pinned.destroy();
        }
    }

    @Test
    void concurrentRegistrationsNeverExceedThePerUserCap() throws Exception {
        int threads = UserChannelSseManager.MAX_SUBSCRIBERS_PER_USER * 2;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch start = new CountDownLatch(1);
        Map<Integer, String> outcomes = new ConcurrentHashMap<>();
        try {
            for (int index = 0; index < threads; index++) {
                final int id = index;
                pool.submit(() -> {
                    start.await();
                    try {
                        manager.registerForTest(USER_A, 0, new CountingEmitter());
                        outcomes.put(id, "ok");
                    } catch (CpApiException refusal) {
                        outcomes.put(id, refusal.getCode());
                    }
                    return null;
                });
            }
            start.countDown();
            pool.shutdown();
            assertTrue(pool.awaitTermination(30, TimeUnit.SECONDS), "the race must terminate");
        } finally {
            pool.shutdownNow();
        }

        long accepted = outcomes.values().stream().filter("ok"::equals).count();
        long refused = outcomes.values().stream().filter("USER_CHANNEL_FULL"::equals).count();
        assertEquals(UserChannelSseManager.MAX_SUBSCRIBERS_PER_USER, accepted,
                "exactly the cap is accepted, never more (compute() is the atomic linearization point)");
        assertEquals(threads - UserChannelSseManager.MAX_SUBSCRIBERS_PER_USER, refused,
                "every loser gets the explicit 429, never a silent drop or a lost connection");
        assertEquals(UserChannelSseManager.MAX_SUBSCRIBERS_PER_USER, manager.connectionCount(USER_A));
    }
}
