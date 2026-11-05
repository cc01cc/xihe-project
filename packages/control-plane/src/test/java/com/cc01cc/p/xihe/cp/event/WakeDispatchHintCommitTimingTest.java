package com.cc01cc.p.xihe.cp.event;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.WakeDispatchService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0660 T5.5 (transaction-timing gap): the user-channel hint must follow the transaction, not
 * precede it.
 *
 * <p>Three states, each against a REAL transaction (H2, real repositories and audit — the timing is
 * what is under test, so mocks would prove nothing):</p>
 * <ol>
 *   <li><b>before commit</b> — inside the still-open transaction the hint has NOT been pushed
 *       (a receiver refreshing here reads the old unread count and must not be fooled by a push);</li>
 *   <li><b>after commit</b> — the same transaction commits and the hint is pushed exactly once,
 *       while the durable {@code wake_dispatch} audit row exists;</li>
 *   <li><b>rollback</b> — zero hints AND no durable audit row (a rolled-back notify must never
 *       reach the wire);</li>
 *   <li><b>post-commit push failure</b> — the business transaction still commits (the push is a
 *       hint, the durable record is the fact); the failure is logged, never retried.</li>
 * </ol>
 */
class WakeDispatchHintCommitTimingTest extends AbstractH2Test {

    @Autowired
    private WakeDispatchService wakeDispatchService;

    @Autowired
    private SessionParticipantRepository participants;

    @Autowired
    private SessionRepository sessions;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private PlatformTransactionManager transactionManager;

    private final List<String> pushedSessionIds = new CopyOnWriteArrayList<>();

    private UserChannelPort recordingPort() {
        return new UserChannelPort() {
            @Override
            public void participantNotified(String userId, String sessionId, String participantId) {
                pushedSessionIds.add(sessionId);
            }

            @Override
            public void questionChanged(String userId, String questionId, String sessionId, String state) {
                pushedSessionIds.add("question:" + questionId);
            }
        };
    }

    /**
     * Mirrors the production optional injection: the recording port replaces the SSE manager.
     * ReflectionTestUtils unwraps the @Transactional proxy — the field lives on the target, and
     * the afterCommit lambda captures the TARGET instance.
     */
    private WakeDispatchService serviceWithPort(UserChannelPort port) {
        org.springframework.test.util.ReflectionTestUtils.setField(
                wakeDispatchService, "userChannel", port);
        return wakeDispatchService;
    }

    private UUID seedHumanParticipant() {
        Session session = new Session();
        session.setId(UUID.randomUUID());
        session.setWorkspaceId(UUID.randomUUID().toString());
        session.setUserId(UUID.randomUUID().toString());
        session.setTitle("T5.5 hint timing");
        sessions.saveAndFlush(session);

        SessionParticipant human = new SessionParticipant(session.getId(),
                SessionParticipant.KIND_HUMAN, UUID.randomUUID(), SessionParticipant.ROLE_MEMBER,
                10, SessionParticipant.WAKE_MENTION, SessionParticipant.RESPOND_WHEN_MENTIONED);
        human.setPrincipalId(UUID.randomUUID());
        return participants.saveAndFlush(human).getId();
    }

    /** The durable wake_dispatch audit row lives in the event log (context_events), not audit_logs. */
    private long wakeDispatchAuditRows(UUID sessionId) {
        return jdbc.queryForObject(
                "SELECT count(*) FROM context_events WHERE session_id = ? AND event_type = 'wake_dispatch'",
                Long.class, sessionId.toString());
    }

    @Test
    void hintFollowsTheTransaction_commitPushesExactlyOnce() {
        UUID participantId = seedHumanParticipant();
        String sessionId = participants.findById(participantId).orElseThrow().getSessionId().toString();
        WakeDispatchService service = serviceWithPort(recordingPort());
        TransactionTemplate template = new TransactionTemplate(transactionManager);

        template.executeWithoutResult(status -> {
            WakeDispatchService.WakeFireResult result = service.fire(participantId,
                    "mention", "wake:mention:test", UUID.fromString(sessionId), null, null);
            assertTrue("notify".equals(result.outcome()),
                    "the HUMAN path returns notify: " + result.outcome());
            // INSIDE the transaction: the push must not have happened yet — the notify row is not
            // durable, so a receiver acting on a push here would read the OLD unread count.
            assertEquals(0, pushedSessionIds.size(),
                    "the hint must not precede the commit (T5.5 timing gap)");
        });

        assertEquals(List.of(sessionId), pushedSessionIds,
                "after commit the hint is pushed exactly once");
        assertEquals(1, wakeDispatchAuditRows(UUID.fromString(sessionId)),
                "the durable notify row exists — that is the fact the push merely hints at");
    }

    @Test
    void hintFollowsTheTransaction_rollbackPushesNothing() {
        UUID participantId = seedHumanParticipant();
        String sessionId = participants.findById(participantId).orElseThrow().getSessionId().toString();
        WakeDispatchService service = serviceWithPort(recordingPort());
        TransactionTemplate template = new TransactionTemplate(transactionManager);

        template.executeWithoutResult(status -> {
            service.fire(participantId, "mention", "wake:mention:test",
                    UUID.fromString(sessionId), null, null);
            status.setRollbackOnly();
        });

        assertEquals(0, pushedSessionIds.size(),
                "a rolled-back notify must never reach the user channel");
        assertEquals(0, wakeDispatchAuditRows(UUID.fromString(sessionId)),
                "the rollback really happened — no durable notify row exists either");
    }

    @Test
    void hintFollowsTheTransaction_afterCommitFailureDoesNotRollbackBusiness() {
        UUID participantId = seedHumanParticipant();
        String sessionId = participants.findById(participantId).orElseThrow().getSessionId().toString();
        WakeDispatchService service = serviceWithPort(new UserChannelPort() {
            @Override
            public void participantNotified(String userId, String pushedSession, String participantId) {
                throw new IllegalStateException("simulated push failure after commit");
            }

            @Override
            public void questionChanged(String userId, String questionId, String pushedSession, String state) {
                throw new IllegalStateException("simulated push failure after commit");
            }
        });
        TransactionTemplate template = new TransactionTemplate(transactionManager);

        // If the afterCommit push failure escaped, the exception would surface here and the test
        // would fail; it must not — a push is a hint, the durable record is the fact.
        template.executeWithoutResult(status ->
                service.fire(participantId, "mention", "wake:mention:test",
                        UUID.fromString(sessionId), null, null));

        assertEquals(0, pushedSessionIds.size(),
                "the failing push never delivered (failure is logged, not retried)");
        assertEquals(1, wakeDispatchAuditRows(UUID.fromString(sessionId)),
                "the business transaction committed despite the post-commit push failure");
    }
}
