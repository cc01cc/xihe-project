package com.cc01cc.p.xihe.cp.context.repository;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import org.springframework.data.jpa.repository.JpaRepository;
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
     * PLAN-0660 T5.2 (BL-273): every {@code wake_dispatch} row of one session, in sequence order.
     *
     * <p>Deliberately a plain derived query — the JSON interpretation lives in Java, so the same code
     * runs on PostgreSQL and on H2. (The earlier native version used {@code payload->>'outcome'},
     * which H2 rejects with {@code SQL 42000}; mocked unit tests hid that. Rule: a new native query
     * needs a test that really executes it on the test database's dialect.)</p>
     */
    List<ContextEvent> findBySessionIdAndEventTypeOrderBySequenceAsc(String sessionId, String eventType);
}
