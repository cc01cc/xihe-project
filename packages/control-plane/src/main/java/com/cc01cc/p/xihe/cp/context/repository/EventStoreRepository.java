package com.cc01cc.p.xihe.cp.context.repository;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface EventStoreRepository extends JpaRepository<ContextEvent, UUID> {
    boolean existsBySessionId(String sessionId);

    /**
     * Existence probe for a native carrier. {@code session_id} is uuid on
     * PostgreSQL and varchar on the H2 test schema, and {@code payload} is
     * jsonb, so both sides are cast to text; the cast form works on both.
     */
    @Query(value = "SELECT EXISTS(SELECT 1 FROM context_events WHERE CAST(session_id AS VARCHAR) = :sessionId "
            + "AND event_type = :eventType AND CAST(payload AS VARCHAR) LIKE CONCAT('%', :fragment, '%'))",
            nativeQuery = true)
    boolean existsNativeCarrier(@Param("sessionId") String sessionId,
                                @Param("eventType") String eventType,
                                @Param("fragment") String fragment);

    List<ContextEvent> findBySessionIdOrderBySequenceAsc(String sessionId);

    List<ContextEvent> findBySessionIdAndSequenceGreaterThanOrderBySequenceAsc(String sessionId, Long sequence);

    Optional<ContextEvent> findTopBySessionIdOrderBySequenceDesc(String sessionId);

    long countBySessionId(String sessionId);

    long deleteBySessionId(String sessionId);
}
