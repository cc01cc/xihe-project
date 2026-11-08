package com.cc01cc.p.xihe.cp.context.repository;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface EventStoreRepository extends JpaRepository<ContextEvent, UUID> {
    boolean existsBySessionId(String sessionId);

    List<ContextEvent> findBySessionIdOrderBySequenceAsc(String sessionId);

    List<ContextEvent> findBySessionIdAndSequenceGreaterThanOrderBySequenceAsc(String sessionId, Long sequence);

    /**
     * PLAN-0572: tool-call snapshot source for one Run. Bounded by the Run's own
     * tool events; callers must not use this as a general purpose event reader.
     */
    List<ContextEvent> findBySessionIdAndCorrelationIdAndEventTypeInOrderByCreatedAtAscIdAsc(
            String sessionId, String correlationId, Collection<String> eventTypes);

    Optional<ContextEvent> findTopBySessionIdOrderBySequenceDesc(String sessionId);

    long countBySessionId(String sessionId);

    long deleteBySessionId(String sessionId);

    /**
     * PLAN-0670 M2b (T2b.2): the derived unread-mention aggregate, computed <b>in PostgreSQL</b>.
     *
     * <p>Before this query the roster loaded every {@code wake_dispatch} row of the session into Java
     * and aggregated there (BL-273's dialect-neutral fallback). At 20k events that made a 1.1 KB
     * response allocate ~74 MB of heap (measured: PLAN-0670 evidence {@code m2b-baseline.md}) — the
     * response was small but the <i>way</i> it was computed was wrong.</p>
     *
     * <p>Semantics are identical to the Java fallback: count {@code notify} rows whose
     * {@code sequence} is past that participant's pointer, only for participants that actually have a
     * cursor row, skipping payloads whose {@code participantId} is not a UUID (Java logged and skipped
     * those; {@code pg_input_is_valid} is the SQL equivalent, PostgreSQL 16+).</p>
     *
     * <p><b>Dialect rule (BL-273):</b> this is PostgreSQL-only syntax and MUST only run on PostgreSQL —
     * the H2 legacy unit lane keeps the Java fallback. Any change here needs the integration test that
     * really executes it against PostgreSQL
     * ({@code SessionParticipantUnreadAggregationIntegrationTest}).</p>
     */
    @Query(value = """
            SELECT CAST(ce.payload->>'participantId' AS UUID) AS participant_id, COUNT(*) AS unread
              FROM context_events ce
              JOIN session_participant_cursors c
                ON CAST(c.participant_id AS TEXT) = ce.payload->>'participantId'
             WHERE ce.session_id = CAST(:sessionId AS UUID)
               AND ce.event_type = 'wake_dispatch'
               AND ce.payload->>'outcome' = 'notify'
               AND pg_input_is_valid(ce.payload->>'participantId', 'uuid')
               AND ce.sequence > c.last_read_event_seq
             GROUP BY CAST(ce.payload->>'participantId' AS UUID)
            """, nativeQuery = true)
    List<Object[]> countUnreadMentionsByParticipant(@Param("sessionId") String sessionId);

    /**
     * PLAN-0660 T5.2 (BL-273): every {@code wake_dispatch} row of one session, in sequence order.
     *
     * <p>Deliberately a plain derived query — the JSON interpretation lives in Java, so the same code
     * runs on PostgreSQL and on H2. (The earlier native version used {@code payload->>'outcome'},
     * which H2 rejects with {@code SQL 42000}; mocked unit tests hid that. Rule: a new native query
     * needs a test that really executes it on the test database's dialect.)</p>
     */
    List<ContextEvent> findBySessionIdAndEventTypeOrderBySequenceAsc(String sessionId, String eventType);
}
