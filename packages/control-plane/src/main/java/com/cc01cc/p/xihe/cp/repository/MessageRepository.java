package com.cc01cc.p.xihe.cp.repository;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.UUID;
import com.cc01cc.p.xihe.cp.entity.Message;

import java.util.List;

public interface MessageRepository extends JpaRepository<Message, UUID> {
    boolean existsBySessionId(String sessionId);
    List<Message> findBySessionIdOrderByCreatedAtAsc(String sessionId);
    long deleteBySessionId(String sessionId);

    /** PLAN-0670 M2: newest page of one Session (newest-first; caller reverses for rendering). */
    @Query("SELECT m FROM Message m WHERE m.sessionId = :sessionId"
            + " ORDER BY m.createdAt DESC, m.id DESC")
    List<Message> findLatestPage(@Param("sessionId") String sessionId, Pageable pageable);

    /**
     * PLAN-0670 M2: strictly older than the composite {@code (createdAt, id)} cursor. The composite
     * key is mandatory — equal timestamps (batch writes in the same millisecond) would otherwise skip
     * or duplicate rows while paging.
     */
    @Query("SELECT m FROM Message m WHERE m.sessionId = :sessionId"
            + " AND (m.createdAt < :beforeCreatedAt"
            + " OR (m.createdAt = :beforeCreatedAt AND m.id < :beforeId))"
            + " ORDER BY m.createdAt DESC, m.id DESC")
    List<Message> findPageBefore(@Param("sessionId") String sessionId,
                                 @Param("beforeCreatedAt") Instant beforeCreatedAt,
                                 @Param("beforeId") UUID beforeId,
                                 Pageable pageable);

    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(value = "UPDATE messages SET run_id = NULL WHERE run_id IN "
            + "(SELECT id FROM chat_runs WHERE session_id = CAST(:sessionId AS UUID))",
            nativeQuery = true)
    int clearRunReferencesToSession(@Param("sessionId") String sessionId);
}
