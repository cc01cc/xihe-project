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
     * PLAN-0660 T5.2: unread mentions for a whole roster in **one** statement — the derived
     * counterpart of the retired {@code session_participant_cursors.mention_count} column.
     *
     * <p>Rows: {@code [0] = participant id (UUID), [1] = notify count (Long)}. The pointer
     * ({@code last_read_event_seq}) is the only stored fact; the count is recomputed from
     * {@code wake_dispatch ∧ outcome=notify ∧ sequence > pointer}
     * ({@code spec/session/user-channel.md} §3, D66-07 / B-4).</p>
     */
    @Query(value = """
            SELECT c.participant_id AS participant_id, COUNT(e.id) AS notify_count
              FROM session_participant_cursors c
              JOIN session_participants p ON p.id = c.participant_id
              LEFT JOIN context_events e
                     ON e.session_id = p.session_id
                    AND e.event_type = 'wake_dispatch'
                    AND e.payload->>'outcome' = 'notify'
                    AND e.payload->>'participantId' = CAST(c.participant_id AS text)
                    AND e.sequence > c.last_read_event_seq
             WHERE p.session_id = CAST(:sessionId AS uuid)
             GROUP BY c.participant_id
            """, nativeQuery = true)
    List<Object[]> countDerivedMentionsBySession(@Param("sessionId") UUID sessionId);
}
