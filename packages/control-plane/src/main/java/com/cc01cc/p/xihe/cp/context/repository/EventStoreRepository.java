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
}
