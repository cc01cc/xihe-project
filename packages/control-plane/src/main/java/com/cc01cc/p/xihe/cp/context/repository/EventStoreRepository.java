package com.cc01cc.p.xihe.cp.context.repository;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface EventStoreRepository extends JpaRepository<ContextEvent, UUID> {

    List<ContextEvent> findBySessionIdOrderBySequenceAsc(String sessionId);

    List<ContextEvent> findBySessionIdAndSequenceGreaterThanOrderBySequenceAsc(String sessionId, Long sequence);

    Optional<ContextEvent> findTopBySessionIdOrderBySequenceDesc(String sessionId);

    long countBySessionId(String sessionId);

    long deleteBySessionId(String sessionId);
}
